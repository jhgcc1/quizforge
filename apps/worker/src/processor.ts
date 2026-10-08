import { createHash } from "node:crypto";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { QuizJobMessage } from "@quizforge/core";
import { claimQuiz, completeQuiz, failQuiz, saveJobBudget, upsertSource, type Db } from "@quizforge/db";
import {
  BudgetExceededError,
  NonRetryableError,
  QualityGateError,
  StructuredOutputError,
  SourceError,
  fetchMarkdown as defaultFetch,
  generateQuiz as defaultGenerate,
  type LlmClient,
} from "@quizforge/llm";
import { emitMetrics, type Logger } from "./log.js";

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
  judgeLlm?: LlmClient | undefined;
  /** Judge samples per quiz (median). Same value as the CI evaluation, so production and CI scores are comparable. */
  judgeSamples?: number | undefined;
  allowedHosts: string[];
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
  try {
    const fetchSource = d.fetchMarkdown ?? defaultFetch;
    const src = await fetchSource(quiz.sourceUrl, { allowedHosts: d.allowedHosts });
    const sourceId = await upsertSource(d.db, { url: quiz.sourceUrl, rawUrl: src.rawUrl, sha256: src.sha256, text: src.text });

    const gen = d.generateQuiz ?? defaultGenerate;
    const result = await gen({
      llm: d.llm,
      ...(d.judgeLlm ? { judgeLlm: d.judgeLlm } : {}),
      ...(d.judgeSamples ? { judgeSamples: d.judgeSamples } : {}),
      input: {
        sourceText: src.text,
        numQuestions: quiz.numQuestions,
        topic: quiz.topic ?? undefined,
        strategy: quiz.strategyRequested as "auto" | "single-shot" | "section-map-reduce",
        critique: quiz.critique,
      },
      ...(job.budgetState ? { budgetState: job.budgetState as never } : {}),
      judge: true,
      trace: { sessionId: quiz.id, userId: hashSub(quiz.ownerSub), ...(msg.requestId ? { requestId: msg.requestId } : {}) },
      threadId,
      ...(d.checkpointer ? { checkpointer: d.checkpointer } : {}),
    });
    budgetSnapshot = result.budget;

    const costUsd = (result.usage.promptTokens * d.pricing.inPerM + result.usage.completionTokens * d.pricing.outPerM) / 1e6;
    // Every metric of the shared quality method is stored under the same name it has in Langfuse.
    const evals = [
      ...Object.entries(result.scores).map(([evaluator, value]) => ({ evaluator, value, ...(evaluator === "judge_overall" && result.judge ? { reasoning: result.judge.scores.reasoning } : {}) })),
      ...(result.quality !== undefined ? [{ evaluator: "quality_overall", value: result.quality }] : []),
    ];
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
      evals,
    });
    await saveJobBudget(d.db, job.id, result.budget);

    const ms = Date.now() - started;
    log.info({ strategy: result.strategy, rounds: result.rounds, repairs: result.repairs, resumed: result.resumed, quality: result.quality, judgeFailed: result.judgeFailed, qualityVersion: result.qualityVersion, costUsd, ms, traceId: result.traceId }, "quiz generated");
    if (result.judgeFailed) log.warn({ traceId: result.traceId }, "judge failed twice: quiz delivered without a quality score");
    emit({
      JobSucceeded: { value: 1, unit: "Count" },
      GenerationLatencyMs: { value: ms, unit: "Milliseconds" },
      // only when the judge ran: a quiz without a judge score must not drag the average with a different formula
      ...(result.quality !== undefined ? { QuizQuality: { value: result.quality } } : {}),
      JudgeFailed: { value: result.judgeFailed ? 1 : 0, unit: "Count" },
      QuizCostUsd: { value: costUsd },
      PromptTokens: { value: result.usage.promptTokens, unit: "Count" },
      CompletionTokens: { value: result.usage.completionTokens, unit: "Count" },
      CritiqueRounds: { value: result.rounds, unit: "Count" },
      OutputRepairs: { value: result.repairs, unit: "Count" },
    });
    return { kind: "done" };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (budgetSnapshot) await saveJobBudget(d.db, job.id, budgetSnapshot).catch(() => undefined);
    const permanent = isPermanent(err);
    // A content failure (the model produced something unusable) is not an infrastructure hiccup: resuming from its
    // checkpoint would just replay the same dead end. Drop the thread so the next delivery regenerates from scratch.
    if (err instanceof QualityGateError || err instanceof StructuredOutputError) {
      await d.checkpointer?.deleteThread(threadId).catch((e: unknown) => log.warn({ err: e }, "could not delete checkpoint thread"));
    }
    const exhausted = receive.count >= receive.max;
    log.error({ err, permanent, exhausted }, "quiz generation failed");
    emit({ JobFailed: { value: 1, unit: "Count" }, JobPermanentFailure: { value: permanent ? 1 : 0, unit: "Count" } });

    if (permanent || exhausted) {
      await failQuiz(d.db, { quizId: quiz.id, jobId: job.id, error: message });
      return permanent ? { kind: "failed", error: message } : { kind: "exhausted", error: message };
    }
    return { kind: "retry", error: message };
  }
}
