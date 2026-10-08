import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { MemorySaver } from "@langchain/langgraph";
import { createDb, createQuizIdempotent, eq, getPublicQuestions, migrate, schema } from "@quizforge/db";
import { JobBudget, SourceError, createFakeLlm, type LlmClient } from "@quizforge/llm";
import { createLogger } from "./log.js";
import { processQuizJob, type ProcessDeps } from "./processor.js";

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://quizforge:quizforge@localhost:5433/postgres";
const dbName = `qf_wrk_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const dbUrl = new URL(ADMIN_URL);
dbUrl.pathname = `/${dbName}`;
let ctx: ReturnType<typeof createDb>;

const DOC = Array.from({ length: 14 }, (_, i) => `Pipecat component number ${i + 1} handles one specific part of the real time voice pipeline well.`).join("\n\n");
const okFetch = async (url: string) => ({ url, rawUrl: url, text: DOC, sha256: randomUUID().replace(/-/g, "").padEnd(64, "0") });

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  await admin.end();
  ctx = createDb(dbUrl.toString(), { max: 6 });
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
const deps = (over: Partial<ProcessDeps> = {}): ProcessDeps => ({
  db: ctx.db,
  llm: createFakeLlm(),
  allowedHosts: ["github.com"],
  pricing: { inPerM: 0.3, outPerM: 1.2 },
  log: createLogger("error"),
  fetchMarkdown: okFetch as never,
  emit: (m) => void metrics.push(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.value]))),
  ...over,
});
const newQuiz = async (over: Record<string, unknown> = {}) =>
  (await createQuizIdempotent(ctx.db, { ownerSub: "owner", sourceUrl: "https://github.com/o/r/blob/main/README.md", numQuestions: 6, strategy: "single-shot", critique: true, idempotencyKey: randomUUID(), requestHash: "h", ...over })).quiz;
const status = async (id: string) => (await ctx.db.select().from(schema.quizzes).where(eq(schema.quizzes.id, id)))[0]!;

describe("processQuizJob", () => {
  it("generates, persists questions/options/job/eval scores and emits metrics", async () => {
    const quiz = await newQuiz();
    const out = await processQuizJob(deps(), { v: 1, quizId: quiz.id, requestId: "req-1" }, { count: 1, max: 3 });
    expect(out).toEqual({ kind: "done" });

    const row = await status(quiz.id);
    expect(row).toMatchObject({ status: "ready", strategyUsed: "single-shot", error: null });
    const qs = await getPublicQuestions(ctx.db, quiz.id);
    expect(qs).toHaveLength(6);
    for (const q of qs) expect(q.options).toHaveLength(4);

    const [job] = await ctx.db.select().from(schema.generationJobs).where(eq(schema.generationJobs.quizId, quiz.id));
    expect(job).toMatchObject({ status: "succeeded", model: "fake-llm" });
    expect(job!.promptTokens).toBeGreaterThan(0);
    expect(Number(job!.costUsd)).toBeGreaterThan(0);
    expect(job!.budgetState).toMatchObject({ calls: expect.any(Number) });

    const evals = await ctx.db.select().from(schema.evalScores).where(eq(schema.evalScores.targetId, quiz.id));
    expect(evals.map((e) => e.evaluator)).toEqual(expect.arrayContaining(["quality_overall", "judge_overall", "judge_faithfulness"]));
    expect(metrics.at(-1)).toMatchObject({ JobSucceeded: 1, QuizQuality: expect.any(Number), QuizCostUsd: expect.any(Number) });
  });

  it("a duplicate delivery of a finished quiz is skipped without calling the LLM", async () => {
    const quiz = await newQuiz();
    await processQuizJob(deps(), { v: 1, quizId: quiz.id }, { count: 1, max: 3 });
    let calls = 0;
    const counting: LlmClient = { model: "x", complete: async () => (calls++, Promise.reject(new Error("should not be called"))) };
    const out = await processQuizJob(deps({ llm: counting }), { v: 1, quizId: quiz.id }, { count: 2, max: 3 });
    expect(out).toEqual({ kind: "skipped", reason: "ready" });
    expect(calls).toBe(0);
    expect(await processQuizJob(deps(), { v: 1, quizId: randomUUID() }, { count: 1, max: 3 })).toEqual({ kind: "skipped", reason: "missing" });
  });

  it("permanent errors fail the quiz immediately (no retry): blocked host, budget, non-retryable", async () => {
    const quiz = await newQuiz();
    const blocked = (async () => { throw new SourceError("host not allowed: evil.com", "host_not_allowed"); }) as never;
    const out = await processQuizJob(deps({ fetchMarkdown: blocked }), { v: 1, quizId: quiz.id }, { count: 1, max: 3 });
    expect(out.kind).toBe("failed");
    expect(await status(quiz.id)).toMatchObject({ status: "failed" });
    expect((await status(quiz.id)).error).toMatch(/host not allowed/);
  });

  it("transient failure: retry while attempts remain (job reused), success on redelivery, exhausted on the last", async () => {
    const quiz = await newQuiz();
    const flaky = (async () => { throw new SourceError("fetch failed: ECONNRESET", "fetch_failed"); }) as never;
    const first = await processQuizJob(deps({ fetchMarkdown: flaky }), { v: 1, quizId: quiz.id }, { count: 1, max: 3 });
    expect(first.kind).toBe("retry");
    expect((await status(quiz.id)).status).toBe("generating"); // not failed: it will be redelivered
    const jobsAfterFirst = await ctx.db.select().from(schema.generationJobs).where(eq(schema.generationJobs.quizId, quiz.id));

    const second = await processQuizJob(deps(), { v: 1, quizId: quiz.id }, { count: 2, max: 3 });
    expect(second.kind).toBe("done");
    const jobs = await ctx.db.select().from(schema.generationJobs).where(eq(schema.generationJobs.quizId, quiz.id));
    expect(jobs).toHaveLength(jobsAfterFirst.length); // same job row reused, not one per delivery

    const doomed = await newQuiz();
    const last = await processQuizJob(deps({ fetchMarkdown: flaky }), { v: 1, quizId: doomed.id }, { count: 3, max: 3 });
    expect(last.kind).toBe("exhausted");
    expect((await status(doomed.id)).status).toBe("failed");
  });

  it("LLM budget exhaustion is permanent and recorded", async () => {
    const quiz = await newQuiz();
    const hungry: LlmClient = { model: "x", complete: async () => ({ text: "not json", usage: { promptTokens: 10, completionTokens: 10, cachedTokens: 0 } }) };
    const tinyBudgetGen = (async (p: Parameters<typeof import("@quizforge/llm").generateQuiz>[0]) => {
      const { generateQuiz } = await import("@quizforge/llm");
      return generateQuiz({ ...p, budgetState: { calls: 15, usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, startedAt: Date.now() } });
    }) as never;
    const out = await processQuizJob(deps({ llm: hungry, generateQuiz: tinyBudgetGen }), { v: 1, quizId: quiz.id }, { count: 1, max: 3 });
    expect(out.kind).toBe("failed");
    expect((await status(quiz.id)).error).toMatch(/budget/i);
  });

  it("works with a checkpointer and the section-map-reduce strategy", async () => {
    const quiz = await newQuiz({ strategy: "section-map-reduce", critique: false });
    const sections = Array.from({ length: 6 }, (_, i) => `## Part ${i + 1}\n${Array.from({ length: 6 }, (_, j) => `Part ${i + 1} sentence ${j + 1} explains one more detail about the framework in depth.`).join(" ")}`).join("\n\n");
    const out = await processQuizJob(deps({ checkpointer: new MemorySaver(), fetchMarkdown: (async (u: string) => ({ url: u, rawUrl: u, text: sections, sha256: randomUUID().replace(/-/g, "").padEnd(64, "0") })) as never }), { v: 1, quizId: quiz.id }, { count: 1, max: 3 });
    expect(out.kind).toBe("done");
    expect((await status(quiz.id)).strategyUsed).toBe("section-map-reduce");
    expect(new JobBudget()).toBeDefined();
  });
});
