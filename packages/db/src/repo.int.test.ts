import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { computeFinalScore } from "@quizforge/core";
import {
  approvedCatalogEntries,
  claimQuiz,
  completeQuiz,
  countRecentQuizzes,
  createDb,
  createDocumentRequest,
  createQuizIdempotent,
  isApprovedDocument,
  listSource,
  listedCatalogEntries,
  reviewDocumentRequest,
  unlistSourceByUrl,
  upsertSource,
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

  it("getAttemptResult on a quiz that has no questions yet returns an empty breakdown", async () => {
    const { quiz } = await createQuizIdempotent(ctx.db, {
      ownerSub: "empty", sourceUrl: "https://github.com/o/r/blob/main/README.md", numQuestions: 5,
      strategy: "auto", critique: true, idempotencyKey: randomUUID(), requestHash: "h",
    });
    const { attempt } = await getOrCreateAttempt(ctx.db, { quizId: quiz.id, userSub: "empty", idempotencyKey: randomUUID(), requestHash: "h" });
    expect((await getAttemptResult(ctx.db, attempt.id, "empty"))!.questions).toEqual([]);
  });

  it("getAttemptResult on an attempt with no answers lists every question with nothing selected", async () => {
    const { quiz, questions } = await readyQuiz("noans");
    const { attempt } = await getOrCreateAttempt(ctx.db, { quizId: quiz.id, userSub: "u", idempotencyKey: randomUUID(), requestHash: "h" });
    const r = await getAttemptResult(ctx.db, attempt.id, "u");
    expect(r!.questions).toHaveLength(questions.length);
    expect(r!.questions.every((q) => q.options.every((o) => !o.selected))).toBe(true);
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

describe("attempts with no answers", () => {
  it("shows an unanswered attempt as unscored, and submitting it scores every question 0", async () => {
    const { quiz, questions } = await readyQuiz("blank");
    const { attempt } = await getOrCreateAttempt(ctx.db, { quizId: quiz.id, userSub: "u", idempotencyKey: randomUUID(), requestHash: "h" });
    const before = await getAttemptResult(ctx.db, attempt.id, "u");
    expect(before!.finalScore).toBeNull();
    expect(before!.questions).toHaveLength(questions.length);
    expect(before!.questions.every((q) => q.options.every((o) => !o.selected))).toBe(true);
    expect(await getAttemptResult(ctx.db, attempt.id, "someone-else")).toBeUndefined();

    const done = await submitAttempt(ctx.db, { attemptId: attempt.id, userSub: "u" });
    if (done.status !== "ok") throw new Error("submit failed");
    expect(done.result.finalScore).toBe(0);
    expect(done.result.questions.map((q) => q.score)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("the catalogue entries a document earns by being used", () => {
  const put = async (name: string, chars: number, language = "en") => {
    const url = `https://github.com/o/${name}/blob/main/README.md`;
    const id = await upsertSource(ctx.db, { url, rawUrl: url, sha256: randomUUID().replace(/-/g, "").padEnd(64, "0"), text: "x".repeat(chars) });
    await listSource(ctx.db, { sourceId: id, title: name, language });
    return url;
  };

  it("reports the size from the document length, and the language it was admitted as", async () => {
    await put("tiny", 100);
    await put("middling", 10_000, "pt");
    await put("enormous", 30_000, "es");
    const by = Object.fromEntries((await listedCatalogEntries(ctx.db)).map((e) => [e.title, e]));
    expect(by.tiny!.size).toBe("short");
    expect(by.middling!.size).toBe("medium");
    expect(by.enormous!.size).toBe("long");
    expect([by.tiny!.language, by.middling!.language, by.enormous!.language]).toEqual(["en", "pt", "es"]);
    expect(by.tiny!.kind).toBe("used");
    expect(by.tiny!.tests).toMatch(/^First used on \d{4}-\d{2}-\d{2}$/);
  });

  it("falls back to English for a language the catalogue does not offer", async () => {
    const url = await put("mystery", 100, "de");
    expect((await listedCatalogEntries(ctx.db)).find((e) => e.url === url)!.language).toBe("en");
  });

  it("lists nothing for a source that was never listed, and listing twice keeps the first date", async () => {
    const url = "https://github.com/o/quiet/blob/main/README.md";
    const id = await upsertSource(ctx.db, { url, rawUrl: url, sha256: randomUUID().replace(/-/g, "").padEnd(64, "0"), text: "x".repeat(50) });
    expect((await listedCatalogEntries(ctx.db)).map((e) => e.url)).not.toContain(url);
    await listSource(ctx.db, { sourceId: id, title: "First", language: "en" });
    const first = (await listedCatalogEntries(ctx.db)).find((e) => e.url === url)!;
    await listSource(ctx.db, { sourceId: id, title: "Second", language: "en" });
    expect((await listedCatalogEntries(ctx.db)).find((e) => e.url === url)!.title).toBe(first.title);
  });

  it("unlisting an empty list of urls, or an unknown one, does nothing and does not throw", async () => {
    const before = (await listedCatalogEntries(ctx.db)).length;
    await unlistSourceByUrl(ctx.db, []);
    await unlistSourceByUrl(ctx.db, [""]);
    await unlistSourceByUrl(ctx.db, ["https://github.com/o/never-seen/blob/main/R.md"]);
    expect((await listedCatalogEntries(ctx.db)).length).toBe(before);
  });

  it("the limit is honoured", async () => {
    await put("one-of-two", 100);
    await put("two-of-two", 100);
    expect(await listedCatalogEntries(ctx.db, 1)).toHaveLength(1);
  });
});

describe("approval lookups with nothing to look up", () => {
  it("an empty or blank list of urls is not approved, without hitting the database", async () => {
    expect(await isApprovedDocument(ctx.db, [])).toBe(false);
    expect(await isApprovedDocument(ctx.db, ["", ""])).toBe(false);
  });

  it("an approved request with no score and no review date still renders a catalogue entry", async () => {
    const url = "https://github.com/o/bare/blob/main/README.md";
    const req = await createDocumentRequest(ctx.db, { url, title: "Bare request", requestedBy: "u" });
    await reviewDocumentRequest(ctx.db, { id: req!.id, action: "approve", reviewedBy: "admin" });
    const entry = (await approvedCatalogEntries(ctx.db)).find((e) => e.url === url)!;
    expect(entry.kind).toBe("approved");
    expect(entry.tests).toMatch(/Let in by review on \d{4}-\d{2}-\d{2}$/); // no score clause when there is no score
  });
});
