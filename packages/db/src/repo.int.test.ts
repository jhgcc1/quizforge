import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { computeFinalScore } from "@quizforge/core";
import {
  claimQuiz,
  completeQuiz,
  countRecentQuizzes,
  createDb,
  createQuizIdempotent,
  failQuiz,
  getAttemptResult,
  getOrCreateAttempt,
  getPublicQuestions,
  saveAnswer,
  submitAttempt,
  upsertSource,
} from "./index.js";

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://quizforge:quizforge@localhost:5433/postgres";
const dbName = `qf_repo_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const url = new URL(ADMIN_URL);
url.pathname = `/${dbName}`;
let ctx: ReturnType<typeof createDb>;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  await admin.end();
  ctx = createDb(url.toString(), { max: 8 });
  await migrate(ctx.db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
});
afterAll(async () => {
  await ctx.pool.end();
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.end();
});

const mkQuestions = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    prompt: `Question number ${i + 1} about the document?`,
    options: ["right", "wrong 1", "wrong 2", "wrong 3"],
    correct: i === 1 ? [0, 1] : [0], // question 2 is multi-answer
    explanation: "Because the document says so.",
    sourceQuote: "the document says so",
    difficulty: "medium" as const,
    type: (i === 1 ? "multiple" : "single") as "single" | "multiple",
  }));

async function readyQuiz(owner = "alice", n = 5) {
  const { quiz } = await createQuizIdempotent(ctx.db, {
    ownerSub: owner, sourceUrl: "https://github.com/o/r/blob/main/README.md", numQuestions: n,
    strategy: "auto", critique: true, idempotencyKey: randomUUID(), requestHash: "h",
  });
  const claimed = await claimQuiz(ctx.db, quiz.id);
  if (!("job" in claimed)) throw new Error("expected claim");
  const sourceId = await upsertSource(ctx.db, { url: "u", rawUrl: "r", sha256: randomUUID(), text: "text" });
  await completeQuiz(ctx.db, {
    quizId: quiz.id, jobId: claimed.job.id, sourceId, strategyUsed: "single-shot", questions: mkQuestions(n),
    job: { model: "fake", promptTokens: 10, completionTokens: 5, cachedTokens: 0, costUsd: 0.001 }, evals: [{ evaluator: "quality_overall", value: 0.8 }],
  });
  const questions = await getPublicQuestions(ctx.db, quiz.id);
  return { quiz, questions };
}

describe("quiz creation idempotency", () => {
  it("same (owner, key) returns the same quiz; another owner gets its own", async () => {
    const base = { sourceUrl: "u", numQuestions: 6, strategy: "auto", critique: true, idempotencyKey: randomUUID(), requestHash: "h" };
    const a = await createQuizIdempotent(ctx.db, { ...base, ownerSub: "alice" });
    const b = await createQuizIdempotent(ctx.db, { ...base, ownerSub: "alice" });
    const c = await createQuizIdempotent(ctx.db, { ...base, ownerSub: "bob" });
    expect([a.created, b.created, c.created]).toEqual([true, false, true]);
    expect(b.quiz.id).toBe(a.quiz.id);
    expect(c.quiz.id).not.toBe(a.quiz.id);
  });

  it("20 concurrent identical requests create exactly one quiz", async () => {
    const base = { ownerSub: "carol", sourceUrl: "u", numQuestions: 5, strategy: "auto", critique: true, idempotencyKey: randomUUID(), requestHash: "h" };
    const results = await Promise.all(Array.from({ length: 20 }, () => createQuizIdempotent(ctx.db, base)));
    expect(new Set(results.map((r) => r.quiz.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it("counts recent quizzes per owner for the daily quota", async () => {
    await createQuizIdempotent(ctx.db, { ownerSub: "quota-user", sourceUrl: "u", numQuestions: 5, strategy: "auto", critique: true, idempotencyKey: randomUUID(), requestHash: "h" });
    expect(await countRecentQuizzes(ctx.db, "quota-user", new Date(Date.now() - 86_400_000))).toBe(1);
    expect(await countRecentQuizzes(ctx.db, "nobody", new Date(Date.now() - 86_400_000))).toBe(0);
  });
});

describe("generation (worker) idempotency", () => {
  it("claim moves queued->generating, reuses the running job, and skips finished quizzes", async () => {
    const { quiz } = await createQuizIdempotent(ctx.db, { ownerSub: "w", sourceUrl: "u", numQuestions: 5, strategy: "auto", critique: true, idempotencyKey: randomUUID(), requestHash: "h" });
    const first = await claimQuiz(ctx.db, quiz.id);
    const again = await claimQuiz(ctx.db, quiz.id); // SQS redelivery
    if (!("job" in first) || !("job" in again)) throw new Error("expected jobs");
    expect(again.job.id).toBe(first.job.id);
    expect(again.quiz.status).toBe("generating");
    const sourceId = await upsertSource(ctx.db, { url: "u", rawUrl: "r", sha256: randomUUID(), text: "t" });
    await completeQuiz(ctx.db, { quizId: quiz.id, jobId: first.job.id, sourceId, strategyUsed: "single-shot", questions: mkQuestions(5), job: { model: "m", promptTokens: 1, completionTokens: 1, cachedTokens: 0, costUsd: 0 }, evals: [] });
    expect(await claimQuiz(ctx.db, quiz.id)).toEqual({ skip: "ready" });
    expect(await claimQuiz(ctx.db, randomUUID())).toEqual({ skip: "missing" });
  });

  it("re-running completeQuiz replaces questions instead of duplicating them", async () => {
    const { quiz, questions } = await readyQuiz("rerun");
    expect(questions).toHaveLength(5);
    const sourceId = await upsertSource(ctx.db, { url: "u", rawUrl: "r", sha256: randomUUID(), text: "t" });
    await completeQuiz(ctx.db, { quizId: quiz.id, jobId: randomUUID() as never, sourceId, strategyUsed: "x", questions: mkQuestions(6), job: { model: "m", promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0 }, evals: [] });
    expect(await getPublicQuestions(ctx.db, quiz.id)).toHaveLength(6);
  });

  it("failQuiz records the error and the answer key never leaks into public questions", async () => {
    const { quiz, questions } = await readyQuiz("leak");
    expect(JSON.stringify(questions)).not.toMatch(/isCorrect|is_correct|explanation|sourceQuote/);
    const { quiz: q2 } = await createQuizIdempotent(ctx.db, { ownerSub: "f", sourceUrl: "u", numQuestions: 5, strategy: "auto", critique: true, idempotencyKey: randomUUID(), requestHash: "h" });
    await failQuiz(ctx.db, { quizId: q2.id, error: "budget exceeded" });
    expect(await claimQuiz(ctx.db, q2.id)).toEqual({ skip: "failed" });
    expect(quiz.id).not.toBe(q2.id);
  });
});

describe("attempts, answers and scoring", () => {
  it("attempt creation is idempotent by key and by 'one active attempt'", async () => {
    const { quiz } = await readyQuiz("att");
    const key = randomUUID();
    const a = await getOrCreateAttempt(ctx.db, { quizId: quiz.id, userSub: "u1", idempotencyKey: key, requestHash: "h" });
    const b = await getOrCreateAttempt(ctx.db, { quizId: quiz.id, userSub: "u1", idempotencyKey: key, requestHash: "h" });
    const c = await getOrCreateAttempt(ctx.db, { quizId: quiz.id, userSub: "u1", idempotencyKey: randomUUID(), requestHash: "h" });
    expect([a.created, b.created, c.created]).toEqual([true, false, false]);
    expect(new Set([a.attempt.id, b.attempt.id, c.attempt.id]).size).toBe(1);
    const racers = await Promise.all(Array.from({ length: 10 }, () => getOrCreateAttempt(ctx.db, { quizId: quiz.id, userSub: "u2", idempotencyKey: randomUUID(), requestHash: "h" })));
    expect(new Set(racers.map((r) => r.attempt.id)).size).toBe(1);
  });

  it("saves answers immediately, ignores stale revisions, and validates options", async () => {
    const { quiz, questions } = await readyQuiz("ans");
    const { attempt } = await getOrCreateAttempt(ctx.db, { quizId: quiz.id, userSub: "u", idempotencyKey: randomUUID(), requestHash: "h" });
    const q1 = questions[0]!;
    const opt = (i: number) => q1.options[i]!.id;
    const save = (optionIds: string[], revision: number, userSub = "u", questionId = q1.id) =>
      saveAnswer(ctx.db, { attemptId: attempt.id, userSub, questionId, optionIds, revision });

    expect(await save([opt(1)], 1)).toEqual({ status: "applied" });
    expect(await save([opt(0)], 3)).toEqual({ status: "applied" }); // user changed their mind
    expect(await save([opt(1)], 2)).toEqual({ status: "stale" }); // delayed retry of the old click
    expect(await save([opt(0)], 3)).toEqual({ status: "stale" }); // exact replay is a no-op
    expect(await save([opt(0), opt(1)], 4)).toMatchObject({ status: "invalid" }); // single => one option
    expect(await save([randomUUID()], 5)).toMatchObject({ status: "invalid" });
    expect(await save([], 6)).toMatchObject({ status: "invalid" });
    expect(await save([opt(0)], 9, "someone-else")).toEqual({ status: "not_found" });
    expect(await save([opt(0)], 9, "u", randomUUID())).toEqual({ status: "not_found" });

    const r = await getAttemptResult(ctx.db, attempt.id, "u");
    expect(r!.questions[0]!.options.filter((o) => o.selected).map((o) => o.id)).toEqual([opt(0)]);
  });

  it("submit computes the weighted score from stored answers, treats blanks as 0, and is replay-safe", async () => {
    const { quiz, questions } = await readyQuiz("sub");
    const { attempt } = await getOrCreateAttempt(ctx.db, { quizId: quiz.id, userSub: "u", idempotencyKey: randomUUID(), requestHash: "h" });
    const correctOf = (qi: number) => (qi === 1 ? [0, 1] : [0]).map((i) => questions[qi]!.options[i]!.id);
    // q1 right, q2 half right (1 of 2 correct), q3 wrong, q4 right, q5 unanswered
    await saveAnswer(ctx.db, { attemptId: attempt.id, userSub: "u", questionId: questions[0]!.id, optionIds: correctOf(0), revision: 1 });
    await saveAnswer(ctx.db, { attemptId: attempt.id, userSub: "u", questionId: questions[1]!.id, optionIds: [questions[1]!.options[0]!.id], revision: 1 });
    await saveAnswer(ctx.db, { attemptId: attempt.id, userSub: "u", questionId: questions[2]!.id, optionIds: [questions[2]!.options[3]!.id], revision: 1 });
    await saveAnswer(ctx.db, { attemptId: attempt.id, userSub: "u", questionId: questions[3]!.id, optionIds: correctOf(3), revision: 1 });

    const expected = computeFinalScore([4, 2, 0, 4, 0]).score;
    const first = await submitAttempt(ctx.db, { attemptId: attempt.id, userSub: "u" });
    if (first.status !== "ok") throw new Error("submit failed");
    expect(first.replayed).toBe(false);
    expect(first.result.finalScore).toBeCloseTo(expected, 4);
    expect(first.result.questions.map((q) => q.score)).toEqual([4, 2, 0, 4, 0]);
    expect(first.result.questions[4]!.weight).toBeCloseTo(1.1 ** 4, 5);

    const second = await submitAttempt(ctx.db, { attemptId: attempt.id, userSub: "u" });
    if (second.status !== "ok") throw new Error("replay failed");
    expect(second.replayed).toBe(true);
    expect(second.result.finalScore).toBe(first.result.finalScore);

    // can't change an answer after submitting
    expect(await saveAnswer(ctx.db, { attemptId: attempt.id, userSub: "u", questionId: questions[2]!.id, optionIds: correctOf(2), revision: 99 })).toEqual({ status: "attempt_submitted" });
    expect(await submitAttempt(ctx.db, { attemptId: attempt.id, userSub: "intruder" })).toEqual({ status: "not_found" });
  });

  it("20 concurrent submits yield one stored result and no duplicate answer rows", async () => {
    const { quiz, questions } = await readyQuiz("conc");
    const { attempt } = await getOrCreateAttempt(ctx.db, { quizId: quiz.id, userSub: "u", idempotencyKey: randomUUID(), requestHash: "h" });
    await saveAnswer(ctx.db, { attemptId: attempt.id, userSub: "u", questionId: questions[0]!.id, optionIds: [questions[0]!.options[0]!.id], revision: 1 });
    const results = await Promise.all(Array.from({ length: 20 }, () => submitAttempt(ctx.db, { attemptId: attempt.id, userSub: "u" })));
    const oks = results.filter((r) => r.status === "ok");
    expect(oks).toHaveLength(20);
    expect(oks.filter((r) => r.status === "ok" && !r.replayed)).toHaveLength(1);
    expect(new Set(oks.map((r) => r.status === "ok" && r.result.finalScore)).size).toBe(1);
    const final = await getAttemptResult(ctx.db, attempt.id, "u");
    expect(final!.questions.every((q) => q.score !== null)).toBe(true);
  });
});
