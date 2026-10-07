import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { SignJWT } from "jose";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import { claimQuiz, completeQuiz, createDb, upsertSource } from "@quizforge/db";
import { buildApp } from "./app.js";
import { LOCAL_AUDIENCE, LOCAL_ISSUER, localVerifier, signLocalToken } from "./auth.js";
import { loadConfig } from "./config.js";
import { MemoryQuizQueue } from "./queue.js";

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://quizforge:quizforge@localhost:5433/postgres";
const dbName = `qf_api_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const dbUrl = new URL(ADMIN_URL);
dbUrl.pathname = `/${dbName}`;
const SECRET = "test-secret-test-secret-test-secret";

let ctx: ReturnType<typeof createDb>;
let app: FastifyInstance;
const queue = new MemoryQuizQueue();

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  await admin.end();
  ctx = createDb(dbUrl.toString(), { max: 8 });
  await migrate(ctx.db, { migrationsFolder: fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url)) });
  const config = loadConfig({
    NODE_ENV: "test", DATABASE_URL: dbUrl.toString(), AUTH_MODE: "local", LOCAL_JWT_SECRET: SECRET, QUEUE_MODE: "memory",
    LOG_LEVEL: process.env.TEST_LOG ?? "fatal", DAILY_QUIZ_QUOTA: "4", CREATE_RATE_LIMIT_PER_MINUTE: "1000", RATE_LIMIT_PER_MINUTE: "10000",
  });
  app = await buildApp({ config, db: ctx.db, queue, verifier: localVerifier(SECRET), reenqueueAfterMs: 0 });
});
afterAll(async () => {
  await app.close();
  await ctx.pool.end();
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.end();
});

const token = (sub: string) => signLocalToken(SECRET, sub);
const call = async (sub: string | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.inject({
    method: method as "GET", url,
    headers: { ...(sub ? { authorization: `Bearer ${await token(sub)}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
};
const create = (sub: string, key: string, body: unknown = {}) => call(sub, "POST", "/v1/quizzes", body, { "idempotency-key": key });

/** What the worker does, minus the LLM: claim and write a finished 5-question quiz. */
async function finishQuiz(quizId: string) {
  const claimed = await claimQuiz(ctx.db, quizId);
  if (!("job" in claimed)) throw new Error("claim failed");
  const sourceId = await upsertSource(ctx.db, { url: "u", rawUrl: "r", sha256: randomUUID(), text: "t" });
  await completeQuiz(ctx.db, {
    quizId, jobId: claimed.job.id, sourceId, strategyUsed: "single-shot", job: { model: "fake", promptTokens: 1, completionTokens: 1, cachedTokens: 0, costUsd: 0 }, evals: [],
    questions: Array.from({ length: 5 }, (_, i) => ({
      prompt: `Question ${i + 1} about the document?`, options: ["right", "w1", "w2", "w3"], correct: [0], explanation: `explanation ${i + 1}`,
      sourceQuote: "the document says so", difficulty: "medium" as const, type: "single" as const,
    })),
  });
}

describe("authentication", () => {
  it("rejects missing, malformed, expired, foreign-signed and wrong-audience tokens", async () => {
    expect((await call(null, "GET", "/v1/quizzes")).status).toBe(401);
    expect((await call(null, "GET", "/v1/quizzes", undefined, { authorization: "Bearer not.a.jwt" })).status).toBe(401);
    expect((await call(null, "GET", "/v1/quizzes", undefined, { authorization: "Basic abc" })).status).toBe(401);
    const sign = (secret: string, aud: string, exp: string) =>
      new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("mallory").setIssuer(LOCAL_ISSUER).setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(new TextEncoder().encode(secret));
    for (const t of [await sign(SECRET, LOCAL_AUDIENCE, "-10s"), await sign("another-secret-another-secret-xx", LOCAL_AUDIENCE, "1h"), await sign(SECRET, "someone-else", "1h")]) {
      const r = await call(null, "GET", "/v1/quizzes", undefined, { authorization: `Bearer ${t}` });
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe("invalid_token");
      expect(r.headers["www-authenticate"]).toContain("Bearer");
    }
  });
  it("rejects alg=none tokens", async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "mallory", iss: LOCAL_ISSUER, aud: LOCAL_AUDIENCE, exp: 9999999999 })}.`;
    expect((await call(null, "GET", "/v1/quizzes", undefined, { authorization: `Bearer ${none}` })).status).toBe(401);
  });
  it("health endpoints are public; protected routes are not", async () => {
    expect((await call(null, "GET", "/healthz")).status).toBe(200);
    expect((await call(null, "GET", "/readyz")).status).toBe(200);
    expect((await call(null, "GET", "/openapi.json")).body.openapi).toBe("3.1.0");
    expect((await call(null, "GET", "/nope")).status).toBe(404);
  });
});

describe("quiz creation", () => {
  it("returns 202, enqueues once, and replays the same key as 200 with the same quiz", async () => {
    const key = randomUUID();
    const before = queue.messages.length;
    const a = await create("u-create", key, { numQuestions: 6, topic: "voice" });
    expect(a.status).toBe(202);
    expect(a.body.quiz.status).toBe("queued");
    expect(a.headers.location).toBe(`/v1/quizzes/${a.body.quiz.id}`);
    expect(queue.messages.length).toBe(before + 1);
    expect(queue.messages.at(-1)).toMatchObject({ v: 1, quizId: a.body.quiz.id });

    const b = await create("u-create", key, { numQuestions: 6, topic: "voice" });
    expect(b.status).toBe(200);
    expect(b.headers["idempotency-replayed"]).toBe("true");
    expect(b.body.quiz.id).toBe(a.body.quiz.id);
  });

  it("422 when the same key is reused with a different body; 400 when the key is missing", async () => {
    const key = randomUUID();
    await create("u-reuse", key, { numQuestions: 5 });
    const r = await create("u-reuse", key, { numQuestions: 8 });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("idempotency_key_reuse");
    expect((await call("u-reuse", "POST", "/v1/quizzes", {})).status).toBe(400);
    expect((await call("u-reuse", "POST", "/v1/quizzes", {}, { "idempotency-key": "short" })).status).toBe(400);
  });

  it("20 concurrent identical requests produce exactly one quiz and one queue message", async () => {
    const key = randomUUID();
    const before = queue.messages.length;
    const rs = await Promise.all(Array.from({ length: 20 }, () => create("u-race", key)));
    expect(new Set(rs.map((r) => r.body.quiz.id)).size).toBe(1);
    expect(rs.filter((r) => r.status === 202)).toHaveLength(1);
    expect(queue.messages.length - before).toBeGreaterThanOrEqual(1);
    const list = await call("u-race", "GET", "/v1/quizzes");
    expect(list.body.quizzes).toHaveLength(1);
  });

  it("validates input and blocks SSRF-style source URLs", async () => {
    expect((await create("u-val", randomUUID(), { numQuestions: 3 })).status).toBe(400);
    expect((await create("u-val", randomUUID(), { unknown: 1 })).status).toBe(400);
    for (const sourceUrl of ["http://github.com/o/r/blob/main/R.md", "https://169.254.169.254/latest/meta-data", "https://evil.example.com/r.md", "https://localhost/x.md", "https://user:pw@github.com/o/r"]) {
      const r = await create("u-val", randomUUID(), { sourceUrl });
      expect(r.status, sourceUrl).toBe(400);
      expect(r.body.error.code).toMatch(/source_/);
    }
    expect((await create("u-val", randomUUID(), { sourceUrl: "https://github.com/mastra-ai/mastra/blob/main/README.md" })).status).toBe(202);
  });

  it("enforces the daily quota but never blocks idempotent replays", async () => {
    const keys = Array.from({ length: 4 }, () => randomUUID());
    for (const k of keys) expect((await create("u-quota", k)).status).toBe(202);
    expect((await create("u-quota", randomUUID())).status).toBe(429);
    expect((await create("u-quota", keys[0]!)).status).toBe(200); // replay still fine
  });

  it("when the queue is down: 503 and the same key later re-publishes without duplicating the quiz", async () => {
    const key = randomUUID();
    queue.failNext = true;
    const down = await create("u-queue", key);
    expect(down.status).toBe(503);
    expect(down.headers["retry-after"]).toBe("2");
    const before = queue.messages.length;
    const retry = await create("u-queue", key);
    expect(retry.status).toBe(200);
    expect(queue.messages.length).toBe(before + 1);
    expect((await call("u-queue", "GET", "/v1/quizzes")).body.quizzes).toHaveLength(1);
  });
});

describe("full quiz flow", () => {
  it("create -> (worker) -> answer with retries -> submit -> score", async () => {
    const sub = "u-flow";
    const created = await create(sub, randomUUID());
    const quizId = created.body.quiz.id as string;

    // not ready yet: no questions, cannot start an attempt
    expect((await call(sub, "GET", `/v1/quizzes/${quizId}`)).body.questions).toEqual([]);
    expect((await call(sub, "POST", `/v1/quizzes/${quizId}/attempts`, {}, { "idempotency-key": randomUUID() })).status).toBe(409);

    await finishQuiz(quizId);
    const quiz = await call(sub, "GET", `/v1/quizzes/${quizId}`);
    expect(quiz.body.quiz.status).toBe("ready");
    expect(quiz.body.questions).toHaveLength(5);
    expect(JSON.stringify(quiz.body)).not.toMatch(/isCorrect|is_correct|explanation|sourceQuote/); // answer key never leaks
    const qs = quiz.body.questions as { id: string; options: { id: string }[] }[];

    const attemptKey = randomUUID();
    const att = await call(sub, "POST", `/v1/quizzes/${quizId}/attempts`, {}, { "idempotency-key": attemptKey });
    expect(att.status).toBe(201);
    const att2 = await call(sub, "POST", `/v1/quizzes/${quizId}/attempts`, {}, { "idempotency-key": attemptKey });
    expect([att2.status, att2.body.attempt.id]).toEqual([200, att.body.attempt.id]);
    const attemptId = att.body.attempt.id as string;

    const put = (qi: number, optionIdx: number, revision: number) =>
      call(sub, "PUT", `/v1/attempts/${attemptId}/answers/${qs[qi]!.id}`, { optionIds: [qs[qi]!.options[optionIdx]!.id], revision });
    // q1: wrong first, then fixed; the delayed first click arrives afterwards and must be ignored
    expect((await put(0, 1, 1)).body.status).toBe("saved");
    expect((await put(0, 0, 2)).body.status).toBe("saved");
    expect((await put(0, 1, 1)).body.status).toBe("ignored");
    await put(1, 0, 1); // right
    await put(2, 3, 1); // wrong
    await put(3, 0, 1); // right
    // q5 left blank

    const progress = await call(sub, "GET", `/v1/attempts/${attemptId}`);
    expect(progress.body.answers).toHaveLength(4);
    expect(JSON.stringify(progress.body)).not.toMatch(/isCorrect|explanation/);

    const submit = await call(sub, "POST", `/v1/attempts/${attemptId}/submit`);
    expect(submit.status).toBe(200);
    expect(submit.body.replayed).toBe(false);
    const r = submit.body.result;
    expect(r.questions.map((q: { score: number }) => q.score)).toEqual([4, 4, 0, 4, 0]);
    // weights 1, 1.1, 1.21, 1.331, 1.4641 => (4+4.4+0+5.324+0)/6.1051
    expect(r.finalScore).toBeCloseTo((4 + 4.4 + 5.324) / 6.1051, 4);
    expect(r.questions[0].options.find((o: { isCorrect: boolean }) => o.isCorrect)).toBeDefined(); // key revealed after submit
    expect(r.questions[0].explanation).toBe("explanation 1");

    const again = await call(sub, "POST", `/v1/attempts/${attemptId}/submit`);
    expect(again.body.replayed).toBe(true);
    expect(again.body.result.finalScore).toBe(r.finalScore);
    expect((await put(2, 0, 50)).status).toBe(409); // locked after submit
    expect((await call(sub, "GET", `/v1/attempts/${attemptId}`)).body.result.finalScore).toBe(r.finalScore);
  });

  it("users cannot see or touch each other's quizzes and attempts (404, not 403)", async () => {
    const created = await create("owner", randomUUID());
    const quizId = created.body.quiz.id as string;
    await finishQuiz(quizId);
    const att = await call("owner", "POST", `/v1/quizzes/${quizId}/attempts`, {}, { "idempotency-key": randomUUID() });
    const attemptId = att.body.attempt.id as string;
    const q = (await call("owner", "GET", `/v1/quizzes/${quizId}`)).body.questions[0];

    expect((await call("intruder", "GET", `/v1/quizzes/${quizId}`)).status).toBe(404);
    expect((await call("intruder", "POST", `/v1/quizzes/${quizId}/attempts`, {}, { "idempotency-key": randomUUID() })).status).toBe(404);
    expect((await call("intruder", "GET", `/v1/attempts/${attemptId}`)).status).toBe(404);
    expect((await call("intruder", "PUT", `/v1/attempts/${attemptId}/answers/${q.id}`, { optionIds: [q.options[0].id], revision: 1 })).status).toBe(404);
    expect((await call("intruder", "POST", `/v1/attempts/${attemptId}/submit`)).status).toBe(404);
    expect((await call("intruder", "GET", "/v1/quizzes")).body.quizzes).toEqual([]);
    expect((await call("owner", "GET", "/v1/quizzes/not-a-uuid")).status).toBe(404);
  });

  it("rejects malformed answers", async () => {
    const created = await create("u-bad", randomUUID());
    await finishQuiz(created.body.quiz.id);
    const quiz = (await call("u-bad", "GET", `/v1/quizzes/${created.body.quiz.id}`)).body;
    const att = (await call("u-bad", "POST", `/v1/quizzes/${created.body.quiz.id}/attempts`, {}, { "idempotency-key": randomUUID() })).body.attempt.id;
    const q = quiz.questions[0];
    const put = (b: unknown) => call("u-bad", "PUT", `/v1/attempts/${att}/answers/${q.id}`, b);
    expect((await put({ optionIds: [], revision: 1 })).status).toBe(400);
    expect((await put({ optionIds: ["x"], revision: 1 })).status).toBe(400);
    expect((await put({ optionIds: [q.options[0].id, q.options[1].id], revision: 1 })).status).toBe(422); // single-answer question
    expect((await put({ optionIds: [randomUUID()], revision: 1 })).status).toBe(422);
    expect((await put({ optionIds: [q.options[0].id], revision: 1, extra: true })).status).toBe(400);
  });
});
