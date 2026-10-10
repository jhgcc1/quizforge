import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { MemorySaver } from "@langchain/langgraph";
import { createDb, createQuizIdempotent, eq, getPublicQuestions, migrate, schema } from "@quizforge/db";
import { JobBudget, QualityGateError, SourceError, createFakeLlm, type LlmClient } from "@quizforge/llm";
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

describe("content failures vs infrastructure failures", () => {
  it("a QualityGateError deletes the checkpoint thread (retry regenerates); a flaky fetch keeps it (retry resumes)", async () => {
    const cp = new MemorySaver();
    const spy = vi.spyOn(cp, "deleteThread");
    const content = await newQuiz();
    const gateFail = (async () => { throw new QualityGateError("only 3 grounded question(s)", [1]); }) as never;
    const first = await processQuizJob(deps({ checkpointer: cp, generateQuiz: gateFail }), { v: 1, quizId: content.id }, { count: 1, max: 3 });
    expect(first.kind).toBe("retry");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toContain(content.id);

    const infra = await newQuiz();
    const flaky = (async () => { throw new SourceError("fetch failed: ECONNRESET", "fetch_failed"); }) as never;
    await processQuizJob(deps({ checkpointer: cp, fetchMarkdown: flaky }), { v: 1, quizId: infra.id }, { count: 1, max: 3 });
    expect(spy).toHaveBeenCalledTimes(1); // unchanged
  });

  it("the stored question count is the REAL one when questions were dropped", async () => {
    const quiz = await newQuiz({ numQuestions: 6 });
    const dropped = (async (p: Parameters<typeof import("@quizforge/llm").generateQuiz>[0]) => {
      const { generateQuiz } = await import("@quizforge/llm");
      const r = await generateQuiz({ ...p, input: { ...p.input, numQuestions: 6 } });
      return { ...r, questions: r.questions.slice(0, 5) }; // as if one ungrounded question had been dropped
    }) as never;
    const out = await processQuizJob(deps({ generateQuiz: dropped }), { v: 1, quizId: quiz.id }, { count: 1, max: 3 });
    expect(out.kind).toBe("done");
    expect((await status(quiz.id)).numQuestions).toBe(5);
    expect(await getPublicQuestions(ctx.db, quiz.id)).toHaveLength(5);
  });
});

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
    // the worker only generates and saves: EVERY score (fixed checks, judge, quality_overall) comes later, from the scorer service
    expect(evals).toEqual([]);
    expect(metrics.at(-1)).toMatchObject({ JobSucceeded: 1, QuizCostUsd: expect.any(Number) });
    expect(metrics.at(-1)).not.toHaveProperty("QuizQuality"); // emitted by the scorer
    expect(job!.scoredAt).toBeNull();
  });

  it("does NOT run the judge: the quiz is ready after generation only, and a scoring job is queued for the scorer", async () => {
    const quiz = await newQuiz();
    const names: string[] = [];
    const base = createFakeLlm();
    const llm: LlmClient = { model: "spy", complete: (m, o) => (names.push(o?.name ?? ""), base.complete(m, o)) };
    const queued: unknown[] = [];
    const out = await processQuizJob(deps({ llm, publishScore: async (m) => void queued.push(m) }), { v: 1, quizId: quiz.id, requestId: "req-9" }, { count: 1, max: 3 });
    expect(out.kind).toBe("done");
    expect(names.some((n) => n.startsWith("judge"))).toBe(false); // no judge call during generation
    const [job] = await ctx.db.select().from(schema.generationJobs).where(eq(schema.generationJobs.quizId, quiz.id));
    expect(queued).toEqual([{ v: 1, quizId: quiz.id, jobId: job!.id, requestId: "req-9" }]);
    expect((await status(quiz.id)).status).toBe("ready");
  });

  it("when the scoring job cannot be queued the quiz is still ready, the job succeeds, and a metric says so (the sweeper will queue it)", async () => {
    const quiz = await newQuiz();
    const out = await processQuizJob(deps({ publishScore: async () => { throw new Error("SQS unavailable"); } }), { v: 1, quizId: quiz.id }, { count: 1, max: 3 });
    expect(out.kind).toBe("done");
    expect((await status(quiz.id)).status).toBe("ready");
    expect(metrics.some((m) => m.ScoreJobNotQueued === 1)).toBe(true);
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

describe("the input guard in the worker (door 1)", () => {
  const docFetch = (text: string) => (async (url: string) => ({ url, rawUrl: url, text, sha256: randomUUID().replace(/-/g, "").padEnd(64, "0") })) as never;
  const countingLlm = () => {
    const inner = createFakeLlm();
    const calls: string[] = [];
    const llm: LlmClient = { model: inner.model, complete: (m, o) => (calls.push(o?.name ?? "?"), inner.complete(m, o)) };
    return { llm, calls };
  };
  const sourcesCount = async () => (await ctx.db.select().from(schema.sources)).length;

  it("a document with an encoded instruction is rejected: quiz failed, no model call, nothing stored, its own metric and no job-failure alarm", async () => {
    const { ATTACK_TECHNIQUES, DEFAULT_PAYLOAD } = await import("@quizforge/core");
    const text = ATTACK_TECHNIQUES.find((t) => t.id === "base64")!.embed(DEFAULT_PAYLOAD);
    const quiz = await newQuiz();
    const { llm, calls } = countingLlm();
    const before = await sourcesCount();
    metrics.length = 0;
    const out = await processQuizJob(deps({ llm, fetchMarkdown: docFetch(text) }), { v: 1, quizId: quiz.id }, { count: 1, max: 3 });
    expect(out.kind).toBe("failed");
    expect((await status(quiz.id)).status).toBe("failed");
    expect((await status(quiz.id)).error).toContain("unsafe_document");
    expect(calls).toEqual([]);
    expect(await sourcesCount()).toBe(before);
    expect(metrics.at(-1)).toMatchObject({ DocumentRejected: 1 });
    expect(metrics.at(-1)).not.toHaveProperty("JobFailed");
  });

  it("a document in an unsupported language is rejected the same way", async () => {
    const { UNSUPPORTED_LANGUAGE_DOCS } = await import("@quizforge/core");
    const quiz = await newQuiz();
    const { llm, calls } = countingLlm();
    const out = await processQuizJob(deps({ llm, fetchMarkdown: docFetch(UNSUPPORTED_LANGUAGE_DOCS.find((d) => d.id === "french")!.text) }), { v: 1, quizId: quiz.id }, { count: 1, max: 3 });
    expect(out.kind).toBe("failed");
    expect((await status(quiz.id)).error).toContain("unsupported_language");
    expect(calls).toEqual([]);
  });

  it("the allowed languages can be narrowed by configuration", async () => {
    const { SUPPORTED_LANGUAGE_DOCS } = await import("@quizforge/core");
    const quiz = await newQuiz();
    const pt = SUPPORTED_LANGUAGE_DOCS.find((d) => d.language === "pt")!.text;
    const out = await processQuizJob(deps({ allowedLanguages: ["en"], fetchMarkdown: docFetch(pt) }), { v: 1, quizId: quiz.id }, { count: 1, max: 3 });
    expect(out.kind).toBe("failed");
  });

  it("a plain instruction is kept as data: the quiz is generated, the document is flagged, the flag has a metric", async () => {
    const { ATTACK_TECHNIQUES, DEFAULT_PAYLOAD } = await import("@quizforge/core");
    const text = ATTACK_TECHNIQUES.find((t) => t.id === "plain-english")!.embed(DEFAULT_PAYLOAD);
    const quiz = await newQuiz({ numQuestions: 5 });
    metrics.length = 0;
    const out = await processQuizJob(deps({ fetchMarkdown: docFetch(text) }), { v: 1, quizId: quiz.id }, { count: 1, max: 3 });
    expect(out.kind).toBe("done");
    expect(metrics.some((m) => m.InjectionFlagged === 1)).toBe(true);
  });

  it("the sanitized text is what is stored (HTML comments and invisible characters removed), so the scorer reads the same text", async () => {
    const { benignDocument } = await import("@quizforge/core");
    const quiz = await newQuiz({ numQuestions: 5 });
    const text = benignDocument().replace("## Retries", "<!-- toc -->\u200B## Retries");
    await processQuizJob(deps({ fetchMarkdown: docFetch(text) }), { v: 1, quizId: quiz.id }, { count: 1, max: 3 });
    const row = await status(quiz.id);
    const [src] = await ctx.db.select().from(schema.sources).where(eq(schema.sources.id, row.sourceId!));
    expect(src!.contentText).not.toContain("<!--");
    expect(src!.contentText).not.toContain("\u200B");
  });

  describe("the optional semantic detector (English only)", () => {
    const stub = (flagged: boolean, calls: string[] = []) => ({
      name: "stub",
      languages: ["en"] as const,
      detect: async (t: string) => (calls.push(t.slice(0, 10)), { flagged, score: flagged ? 0.97 : 0.02, scanned: 1, total: 1, ms: 3 }),
    });

    it("flag mode: the quiz is generated, the verdict is logged and counted", async () => {
      const quiz = await newQuiz({ numQuestions: 5 });
      metrics.length = 0;
      const out = await processQuizJob(deps({ detector: stub(true), detectorMode: "flag" }), { v: 1, quizId: quiz.id }, { count: 1, max: 3 });
      expect(out.kind).toBe("done");
      expect(metrics.some((m) => m.InjectionDetected === 1)).toBe(true);
    });

    it("block mode: the document is rejected before the model, like any other unsafe document", async () => {
      const quiz = await newQuiz();
      const { llm, calls } = countingLlm();
      const out = await processQuizJob(deps({ llm, detector: stub(true), detectorMode: "block" }), { v: 1, quizId: quiz.id }, { count: 1, max: 3 });
      expect(out.kind).toBe("failed");
      expect((await status(quiz.id)).error).toContain("unsafe_document");
      expect(calls).toEqual([]);
    });

    it("is skipped for a Portuguese document (the model is English only) and when it is off", async () => {
      const { SUPPORTED_LANGUAGE_DOCS } = await import("@quizforge/core");
      const pt = SUPPORTED_LANGUAGE_DOCS.find((d) => d.language === "pt")!.text;
      const seen: string[] = [];
      const q1 = await newQuiz({ numQuestions: 5 });
      expect((await processQuizJob(deps({ detector: stub(true, seen), detectorMode: "block", fetchMarkdown: docFetch(pt) }), { v: 1, quizId: q1.id }, { count: 1, max: 3 })).kind).toBe("done");
      const q2 = await newQuiz({ numQuestions: 5 });
      expect((await processQuizJob(deps({ detector: stub(true, seen), detectorMode: "off" }), { v: 1, quizId: q2.id }, { count: 1, max: 3 })).kind).toBe("done");
      expect(seen).toEqual([]);
    });

    it("a detector that crashes never takes the job down", async () => {
      const quiz = await newQuiz({ numQuestions: 5 });
      metrics.length = 0;
      const broken = { name: "broken", languages: ["en"] as const, detect: async () => { throw new Error("model not found"); } };
      const out = await processQuizJob(deps({ detector: broken, detectorMode: "block" }), { v: 1, quizId: quiz.id }, { count: 1, max: 3 });
      expect(out.kind).toBe("done");
      expect(metrics.some((m) => m.DetectorFailed === 1)).toBe(true);
    });
  });
});
