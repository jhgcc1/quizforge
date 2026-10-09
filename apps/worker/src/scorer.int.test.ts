import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { claimQuiz, completeQuiz, createDb, createQuizIdempotent, eq, migrate, schema, upsertSource } from "@quizforge/db";
import { createFakeLlm, type LlmClient } from "@quizforge/llm";
import { createLogger } from "./log.js";
import { processScoreJob, type ScoreDeps } from "./scorer.js";

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://quizforge:quizforge@localhost:5433/postgres";
const dbName = `qf_scr_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const url = new URL(ADMIN_URL);
url.pathname = `/${dbName}`;
let ctx: ReturnType<typeof createDb>;

const DOC = `# Zephyr Cache

Zephyr Cache is an in-memory key-value store written for edge servers with very little RAM.

## Eviction

When the arena is ninety percent full, Zephyr Cache starts evicting the least recently used entries first.
Entries marked pinned are never evicted, even when the arena is completely full.

## Persistence

Zephyr Cache writes a snapshot to disk every five minutes by default.
After a crash, the server loads the newest complete snapshot and ignores any partially written file.
`;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  await admin.end();
  ctx = createDb(url.toString(), { max: 4 });
  await migrate(ctx.db, { migrationsFolder: fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url)) });
});
afterAll(async () => {
  await ctx.pool.end();
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.end();
});

const metrics: Record<string, number>[] = [];
const deps = (over: Partial<ScoreDeps> = {}): ScoreDeps => ({
  db: ctx.db,
  judgeLlm: createFakeLlm(),
  judgeSamples: 3,
  pricing: { inPerM: 0.3, outPerM: 1.2 },
  log: createLogger("error"),
  emit: (m) => void metrics.push(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.value]))),
  ...over,
});

/** A quiz the generation worker has already saved as `ready`, with its fast scores, waiting to be judged. */
async function readyQuiz() {
  const quiz = (await createQuizIdempotent(ctx.db, { ownerSub: "o", sourceUrl: "u", numQuestions: 5, strategy: "single-shot", critique: false, idempotencyKey: randomUUID(), requestHash: "h" })).quiz;
  const claimed = await claimQuiz(ctx.db, quiz.id);
  if (!("job" in claimed)) throw new Error("claim failed");
  const sourceId = await upsertSource(ctx.db, { url: "u", rawUrl: "r", sha256: randomUUID(), text: DOC });
  const quotes = ["When the arena is ninety percent full", "Entries marked pinned are never evicted", "writes a snapshot to disk every five minutes", "loads the newest complete snapshot", "very little RAM"];
  await completeQuiz(ctx.db, {
    quizId: quiz.id, jobId: claimed.job.id, sourceId, strategyUsed: "single-shot",
    evals: [], // like the generation worker: it saves the quiz and no scores
    job: { model: "fake", promptTokens: 1000, completionTokens: 500, cachedTokens: 0, costUsd: 0.001, traceId: "trace-123" },
    questions: quotes.map((quote, i) => ({ prompt: `Question ${i + 1} about the Zephyr Cache documentation?`, options: ["right answer", "wrong one", "wrong two", "wrong three"], correct: [0], explanation: "Because the document says so.", sourceQuote: quote, difficulty: "medium" as const, type: "single" as const })),
  });
  return { quizId: quiz.id, jobId: claimed.job.id };
}
const evals = async (quizId: string) => Object.fromEntries((await ctx.db.select().from(schema.evalScores).where(eq(schema.evalScores.targetId, quizId))).map((e) => [e.evaluator, Number(e.value)]));
const job = async (id: string) => (await ctx.db.select().from(schema.generationJobs).where(eq(schema.generationJobs.id, id)))[0]!;

describe("processScoreJob (the scorer service)", () => {
  it("judges a saved quiz from Postgres alone: stores judge_* and quality_overall, marks the job scored, adds the judge's cost", async () => {
    const q = await readyQuiz();
    const before = await job(q.jobId);
    const out = await processScoreJob(deps(), { v: 1, ...q }, { count: 1, max: 3 });
    expect(out).toEqual({ kind: "done" });

    const e = await evals(q.quizId);
    expect(e).toMatchObject({ lint_pass: 1, grounded: 1 }); // the scorer also computes the fixed scores: the worker saved none
    expect(Object.keys(e)).toEqual(expect.arrayContaining(["grounded", "lint_pass", "question_diversity", "relevance", "language_match", "judge_overall", "judge_faithfulness", "judge_clarity", "judge_distractors", "quality_overall"]));
    expect(e.quality_overall).toBeGreaterThan(0);

    const after = await job(q.jobId);
    expect(after.scoredAt).not.toBeNull();
    expect(after.scoringAttempts).toBe(1);
    expect(after.promptTokens!).toBeGreaterThan(before.promptTokens!); // the judge's tokens are added to the job
    expect(Number(after.costUsd)).toBeGreaterThan(Number(before.costUsd));
    expect(metrics.at(-1)).toMatchObject({ JudgeFailed: 0, ScoringLatencyMs: expect.any(Number), QuizCostUsd: expect.any(Number) });
    expect(metrics.at(-1)!.QuizQuality).toBeCloseTo(e.quality_overall!, 3); // the DB keeps 4 decimals
  });

  it("is idempotent: a duplicate or redelivered message does not call the LLM or double the scores", async () => {
    const q = await readyQuiz();
    await processScoreJob(deps(), { v: 1, ...q }, { count: 1, max: 3 });
    let calls = 0;
    const spy: LlmClient = { model: "x", complete: async () => (calls++, Promise.reject(new Error("must not be called"))) };
    const out = await processScoreJob(deps({ judgeLlm: spy }), { v: 1, ...q }, { count: 2, max: 3 });
    expect(out).toEqual({ kind: "skipped", reason: "already scored" });
    expect(calls).toBe(0);
    const rows = await ctx.db.select().from(schema.evalScores).where(eq(schema.evalScores.targetId, q.quizId));
    expect(rows.filter((r) => r.evaluator === "quality_overall")).toHaveLength(1);
  });

  it("two scorers racing on the same message: ONE judges (the lease), the other skips; the judge is paid for once and there is one score", async () => {
    for (let round = 0; round < 5; round++) {
      const q = await readyQuiz();
      let judgeCalls = 0;
      const base = createFakeLlm();
      const counting: LlmClient = { model: "j", complete: async (m, o) => (judgeCalls++, new Promise((r) => setTimeout(r, 30)).then(() => base.complete(m, o))) };
      const [a, b] = await Promise.all([processScoreJob(deps({ judgeLlm: counting }), { v: 1, ...q }, { count: 1, max: 3 }), processScoreJob(deps({ judgeLlm: counting }), { v: 1, ...q }, { count: 1, max: 3 })]);
      expect([a.kind, b.kind].sort()).toEqual(["done", "skipped"]);
      expect(judgeCalls).toBe(3); // 3 samples of ONE scorer, not 6
      const rows = await ctx.db.select().from(schema.evalScores).where(eq(schema.evalScores.targetId, q.quizId));
      expect(rows.filter((r) => r.evaluator === "quality_overall")).toHaveLength(1);
      expect(rows.filter((r) => r.evaluator === "judge_overall")).toHaveLength(1);
    }
  });

  it("even if two writers do reach the database (lease expired, a re-score), the stored scores never double", async () => {
    const { saveScores } = await import("@quizforge/db");
    const q = await readyQuiz();
    const write = (v: number) => saveScores(ctx.db, { quizId: q.quizId, jobId: q.jobId, scores: [{ evaluator: "quality_overall", value: v }, { evaluator: "judge_overall", value: v }] });
    await Promise.all(Array.from({ length: 6 }, (_, i) => write(0.5 + i / 20)));
    const rows = await ctx.db.select().from(schema.evalScores).where(eq(schema.evalScores.targetId, q.quizId));
    expect(rows.filter((r) => r.evaluator === "quality_overall")).toHaveLength(1);
    expect(rows.filter((r) => r.evaluator === "judge_overall")).toHaveLength(1);
  });

  it("a retry after a judge failure can take the job again (the lease is released); a crashed scorer's lease only blocks until it expires", async () => {
    const { claimScoring, releaseScoring } = await import("@quizforge/db");
    const q = await readyQuiz();
    expect(await claimScoring(ctx.db, q.jobId)).toBe(1);
    expect(await claimScoring(ctx.db, q.jobId)).toBeUndefined(); // held
    await releaseScoring(ctx.db, q.jobId);
    expect(await claimScoring(ctx.db, q.jobId)).toBe(2); // free again, attempts counted
    await ctx.db.update(schema.generationJobs).set({ scoringClaimedUntil: new Date(Date.now() - 1000) }).where(eq(schema.generationJobs.id, q.jobId)); // the scorer died: its lease ran out
    expect(await claimScoring(ctx.db, q.jobId)).toBe(3);
  });

  it("skips what cannot be scored: unknown quiz, or a job that is not a finished one", async () => {
    expect(await processScoreJob(deps(), { v: 1, quizId: randomUUID(), jobId: randomUUID() }, { count: 1, max: 3 })).toEqual({ kind: "skipped", reason: "nothing to score" });
    const q = await readyQuiz();
    expect((await processScoreJob(deps(), { v: 1, quizId: q.quizId, jobId: randomUUID() }, { count: 1, max: 3 })).kind).toBe("skipped"); // wrong job id
  });

  it("when the judge fails: retry while attempts remain (nothing marked scored), then record judge_failed, mark scored and emit JudgeFailed", async () => {
    const q = await readyQuiz();
    const broken: LlmClient = { model: "broken", complete: async () => Promise.reject(new Error("MiniMax unavailable")) };
    const first = await processScoreJob(deps({ judgeLlm: broken }), { v: 1, ...q }, { count: 1, max: 3 });
    expect(first.kind).toBe("retry");
    expect((await job(q.jobId)).scoredAt).toBeNull();
    expect((await job(q.jobId)).scoringClaimedUntil).toBeNull(); // released, so the redelivery can take it
    expect(await evals(q.quizId)).not.toHaveProperty("quality_overall"); // never a different formula

    const last = await processScoreJob(deps({ judgeLlm: broken }), { v: 1, ...q }, { count: 3, max: 3 });
    expect(last.kind).toBe("failed");
    expect(await evals(q.quizId)).toMatchObject({ judge_failed: 1, lint_pass: expect.any(Number), grounded: expect.any(Number) }); // the fixed scores are kept
    expect(await evals(q.quizId)).not.toHaveProperty("quality_overall");
    expect((await job(q.jobId)).scoredAt).not.toBeNull(); // so the sweeper does not re-queue it forever
    expect(metrics.at(-1)).toMatchObject({ JudgeFailed: 1 });
  });

  it("a later re-score (the same quiz judged again after the claim is released) replaces values instead of adding rows", async () => {
    const { saveScores } = await import("@quizforge/db");
    const q = await readyQuiz();
    await saveScores(ctx.db, { quizId: q.quizId, jobId: q.jobId, scores: [{ evaluator: "quality_overall", value: 0.5 }] });
    await saveScores(ctx.db, { quizId: q.quizId, jobId: q.jobId, scores: [{ evaluator: "quality_overall", value: 0.9 }] });
    const rows = (await ctx.db.select().from(schema.evalScores).where(eq(schema.evalScores.targetId, q.quizId))).filter((r) => r.evaluator === "quality_overall");
    expect(rows.map((r) => Number(r.value))).toEqual([0.9]);
  });
});
