import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { claimQuiz, createDb, createQuizIdempotent, eq, migrate, schema } from "@quizforge/db";
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

    expect(res).toEqual({ requeued: 1, failed: 1 });
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
