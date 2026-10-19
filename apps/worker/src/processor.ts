import { createHash } from "node:crypto";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { titleForDocument, type QuizJobMessage, type ScoreJobMessage } from "@quizforge/core";
import { claimQuiz, completeQuiz, failQuiz, isApprovedDocument, listSource, saveJobBudget, setQuizPhase, storedSource, unlistSourceByUrl, upsertSource, type Db } from "@quizforge/db";
import {
  BudgetExceededError,
  NonRetryableError,
  QualityGateError,
  StructuredOutputError,
  SourceError,
  NotTextError,
  UnsafeDocumentError,
  UnsafeOutputError,
  UnsupportedLanguageError,
  admitDocument,
  progressFor,
  screenWithDetector,
  fetchMarkdown as defaultFetch,
  generateQuiz as defaultGenerate,
  type DetectorMode,
  type InjectionDetector,
  type LlmClient,
  type SupportedLanguage,
} from "@quizforge/llm";
import { emitMetrics, type Logger } from "./log.js";
import { createProgressReporter } from "./progress.js";

export type Outcome =
  | { kind: "done" }
  | { kind: "skipped"; reason: string }
  /** Permanent failure, recorded on the quiz: the SQS message should be deleted. */
  | { kind: "failed"; error: string }
  /** Transient failure with attempts left: leave the message so SQS redelivers it. */
  | { kind: "retry"; error: string }
  /** Last allowed attempt failed: quiz marked failed; leave the message so it lands in the DLQ (alarm). */
  | { kind: "exhausted"; error: string };

export interface ProcessDeps {
  db: Db;
  llm: LlmClient;
  /**
   * Hands the finished quiz to the scorer service (the judge runs there, off the path of this job). Optional: without it the
   * quiz is simply not scored. A failure to enqueue never fails the job: the sweeper re-queues unscored quizzes.
   */
  publishScore?: ((msg: ScoreJobMessage) => Promise<void>) | undefined;
  allowedHosts: string[];
  /** Languages a document may be written in; any other is rejected before the model is called. Default: en, pt, es. */
  allowedLanguages?: readonly SupportedLanguage[] | undefined;
  /** Optional semantic classifier (Llama Prompt Guard 2, multilingual) and what to do with its verdict. Default: not used. */
  detector?: InjectionDetector | undefined;
  detectorMode?: DetectorMode | undefined;
  /** In block mode, the score from which a document is rejected (see screenWithDetector). */
  detectorBlockAt?: number | undefined;
  pricing: { inPerM: number; outPerM: number };
  log: Logger;
  checkpointer?: BaseCheckpointSaver | undefined;
  fetchMarkdown?: typeof defaultFetch;
  generateQuiz?: typeof defaultGenerate;
  emit?: typeof emitMetrics;
}

/** Source errors that retrying cannot fix (bad URL, blocked host, too big...). A flaky fetch is retryable. */
const PERMANENT_SOURCE = new Set(["invalid_url", "host_not_allowed", "blocked_address", "too_large", "not_text", "empty"]);
const isPermanent = (err: unknown) =>
  err instanceof NonRetryableError || err instanceof BudgetExceededError || (err instanceof SourceError && PERMANENT_SOURCE.has(err.code));

const hashSub = (sub: string) => createHash("sha256").update(sub).digest("hex").slice(0, 16);

/**
 * Process one queue message. Idempotent: the quiz row is the source of truth, so a duplicate or
 * redelivered message is either skipped (already finished) or resumes the same job and checkpoint.
 */
export async function processQuizJob(
  d: ProcessDeps,
  msg: QuizJobMessage,
  receive: { count: number; max: number },
): Promise<Outcome> {
  const log = d.log.child({ quizId: msg.quizId, requestId: msg.requestId, receiveCount: receive.count });
  const emit = d.emit ?? emitMetrics;
  const started = Date.now();

  const claim = await claimQuiz(d.db, msg.quizId);
  if ("skip" in claim) {
    log.info({ reason: claim.skip }, "skipping message");
    return { kind: "skipped", reason: claim.skip };
  }
  const { quiz, job } = claim;
  let budgetSnapshot: unknown = job.budgetState ?? undefined;

  const threadId = `quiz-${quiz.id}-job-${job.id}`;
  // The phase the user sees (best effort: a failed write is logged and dropped, see progress.ts).
  const progress = createProgressReporter((p) => setQuizPhase(d.db, quiz.id, p), log);
  const plan = { critique: quiz.critique, planFirst: false, revised: false };
  progress.report(progressFor("reading_document", plan));
  try {
    // A document read once is kept, so a second quiz on it costs no download: the stored copy is the same sanitized
    // text the previous quiz was built from. `refresh` on the quiz asks for the current version instead, which is
    // what somebody wants when the document changed upstream. Either way the guards below run on the text in hand.
    const fetchSource = d.fetchMarkdown ?? defaultFetch;
    const cached = quiz.refresh ? undefined : await storedSource(d.db, [quiz.sourceUrl]).catch(() => undefined);
    if (cached) {
      log.info({ sha256: cached.sha256 }, "using the stored copy of the document (no fetch)");
      emit({ DocumentFromStore: { value: 1, unit: "Count" } });
    }
    const src = cached ?? (await fetchSource(quiz.sourceUrl, { allowedHosts: d.allowedHosts }));
    // Door 1: reject hidden/encoded text and unsupported languages BEFORE anything is stored or sent to a model.
    // From here on only the sanitized text is used, and the scorer reads the same text back from Postgres.
    const doc = admitDocument(src.text, d.allowedLanguages ? { allowedLanguages: d.allowedLanguages } : {});
    const flagged = doc.findings.filter((f) => f.severity === "flag");
    if (flagged.length) {
      log.warn({ findings: flagged.map((f) => ({ kind: f.kind, detail: f.detail })) }, "the document contains instructions aimed at a model (kept as data)");
      emit({ InjectionFlagged: { value: 1, unit: "Count" } });
    }
    // Optional second opinion from a classifier model (multilingual; skipped for a language the model does not declare). Never throws.
    const screened = await screenWithDetector(doc.text, doc.language, d.detector, d.detectorMode ?? "off", d.detectorBlockAt).catch((err: unknown) => {
      log.error({ err }, "semantic detector failed; continuing without it");
      emit({ DetectorFailed: { value: 1, unit: "Count" } });
      return undefined;
    });
    // A document an admin approved after review is never refused again by the classifier: the review exists precisely
    // because the classifier is wrong often enough on real READMEs. Everything else stays on — the finding is still
    // recorded, the metric still fires, and the output rails still go strict below. Approval says "this is not an
    // attack", not "trust whatever it says".
    if (screened && screened.status !== "skipped") {
      emit({ DetectorMs: { value: screened.result.ms, unit: "Milliseconds" } });
      if (screened.status === "flagged" || screened.status === "blocked") {
        log.warn({ detector: d.detector?.name, score: screened.result.score }, "the semantic detector flags this document");
        emit({ InjectionDetected: { value: 1, unit: "Count" } });
        if (screened.status === "blocked") {
          const approved = await isApprovedDocument(d.db, [quiz.sourceUrl, src.rawUrl]);
          // The excerpt travels with the error because a reviewer needs the EVIDENCE, not the verdict: the document
          // request is built from this string, and "scored 1.00" tells nobody what the classifier reacted to.
          if (!approved) throw new UnsafeDocumentError(screened.result.excerpt ? `${screened.finding.detail} — excerpt: ${screened.result.excerpt}` : screened.finding.detail);
          log.warn({ score: screened.result.score }, "the classifier would block this document, but a reviewer approved it");
          emit({ ApprovedDocumentAllowed: { value: 1, unit: "Count" } });
        }
      }
    }
    // A flag from the classifier puts the output rails in strict link mode (like a keyword finding does): see packages/llm/src/output-guard.ts
    const flaggedExcerpts = screened && (screened.status === "flagged" || screened.status === "blocked") ? [screened.result.excerpt ?? ""] : undefined;
    const sourceId = await upsertSource(d.db, { url: quiz.sourceUrl, rawUrl: src.rawUrl, sha256: src.sha256, text: doc.text });

    const gen = d.generateQuiz ?? defaultGenerate;
    const result = await gen({
      llm: d.llm,
      input: {
        sourceText: doc.text,
        numQuestions: quiz.numQuestions,
        topic: quiz.topic ?? undefined,
        strategy: quiz.strategyRequested as "auto" | "single-shot" | "section-map-reduce",
        critique: quiz.critique,
        ...(flaggedExcerpts ? { flaggedExcerpts } : {}),
      },
      ...(job.budgetState ? { budgetState: job.budgetState as never } : {}),
      score: false, // every score (fixed checks and judge) is computed by the scorer service, after the quiz is already saved
      trace: { sessionId: quiz.id, userId: hashSub(quiz.ownerSub), ...(msg.requestId ? { requestId: msg.requestId } : {}) },
      threadId,
      ...(d.checkpointer ? { checkpointer: d.checkpointer } : {}),
      onProgress: progress.report,
    });
    budgetSnapshot = result.budget;
    progress.report(progressFor("saving", { ...plan, revised: result.rounds > 0 }));
    await progress.flush();

    const costUsd = (result.usage.promptTokens * d.pricing.inPerM + result.usage.completionTokens * d.pricing.outPerM) / 1e6;
    await completeQuiz(d.db, {
      quizId: quiz.id,
      jobId: job.id,
      sourceId,
      strategyUsed: result.strategy,
      questions: result.questions,
      job: {
        model: result.model,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        cachedTokens: result.usage.cachedTokens,
        costUsd,
        traceId: result.traceId,
      },
      evals: [], // scores come later, from the scorer service
    });
    await saveJobBudget(d.db, job.id, result.budget);

    // The document worked: put it in the shared catalogue so nobody has to paste the URL again. Only a document no
    // guard had anything to say about — a flagged one still generates for whoever chose it, but it is not something to
    // suggest to everybody. A failure here must never fail a quiz that is already saved.
    if (!flagged.length && !flaggedExcerpts) {
      await listSource(d.db, { sourceId, title: titleForDocument(doc.text, quiz.sourceUrl), language: doc.language })
        .catch((err: unknown) => log.warn({ err }, "could not add the document to the catalogue"));
    }

    // The quiz is saved: the checkpoints have done their job (resuming an interrupted run), so they go now instead of piling up.
    await d.checkpointer?.deleteThread(threadId).catch((e: unknown) => log.warn({ err: e }, "could not delete checkpoint thread"));

    // The quiz is READY now. Scoring is a separate job: the user does not wait for the judge.
    if (d.publishScore) {
      try {
        await d.publishScore({ v: 1, quizId: quiz.id, jobId: job.id, ...(msg.requestId ? { requestId: msg.requestId } : {}) });
      } catch (err) {
        log.warn({ err, traceId: result.traceId }, "score job not queued; the sweeper will queue it");
        emit({ ScoreJobNotQueued: { value: 1, unit: "Count" } });
      }
    }

    const ms = Date.now() - started;
    log.info({ strategy: result.strategy, rounds: result.rounds, repairs: result.repairs, resumed: result.resumed, qualityVersion: result.qualityVersion, costUsd, ms, traceId: result.traceId }, "quiz generated");
    emit({
      JobSucceeded: { value: 1, unit: "Count" },
      GenerationLatencyMs: { value: ms, unit: "Milliseconds" },
      QuizCostUsd: { value: costUsd },
      PromptTokens: { value: result.usage.promptTokens, unit: "Count" },
      CompletionTokens: { value: result.usage.completionTokens, unit: "Count" },
      CritiqueRounds: { value: result.rounds, unit: "Count" },
      OutputRepairs: { value: result.repairs, unit: "Count" },
    });
    return { kind: "done" };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await progress.flush(); // a late phase write must not land after the failure is recorded (it is also guarded by status = generating)
    if (budgetSnapshot) await saveJobBudget(d.db, job.id, budgetSnapshot).catch(() => undefined);
    const permanent = isPermanent(err);
    // A content failure (the model produced something unusable) is not an infrastructure hiccup: resuming from its
    // checkpoint would just replay the same dead end. Drop the thread so the next delivery regenerates from scratch.
    if (err instanceof QualityGateError || err instanceof StructuredOutputError || err instanceof UnsafeOutputError) {
      await d.checkpointer?.deleteThread(threadId).catch((e: unknown) => log.warn({ err: e }, "could not delete checkpoint thread"));
    }
    const exhausted = receive.count >= receive.max;
    log.error({ err, permanent, exhausted }, "quiz generation failed");
    // A rejected document is the guard doing its job (and a user typo is not an outage): it has its own metric and does not feed the job-failure alarm.
    const rejected = err instanceof UnsafeDocumentError || err instanceof UnsupportedLanguageError || err instanceof NotTextError;
    if (rejected) {
      emit({ DocumentRejected: { value: 1, unit: "Count" } });
      // A README that was in the catalogue can be edited and start being refused. Leaving the entry there would hand
      // every user a suggestion that fails for them, so it comes out of the list; the document can earn its way back
      // in the moment it generates cleanly again.
      await unlistSourceByUrl(d.db, [quiz.sourceUrl]).catch((e: unknown) => log.warn({ err: e }, "could not remove the document from the catalogue"));
    } else emit({ JobFailed: { value: 1, unit: "Count" }, JobPermanentFailure: { value: permanent ? 1 : 0, unit: "Count" } });

    if (permanent || exhausted) {
      await failQuiz(d.db, { quizId: quiz.id, jobId: job.id, error: message });
      return permanent ? { kind: "failed", error: message } : { kind: "exhausted", error: message };
    }
    return { kind: "retry", error: message };
  }
}
