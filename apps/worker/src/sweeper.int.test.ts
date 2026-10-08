import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { claimQuiz, completeQuiz, createDb, createQuizIdempotent, eq, migrate, saveScores, schema, upsertSource } from "@quizforge/db";
import { createLogger } from "./log.js";
import { sweepOnce } from "./sweeper.js";

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://quizforge:quizforge@localhost:5433/postgres";
const dbName = `qf_swp_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const url = new URL(ADMIN_URL);
url.pathname = `/${dbName}`;
let ctx: ReturnType<typeof createDb>;

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

const mk = async () => (await createQuizIdempotent(ctx.db, { ownerSub: "o", sourceUrl: "u", numQuestions: 5, strategy: "auto", critique: true, idempotencyKey: randomUUID(), requestHash: "h" })).quiz;
const age = (id: string, minutes: number) => ctx.db.update(schema.quizzes).set({ updatedAt: new Date(Date.now() - minutes * 60_000) }).where(eq(schema.quizzes.id, id));
const status = async (id: string) => (await ctx.db.select().from(schema.quizzes).where(eq(schema.quizzes.id, id)))[0]!;

describe("sweepOnce", () => {
  it("re-queues an old queued quiz, fails a stuck generating one, and leaves fresh ones alone", async () => {
    const lost = await mk();
    await age(lost.id, 10); // queued for 10 min: message was lost
    const fresh = await mk(); // just created: must not be touched
    const stuck = await mk();
    await claimQuiz(ctx.db, stuck.id); // -> generating
    await age(stuck.id, 45);
    const working = await mk();
    await claimQuiz(ctx.db, working.id);
    await age(working.id, 5); // generating but only 5 min: still plausible

    const published: string[] = [];
    const res = await sweepOnce({ db: ctx.db, log: createLogger("error"), publish: async (id) => void published.push(id) });

    expect(res).toEqual({ requeued: 1, failed: 1, rescored: 0 });
    expect(published).toEqual([lost.id]);
    expect((await status(stuck.id)).status).toBe("failed");
    expect((await status(stuck.id)).error).toMatch(/timed out/);
    expect((await status(fresh.id)).status).toBe("queued");
    expect((await status(working.id)).status).toBe("generating");
    expect((await status(lost.id)).status).toBe("queued"); // still queued: the worker will pick it up
  });

  it("a failing publish does not abort the sweep", async () => {
    const a = await mk();
    const b = await mk();
    await age(a.id, 10);
    await age(b.id, 10);
    const ok: string[] = [];
    const res = await sweepOnce({
      db: ctx.db,
      log: createLogger("error"),
      publish: async (id) => {
        if (id === a.id) throw new Error("sqs down");
        ok.push(id);
      },
    });
    expect(res.requeued).toBeGreaterThanOrEqual(1);
    expect(ok).toContain(b.id);
  });
});

/** A quiz that finished generating `minutes` ago (ready + succeeded job), with no scores yet. */
async function finishedQuiz(minutes: number) {
  const quiz = await mk();
  const claimed = await claimQuiz(ctx.db, quiz.id);
  if (!("job" in claimed)) throw new Error("claim failed");
  const sourceId = await upsertSource(ctx.db, { url: "u", rawUrl: "r", sha256: randomUUID(), text: "doc text" });
  await completeQuiz(ctx.db, {
    quizId: quiz.id, jobId: claimed.job.id, sourceId, strategyUsed: "single-shot", evals: [], job: { model: "fake", promptTokens: 1, completionTokens: 1, cachedTokens: 0, costUsd: 0, traceId: "t" },
    questions: Array.from({ length: 5 }, (_, i) => ({ prompt: `Q${i}?`, options: ["a", "b", "c", "d"], correct: [0], explanation: "e", sourceQuote: "doc text here", difficulty: "easy" as const, type: "single" as const })),
  });
  await ctx.db.update(schema.generationJobs).set({ finishedAt: new Date(Date.now() - minutes * 60_000) }).where(eq(schema.generationJobs.id, claimed.job.id));
  return { quizId: quiz.id, jobId: claimed.job.id };
}

describe("sweepOnce: quizzes that were never scored", () => {
  it("queues a finished, unscored quiz for scoring; leaves fresh, scored and over-tried ones alone", async () => {
    const lost = await finishedQuiz(10); // the scoring message was lost
    const fresh = await finishedQuiz(1); // the scorer is probably working on it
    const done = await finishedQuiz(10);
    await saveScores(ctx.db, { quizId: done.quizId, jobId: done.jobId, scores: [{ evaluator: "quality_overall", value: 0.8 }] });
    const hopeless = await finishedQuiz(10);
    await ctx.db.update(schema.generationJobs).set({ scoringAttempts: 6 }).where(eq(schema.generationJobs.id, hopeless.jobId));

    const queued: { quizId: string; jobId: string }[] = [];
    const res = await sweepOnce({ db: ctx.db, log: createLogger("error"), publish: async () => undefined, publishScore: async (m) => void queued.push({ quizId: m.quizId, jobId: m.jobId }) });

    expect(res.rescored).toBe(queued.length);
    expect(queued).toContainEqual(lost);
    for (const other of [fresh, done, hopeless]) expect(queued).not.toContainEqual(other);
  });

  it("without a scoring queue nothing is re-queued for scoring", async () => {
    await finishedQuiz(10);
    const res = await sweepOnce({ db: ctx.db, log: createLogger("error"), publish: async () => undefined });
    expect(res.rescored).toBe(0);
  });
});
