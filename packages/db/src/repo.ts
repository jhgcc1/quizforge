import { and, asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { computeFinalScore, scoreQuestion, SCORING_VERSION } from "@quizforge/core";
import type { Db } from "./index.js";
import * as t from "./schema.js";

export type QuizRow = typeof t.quizzes.$inferSelect;
export type AttemptRow = typeof t.attempts.$inferSelect;

const isUniqueViolation = (err: unknown) => (err as { code?: string; cause?: { code?: string } })?.code === "23505" || (err as { cause?: { code?: string } })?.cause?.code === "23505";

/* ------------------------------ quizzes (API side) ------------------------------ */

export interface CreateQuizInput {
  ownerSub: string;
  sourceUrl: string;
  topic?: string | undefined;
  numQuestions: number;
  strategy: string;
  critique: boolean;
  idempotencyKey: string;
  requestHash: string;
}

/** Insert-or-return: the unique (owner, key) constraint serializes concurrent identical requests. */
export async function createQuizIdempotent(db: Db, input: CreateQuizInput): Promise<{ quiz: QuizRow; created: boolean }> {
  const inserted = await db
    .insert(t.quizzes)
    .values({
      ownerSub: input.ownerSub,
      sourceUrl: input.sourceUrl,
      topic: input.topic ?? null,
      numQuestions: input.numQuestions,
      strategyRequested: input.strategy,
      critique: input.critique,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
    })
    .onConflictDoNothing({ target: [t.quizzes.ownerSub, t.quizzes.idempotencyKey] })
    .returning();
  if (inserted[0]) return { quiz: inserted[0], created: true };
  const [existing] = await db
    .select()
    .from(t.quizzes)
    .where(and(eq(t.quizzes.ownerSub, input.ownerSub), eq(t.quizzes.idempotencyKey, input.idempotencyKey)));
  return { quiz: existing!, created: false };
}

export async function countRecentQuizzes(db: Db, ownerSub: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(t.quizzes)
    .where(and(eq(t.quizzes.ownerSub, ownerSub), gte(t.quizzes.createdAt, since)));
  return row?.n ?? 0;
}

export async function listQuizzes(db: Db, ownerSub: string, limit = 50): Promise<QuizRow[]> {
  return db.select().from(t.quizzes).where(eq(t.quizzes.ownerSub, ownerSub)).orderBy(desc(t.quizzes.createdAt)).limit(limit);
}

export async function getOwnedQuiz(db: Db, quizId: string, ownerSub: string): Promise<QuizRow | undefined> {
  const [row] = await db.select().from(t.quizzes).where(and(eq(t.quizzes.id, quizId), eq(t.quizzes.ownerSub, ownerSub)));
  return row;
}

export interface PublicQuestion {
  id: string;
  position: number;
  prompt: string;
  type: "single" | "multiple";
  difficulty: "easy" | "medium" | "hard";
  options: { id: string; position: number; text: string }[];
}

/** Questions and options WITHOUT is_correct/explanation/quote: safe to show before submitting. */
export async function getPublicQuestions(db: Db, quizId: string): Promise<PublicQuestion[]> {
  const qs = await db.select().from(t.questions).where(eq(t.questions.quizId, quizId)).orderBy(asc(t.questions.position));
  if (qs.length === 0) return [];
  const opts = await db
    .select({ id: t.options.id, questionId: t.options.questionId, position: t.options.position, text: t.options.text })
    .from(t.options)
    .where(inArray(t.options.questionId, qs.map((q) => q.id)))
    .orderBy(asc(t.options.position));
  return qs.map((q) => ({
    id: q.id,
    position: q.position,
    prompt: q.prompt,
    type: q.type,
    difficulty: q.difficulty,
    options: opts.filter((o) => o.questionId === q.id).map(({ id, position, text }) => ({ id, position, text })),
  }));
}

/* ------------------------------ attempts / answers ------------------------------ */

export interface CreateAttemptInput {
  quizId: string;
  userSub: string;
  idempotencyKey: string;
  requestHash: string;
}

/**
 * Same Idempotency-Key => same attempt. No key match but an in-progress attempt exists for this
 * user and quiz (partial unique index) => that attempt is returned instead of a second one.
 */
export async function getOrCreateAttempt(db: Db, input: CreateAttemptInput): Promise<{ attempt: AttemptRow; created: boolean }> {
  const byKey = async () =>
    (await db.select().from(t.attempts).where(and(eq(t.attempts.userSub, input.userSub), eq(t.attempts.idempotencyKey, input.idempotencyKey))))[0];
  const active = async () =>
    (await db
      .select()
      .from(t.attempts)
      .where(and(eq(t.attempts.quizId, input.quizId), eq(t.attempts.userSub, input.userSub), eq(t.attempts.status, "in_progress"))))[0];

  const existing = (await byKey()) ?? (await active());
  if (existing) return { attempt: existing, created: false };
  try {
    const [row] = await db.insert(t.attempts).values(input).returning();
    return { attempt: row!, created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = (await byKey()) ?? (await active());
    if (!raced) throw err;
    return { attempt: raced, created: false };
  }
}

export async function getOwnedAttempt(db: Db, attemptId: string, userSub: string): Promise<AttemptRow | undefined> {
  const [row] = await db.select().from(t.attempts).where(and(eq(t.attempts.id, attemptId), eq(t.attempts.userSub, userSub)));
  return row;
}

export type SaveAnswerResult =
  | { status: "applied" }
  | { status: "stale" }
  | { status: "not_found" }
  | { status: "attempt_submitted" }
  | { status: "invalid"; reason: string };

/** Persist one answer the moment it is given. Older `revision`s (delayed retries) are ignored. */
export async function saveAnswer(
  db: Db,
  p: { attemptId: string; userSub: string; questionId: string; optionIds: string[]; revision: number },
): Promise<SaveAnswerResult> {
  return db.transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(t.attempts)
      .where(and(eq(t.attempts.id, p.attemptId), eq(t.attempts.userSub, p.userSub)))
      .for("share");
    if (!attempt) return { status: "not_found" } as const;
    if (attempt.status === "submitted") return { status: "attempt_submitted" } as const;

    const [question] = await tx.select().from(t.questions).where(and(eq(t.questions.id, p.questionId), eq(t.questions.quizId, attempt.quizId)));
    if (!question) return { status: "not_found" } as const;

    const unique = [...new Set(p.optionIds)];
    const valid = await tx.select({ id: t.options.id }).from(t.options).where(and(eq(t.options.questionId, question.id), inArray(t.options.id, unique)));
    if (valid.length !== unique.length) return { status: "invalid", reason: "option does not belong to this question" } as const;
    if (unique.length === 0) return { status: "invalid", reason: "select at least one option" } as const;
    if (question.type === "single" && unique.length !== 1) return { status: "invalid", reason: "this question accepts exactly one option" } as const;

    const [row] = await tx
      .insert(t.answers)
      .values({ attemptId: attempt.id, questionId: question.id, revision: p.revision })
      .onConflictDoUpdate({
        target: [t.answers.attemptId, t.answers.questionId],
        set: { revision: p.revision, answeredAt: sql`now()` },
        setWhere: sql`${t.answers.revision} < ${p.revision}`,
      })
      .returning({ id: t.answers.id });
    if (!row) return { status: "stale" } as const;

    await tx.delete(t.answerSelections).where(eq(t.answerSelections.answerId, row.id));
    await tx.insert(t.answerSelections).values(unique.map((optionId) => ({ answerId: row.id, optionId })));
    return { status: "applied" } as const;
  });
}

export interface AttemptResult {
  attemptId: string;
  quizId: string;
  status: "in_progress" | "submitted";
  finalScore: number | null;
  percent: number | null;
  scoringVersion: number;
  submittedAt: Date | null;
  questions: {
    id: string;
    position: number;
    prompt: string;
    type: "single" | "multiple";
    explanation: string;
    sourceQuote: string;
    score: number | null;
    weight: number | null;
    options: { id: string; position: number; text: string; isCorrect: boolean; selected: boolean }[];
  }[];
}

/** Full breakdown including the answer key. Only call for submitted attempts. */
export async function getAttemptResult(db: Db, attemptId: string, userSub: string): Promise<AttemptResult | undefined> {
  const attempt = await getOwnedAttempt(db, attemptId, userSub);
  if (!attempt) return undefined;
  const qs = await db.select().from(t.questions).where(eq(t.questions.quizId, attempt.quizId)).orderBy(asc(t.questions.position));
  const opts = qs.length
    ? await db.select().from(t.options).where(inArray(t.options.questionId, qs.map((q) => q.id))).orderBy(asc(t.options.position))
    : [];
  const ans = await db.select().from(t.answers).where(eq(t.answers.attemptId, attempt.id));
  const sels = ans.length
    ? await db.select().from(t.answerSelections).where(inArray(t.answerSelections.answerId, ans.map((a) => a.id)))
    : [];
  const final = attempt.finalScore === null ? null : Number(attempt.finalScore);
  return {
    attemptId: attempt.id,
    quizId: attempt.quizId,
    status: attempt.status,
    finalScore: final,
    percent: final === null ? null : (final / 4) * 100,
    scoringVersion: attempt.scoringVersion,
    submittedAt: attempt.submittedAt,
    questions: qs.map((q) => {
      const a = ans.find((x) => x.questionId === q.id);
      const selected = new Set(sels.filter((s) => s.answerId === a?.id).map((s) => s.optionId));
      return {
        id: q.id,
        position: q.position,
        prompt: q.prompt,
        type: q.type,
        explanation: q.explanation,
        sourceQuote: q.sourceQuote,
        score: a?.score == null ? null : Number(a.score),
        weight: a?.weight == null ? null : Number(a.weight),
        options: opts
          .filter((o) => o.questionId === q.id)
          .map((o) => ({ id: o.id, position: o.position, text: o.text, isCorrect: o.isCorrect, selected: selected.has(o.id) })),
      };
    }),
  };
}

export type SubmitResult = { status: "not_found" } | { status: "ok"; replayed: boolean; result: AttemptResult };

/**
 * One-shot transition in_progress -> submitted. The score is computed from what is stored in the
 * database (never from the request), so replays and concurrent submits return the same result.
 */
export async function submitAttempt(db: Db, p: { attemptId: string; userSub: string }): Promise<SubmitResult> {
  const replayed = await db.transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(t.attempts)
      .where(and(eq(t.attempts.id, p.attemptId), eq(t.attempts.userSub, p.userSub)))
      .for("update");
    if (!attempt) return undefined;
    if (attempt.status === "submitted") return true;

    const qs = await tx.select().from(t.questions).where(eq(t.questions.quizId, attempt.quizId)).orderBy(asc(t.questions.position));
    const opts = await tx.select().from(t.options).where(inArray(t.options.questionId, qs.map((q) => q.id)));
    const existing = await tx.select().from(t.answers).where(eq(t.answers.attemptId, attempt.id));
    const sels = existing.length
      ? await tx.select().from(t.answerSelections).where(inArray(t.answerSelections.answerId, existing.map((a) => a.id)))
      : [];

    const perQuestion = qs.map((q) => {
      const correct = opts.filter((o) => o.questionId === q.id && o.isCorrect).map((o) => o.id);
      const a = existing.find((x) => x.questionId === q.id);
      const selected = sels.filter((s) => s.answerId === a?.id).map((s) => s.optionId);
      return { q, a, score: scoreQuestion(correct, selected) };
    });
    const { score: finalScore, weights } = computeFinalScore(perQuestion.map((x) => x.score));

    for (const [i, x] of perQuestion.entries()) {
      const values = { score: x.score.toFixed(5), weight: weights[i]!.toFixed(6) };
      if (x.a) await tx.update(t.answers).set(values).where(eq(t.answers.id, x.a.id));
      else await tx.insert(t.answers).values({ attemptId: attempt.id, questionId: x.q.id, ...values }); // unanswered = 0
    }
    await tx
      .update(t.attempts)
      .set({ status: "submitted", submittedAt: new Date(), finalScore: finalScore.toFixed(5), scoringVersion: SCORING_VERSION })
      .where(and(eq(t.attempts.id, attempt.id), eq(t.attempts.status, "in_progress")));
    return false;
  });
  if (replayed === undefined) return { status: "not_found" };
  const result = (await getAttemptResult(db, p.attemptId, p.userSub))!;
  return { status: "ok", replayed, result };
}

/* ------------------------------ generation (worker side) ------------------------------ */

export async function claimQuiz(
  db: Db,
  quizId: string,
): Promise<{ skip: "missing" | "ready" | "failed" } | { quiz: QuizRow; job: typeof t.generationJobs.$inferSelect }> {
  return db.transaction(async (tx) => {
    const [quiz] = await tx.select().from(t.quizzes).where(eq(t.quizzes.id, quizId)).for("update");
    if (!quiz) return { skip: "missing" } as const;
    if (quiz.status === "ready" || quiz.status === "failed") return { skip: quiz.status } as const;
    const [updated] = await tx.update(t.quizzes).set({ status: "generating", updatedAt: new Date() }).where(eq(t.quizzes.id, quizId)).returning();
    const jobs = await tx.select().from(t.generationJobs).where(eq(t.generationJobs.quizId, quizId)).orderBy(desc(t.generationJobs.attemptNo));
    const running = jobs.find((j) => j.status === "running");
    const job =
      running ??
      (await tx.insert(t.generationJobs).values({ quizId, attemptNo: (jobs[0]?.attemptNo ?? 0) + 1 }).returning())[0]!;
    return { quiz: updated!, job };
  });
}

export async function saveJobBudget(db: Db, jobId: string, budgetState: unknown): Promise<void> {
  await db.update(t.generationJobs).set({ budgetState }).where(eq(t.generationJobs.id, jobId));
}

export async function upsertSource(
  db: Db,
  s: { url: string; rawUrl: string; sha256: string; text: string },
): Promise<string> {
  const [row] = await db
    .insert(t.sources)
    .values({ url: s.url, rawUrl: s.rawUrl, contentSha256: s.sha256, contentText: s.text })
    .onConflictDoUpdate({ target: t.sources.contentSha256, set: { fetchedAt: new Date() } })
    .returning({ id: t.sources.id });
  return row!.id;
}

export interface CompleteQuizInput {
  quizId: string;
  jobId: string;
  sourceId: string;
  strategyUsed: string;
  language?: string | undefined;
  questions: {
    prompt: string;
    options: string[];
    correct: number[];
    explanation: string;
    sourceQuote: string;
    difficulty: "easy" | "medium" | "hard";
    type: "single" | "multiple";
  }[];
  job: { model: string; promptTokens: number; completionTokens: number; cachedTokens: number; costUsd: number; traceId?: string | undefined };
  evals: { evaluator: string; value: number; reasoning?: string | undefined }[];
}

/** Replace-all in one transaction, so re-running a redelivered job never leaves a half-written quiz. */
export async function completeQuiz(db: Db, p: CompleteQuizInput): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(t.questions).where(eq(t.questions.quizId, p.quizId));
    for (const [i, q] of p.questions.entries()) {
      const [row] = await tx
        .insert(t.questions)
        .values({ quizId: p.quizId, position: i + 1, prompt: q.prompt, type: q.type, explanation: q.explanation, sourceQuote: q.sourceQuote, difficulty: q.difficulty })
        .returning({ id: t.questions.id });
      await tx.insert(t.options).values(q.options.map((text, j) => ({ questionId: row!.id, position: j + 1, text, isCorrect: q.correct.includes(j) })));
    }
    await tx
      .update(t.quizzes)
      .set({ status: "ready", numQuestions: p.questions.length, sourceId: p.sourceId, strategyUsed: p.strategyUsed, language: p.language ?? null, error: null, updatedAt: new Date() })
      .where(eq(t.quizzes.id, p.quizId));
    await tx
      .update(t.generationJobs)
      .set({
        status: "succeeded",
        model: p.job.model,
        promptTokens: p.job.promptTokens,
        completionTokens: p.job.completionTokens,
        cachedTokens: p.job.cachedTokens,
        costUsd: p.job.costUsd.toFixed(6),
        langfuseTraceId: p.job.traceId ?? null,
        finishedAt: new Date(),
      })
      .where(eq(t.generationJobs.id, p.jobId));
    if (p.evals.length) {
      await tx.insert(t.evalScores).values(
        p.evals.map((e) => ({ targetType: "quiz" as const, targetId: p.quizId, evaluator: e.evaluator, value: e.value.toFixed(4), reasoning: e.reasoning ?? null })),
      );
    }
  });
}

export async function failQuiz(db: Db, p: { quizId: string; jobId?: string | undefined; error: string }): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(t.quizzes).set({ status: "failed", error: p.error.slice(0, 1000), updatedAt: new Date() }).where(eq(t.quizzes.id, p.quizId));
    if (p.jobId) {
      await tx.update(t.generationJobs).set({ status: "failed", error: p.error.slice(0, 1000), finishedAt: new Date() }).where(eq(t.generationJobs.id, p.jobId));
    }
  });
}

/** Sweeper helpers: quizzes stuck in queued/generating are re-queued or failed by a scheduled task. */
export async function findStaleQuizzes(db: Db, olderThan: Date): Promise<Pick<QuizRow, "id" | "status" | "updatedAt">[]> {
  return db
    .select({ id: t.quizzes.id, status: t.quizzes.status, updatedAt: t.quizzes.updatedAt })
    .from(t.quizzes)
    .where(and(inArray(t.quizzes.status, ["queued", "generating"]), sql`${t.quizzes.updatedAt} < ${olderThan}`));
}

export async function findQuizByKey(db: Db, ownerSub: string, idempotencyKey: string): Promise<QuizRow | undefined> {
  const [row] = await db.select().from(t.quizzes).where(and(eq(t.quizzes.ownerSub, ownerSub), eq(t.quizzes.idempotencyKey, idempotencyKey)));
  return row;
}

export async function findAttemptByKey(db: Db, userSub: string, idempotencyKey: string): Promise<AttemptRow | undefined> {
  const [row] = await db.select().from(t.attempts).where(and(eq(t.attempts.userSub, userSub), eq(t.attempts.idempotencyKey, idempotencyKey)));
  return row;
}

/** Saved selections for an in-progress attempt (lets the UI restore state after a reload). No answer key. */
export async function getAttemptProgress(
  db: Db,
  attemptId: string,
  userSub: string,
): Promise<{ attempt: AttemptRow; answers: { questionId: string; optionIds: string[]; revision: number }[] } | undefined> {
  const attempt = await getOwnedAttempt(db, attemptId, userSub);
  if (!attempt) return undefined;
  const ans = await db.select().from(t.answers).where(eq(t.answers.attemptId, attempt.id));
  const sels = ans.length ? await db.select().from(t.answerSelections).where(inArray(t.answerSelections.answerId, ans.map((a) => a.id))) : [];
  return {
    attempt,
    answers: ans.map((a) => ({ questionId: a.questionId, revision: a.revision, optionIds: sels.filter((s) => s.answerId === a.id).map((s) => s.optionId) })),
  };
}

/* ------------------------------ scoring (the scorer service) ------------------------------ */

export interface QuizForScoring {
  quizId: string;
  jobId: string;
  traceId: string | null;
  ownerSub: string;
  scored: boolean;
  attempts: number;
  sourceText: string;
  /** In the shape the quality scorer takes (same as the generator produced). */
  questions: {
    prompt: string;
    options: string[];
    correct: number[];
    explanation: string;
    sourceQuote: string;
    difficulty: "easy" | "medium" | "hard";
    type: "single" | "multiple";
  }[];
}

/**
 * Everything the scorer needs, from Postgres alone: the saved questions, the source document and the Langfuse trace of the
 * generation. `undefined` = nothing to score (the quiz is gone, not ready, or the job is not a finished one).
 */
export async function getQuizForScoring(db: Db, quizId: string, jobId: string): Promise<QuizForScoring | undefined> {
  const [row] = await db
    .select({ quiz: t.quizzes, job: t.generationJobs, source: t.sources.contentText })
    .from(t.generationJobs)
    .innerJoin(t.quizzes, eq(t.quizzes.id, t.generationJobs.quizId))
    .leftJoin(t.sources, eq(t.sources.id, t.quizzes.sourceId))
    .where(and(eq(t.generationJobs.id, jobId), eq(t.generationJobs.quizId, quizId)));
  if (!row || row.quiz.status !== "ready" || row.job.status !== "succeeded" || row.source == null) return undefined;
  const qs = await db.select().from(t.questions).where(eq(t.questions.quizId, quizId)).orderBy(asc(t.questions.position));
  if (qs.length === 0) return undefined;
  const opts = await db.select().from(t.options).where(inArray(t.options.questionId, qs.map((q) => q.id))).orderBy(asc(t.options.position));
  return {
    quizId,
    jobId,
    traceId: row.job.langfuseTraceId,
    ownerSub: row.quiz.ownerSub,
    scored: row.job.scoredAt !== null,
    attempts: row.job.scoringAttempts,
    sourceText: row.source,
    questions: qs.map((q) => {
      const own = opts.filter((o) => o.questionId === q.id);
      return {
        prompt: q.prompt,
        options: own.map((o) => o.text),
        correct: own.flatMap((o, i) => (o.isCorrect ? [i] : [])),
        explanation: q.explanation,
        sourceQuote: q.sourceQuote,
        difficulty: q.difficulty,
        type: q.type,
      };
    }),
  };
}

/** How long one scorer owns a job. Shorter than the queue's visibility timeout (180 s), so a dead scorer's message is not blocked by its own lease. */
export const SCORING_LEASE_SECONDS = 150;

/**
 * Take the job for scoring: counts one attempt (bounds the sweeper) and holds a lease, so two scorers that got the same message
 * do not both pay for the judge. Returns the new attempt count, or `undefined` when the job is already scored or another scorer holds it.
 */
export async function claimScoring(db: Db, jobId: string): Promise<number | undefined> {
  const [row] = await db
    .update(t.generationJobs)
    .set({ scoringAttempts: sql`${t.generationJobs.scoringAttempts} + 1`, scoringClaimedUntil: sql`now() + make_interval(secs => ${SCORING_LEASE_SECONDS})` })
    .where(and(eq(t.generationJobs.id, jobId), sql`${t.generationJobs.scoredAt} is null`, sql`(${t.generationJobs.scoringClaimedUntil} is null or ${t.generationJobs.scoringClaimedUntil} < now())`))
    .returning({ attempts: t.generationJobs.scoringAttempts });
  return row?.attempts;
}

/** Give the job back (the judge failed and the message will be retried): without this the retry would wait for the lease to expire. */
export async function releaseScoring(db: Db, jobId: string): Promise<void> {
  await db.update(t.generationJobs).set({ scoringClaimedUntil: null }).where(eq(t.generationJobs.id, jobId));
}

export interface SaveScoresInput {
  quizId: string;
  jobId: string;
  scores: { evaluator: string; value: number; reasoning?: string | undefined; meta?: Record<string, unknown> | undefined }[];
  /** What the judge cost: added to the job's totals (the generation worker no longer includes the judge). */
  usage?: { promptTokens: number; completionTokens: number; cachedTokens: number; costUsd: number } | undefined;
}

/**
 * Idempotent: replaces the stored value of every evaluator named in `scores` (so a re-score, or a second scorer that
 * got the same message, ends in the same state), and marks the job as scored, in one transaction.
 */
export async function saveScores(db: Db, p: SaveScoresInput): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialize every writer of this job's scores: with the lock a second transaction waits, then replaces, so rows never double
    // (the lease prevents double JUDGING; this guarantees the stored result even if two writers do get here).
    await tx.select({ id: t.generationJobs.id }).from(t.generationJobs).where(eq(t.generationJobs.id, p.jobId)).for("update");
    if (p.scores.length) {
      await tx.delete(t.evalScores).where(and(eq(t.evalScores.targetType, "quiz"), eq(t.evalScores.targetId, p.quizId), inArray(t.evalScores.evaluator, p.scores.map((s) => s.evaluator))));
      await tx.insert(t.evalScores).values(
        p.scores.map((s) => ({ targetType: "quiz" as const, targetId: p.quizId, evaluator: s.evaluator, value: s.value.toFixed(4), reasoning: s.reasoning ?? null, meta: s.meta ?? null })),
      );
    }
    await tx
      .update(t.generationJobs)
      .set({
        scoredAt: new Date(),
        scoringClaimedUntil: null,
        ...(p.usage
          ? {
              promptTokens: sql`coalesce(${t.generationJobs.promptTokens}, 0) + ${p.usage.promptTokens}`,
              completionTokens: sql`coalesce(${t.generationJobs.completionTokens}, 0) + ${p.usage.completionTokens}`,
              cachedTokens: sql`coalesce(${t.generationJobs.cachedTokens}, 0) + ${p.usage.cachedTokens}`,
              costUsd: sql`coalesce(${t.generationJobs.costUsd}, 0) + ${p.usage.costUsd.toFixed(6)}`,
            }
          : {}),
      })
      .where(eq(t.generationJobs.id, p.jobId));
  });
}

/** Finished quizzes that never got their final scores (a lost message, a scorer that died): the sweeper re-queues them. */
export async function findUnscoredJobs(db: Db, finishedBefore: Date, maxAttempts: number): Promise<{ quizId: string; jobId: string }[]> {
  return db
    .select({ quizId: t.generationJobs.quizId, jobId: t.generationJobs.id })
    .from(t.generationJobs)
    .innerJoin(t.quizzes, eq(t.quizzes.id, t.generationJobs.quizId))
    .where(
      and(
        eq(t.generationJobs.status, "succeeded"),
        eq(t.quizzes.status, "ready"),
        sql`${t.generationJobs.scoredAt} is null`,
        sql`${t.generationJobs.finishedAt} < ${finishedBefore}`,
        sql`${t.generationJobs.scoringAttempts} < ${maxAttempts}`,
      ),
    )
    .limit(100);
}
