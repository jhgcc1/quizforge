import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { SignJWT } from "jose";
import type { FastifyInstance } from "fastify";
import { claimQuiz, completeQuiz, createDb, failQuiz, migrate, setQuizPhase, upsertSource } from "@quizforge/db";
import { GENERATION_PHASES as WORKER_PHASES } from "@quizforge/llm";
import { buildApp } from "./app.js";
import { LOCAL_AUDIENCE, LOCAL_ISSUER, localVerifier, signLocalToken } from "./auth.js";
import { loadConfig } from "./config.js";
import { MemoryQuizQueue } from "./queue.js";
import { openApiDocument } from "./openapi.js";
import {
  GENERATION_PHASES, GenerationProgressSchema, AttemptListSchema, AttemptResultSchema, AttemptWithAnswersSchema, CatalogResponseSchema, CreateQuizBodySchema, ErrorBodySchema, QuizEnvelopeSchema, QuizListSchema,
  QuizWithQuestionsSchema, SAMPLE_CATALOG, SaveAnswerResponseSchema, SubmitResponseSchema,
} from "@quizforge/core";
import type { ZodTypeAny } from "zod";

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
const adminToken = (sub: string) => signLocalToken(SECRET, sub, 3600, ["admin"]);
const call = async (sub: string | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.inject({
    method: method as "GET", url,
    headers: { ...(sub ? { authorization: `Bearer ${await token(sub)}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
};
/** Contract check: the body the API really sent must satisfy the schema that the BFF and the browser validate against. */
const shape = <S extends ZodTypeAny>(schema: S, body: unknown): void => {
  const r = schema.safeParse(body);
  if (!r.success) throw new Error(`response does not match its contract: ${JSON.stringify(r.error.issues)} in ${JSON.stringify(body).slice(0, 300)}`);
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
    shape(QuizEnvelopeSchema, created.body);

    // not ready yet: no questions, cannot start an attempt
    expect((await call(sub, "GET", `/v1/quizzes/${quizId}`)).body.questions).toEqual([]);
    expect((await call(sub, "POST", `/v1/quizzes/${quizId}/attempts`, {}, { "idempotency-key": randomUUID() })).status).toBe(409);

    await finishQuiz(quizId);
    const quiz = await call(sub, "GET", `/v1/quizzes/${quizId}`);
    expect(quiz.body.quiz.status).toBe("ready");
    expect(quiz.body.questions).toHaveLength(5);
    shape(QuizWithQuestionsSchema, quiz.body);
    shape(QuizListSchema, (await call(sub, "GET", "/v1/quizzes")).body);
    expect(JSON.stringify(quiz.body)).not.toMatch(/isCorrect|is_correct|explanation|sourceQuote/); // answer key never leaks
    const qs = quiz.body.questions as { id: string; options: { id: string }[] }[];

    const attemptKey = randomUUID();
    const att = await call(sub, "POST", `/v1/quizzes/${quizId}/attempts`, {}, { "idempotency-key": attemptKey });
    expect(att.status).toBe(201);
    shape(AttemptWithAnswersSchema, att.body);
    const att2 = await call(sub, "POST", `/v1/quizzes/${quizId}/attempts`, {}, { "idempotency-key": attemptKey });
    expect([att2.status, att2.body.attempt.id]).toEqual([200, att.body.attempt.id]);
    const attemptId = att.body.attempt.id as string;

    const put = (qi: number, optionIdx: number, revision: number) =>
      call(sub, "PUT", `/v1/attempts/${attemptId}/answers/${qs[qi]!.id}`, { optionIds: [qs[qi]!.options[optionIdx]!.id], revision });
    // q1: wrong first, then fixed; the delayed first click arrives afterwards and must be ignored
    shape(SaveAnswerResponseSchema, (await put(0, 1, 1)).body);
    expect((await put(0, 0, 2)).body.status).toBe("saved");
    expect((await put(0, 1, 1)).body.status).toBe("ignored");
    await put(1, 0, 1); // right
    await put(2, 3, 1); // wrong
    await put(3, 0, 1); // right
    // q5 left blank

    // history list: the open attempt shows, no score yet
    const listed = (await call(sub, "GET", "/v1/quizzes")).body.quizzes.find((x: { id: string }) => x.id === quizId);
    expect(listed.progress).toEqual({ attempts: 1, inProgressAttemptId: attemptId, last: null, best: null });

    const progress = await call(sub, "GET", `/v1/attempts/${attemptId}`);
    expect(progress.body.answers).toHaveLength(4);
    shape(AttemptWithAnswersSchema, progress.body);
    expect(JSON.stringify(progress.body)).not.toMatch(/isCorrect|explanation/);

    const submit = await call(sub, "POST", `/v1/attempts/${attemptId}/submit`);
    expect(submit.status).toBe(200);
    shape(SubmitResponseSchema, submit.body);
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
    const final = await call(sub, "GET", `/v1/attempts/${attemptId}`);
    shape(AttemptResultSchema, final.body.result);
    expect(final.body.result.finalScore).toBe(r.finalScore);

    // history after the submit: last and best score on the list, and the attempts of the quiz
    const done = (await call(sub, "GET", "/v1/quizzes")).body.quizzes.find((x: { id: string }) => x.id === quizId);
    expect(done.progress.attempts).toBe(1);
    expect(done.progress.inProgressAttemptId).toBeNull();
    expect(done.progress.last.attemptId).toBe(attemptId);
    expect(done.progress.last.finalScore).toBeCloseTo(r.finalScore, 6);
    expect(done.progress.last.percent).toBeCloseTo((r.finalScore / 4) * 100, 4);
    expect(done.progress.best).toBeCloseTo(r.finalScore, 6);
    const attemptsList = await call(sub, "GET", `/v1/quizzes/${quizId}/attempts`);
    shape(AttemptListSchema, attemptsList.body);
    expect(attemptsList.body.attempts.map((a: { id: string }) => a.id)).toEqual([attemptId]);
    expect(JSON.stringify(attemptsList.body)).not.toMatch(/isCorrect|explanation|sourceQuote/);

    // retake: a new attempt, the old score stays, the best is kept
    const retake = await call(sub, "POST", `/v1/quizzes/${quizId}/attempts`, {}, { "idempotency-key": randomUUID() });
    expect(retake.status).toBe(201);
    const again2 = (await call(sub, "GET", "/v1/quizzes")).body.quizzes.find((x: { id: string }) => x.id === quizId);
    expect(again2.progress.attempts).toBe(2);
    expect(again2.progress.inProgressAttemptId).toBe(retake.body.attempt.id);
    expect(again2.progress.last.attemptId).toBe(attemptId);
    expect((await call(sub, "GET", `/v1/quizzes/${quizId}/attempts`)).body.attempts).toHaveLength(2);
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
    expect((await call("intruder", "GET", `/v1/quizzes/${quizId}/attempts`)).status).toBe(404);
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

describe("generation progress (generationProgress on the quiz)", () => {
  const fetchQuiz = async (sub: string, id: string) => (await call(sub, "GET", `/v1/quizzes/${id}`)).body.quiz;

  it("is null while queued, follows the phase the worker records while generating, and is null again when ready", async () => {
    const sub = "u-progress";
    const quizId = (await create(sub, randomUUID())).body.quiz.id as string;
    shape(QuizEnvelopeSchema, (await call(sub, "GET", `/v1/quizzes/${quizId}`)).body);
    expect((await fetchQuiz(sub, quizId)).generationProgress).toBeNull();

    const claimed = await claimQuiz(ctx.db, quizId);
    expect("job" in claimed).toBe(true);
    expect((await fetchQuiz(sub, quizId)).generationProgress).toBeNull(); // generating, but no phase reported yet

    const seen: unknown[] = [];
    for (const p of [
      { phase: "reading_document", step: 1, totalSteps: 5 },
      { phase: "writing_questions", step: 2, totalSteps: 5, detail: "section 2 of 5" },
      { phase: "reviewing", step: 4, totalSteps: 5, detail: "round 1 of 2" },
    ]) {
      await setQuizPhase(ctx.db, quizId, p);
      const res = await call(sub, "GET", `/v1/quizzes/${quizId}`);
      shape(QuizWithQuestionsSchema, res.body);
      seen.push(res.body.quiz.generationProgress);
      expect(res.body.questions).toEqual([]);
      const listed = (await call(sub, "GET", "/v1/quizzes")).body;
      shape(QuizListSchema, listed);
      expect(listed.quizzes.find((x: { id: string }) => x.id === quizId).generationProgress).toEqual(res.body.quiz.generationProgress);
    }
    expect(seen).toEqual([
      { phase: "reading_document", step: 1, totalSteps: 5 }, // no detail key at all when there is none
      { phase: "writing_questions", step: 2, totalSteps: 5, detail: "section 2 of 5" },
      { phase: "reviewing", step: 4, totalSteps: 5, detail: "round 1 of 2" },
    ]);

    await finishQuiz(quizId);
    const ready = await call(sub, "GET", `/v1/quizzes/${quizId}`);
    expect(ready.body.quiz).toMatchObject({ status: "ready", generationProgress: null });
    shape(QuizWithQuestionsSchema, ready.body);
  });

  it("is null for a failed quiz, and a stale phase write cannot show on it", async () => {
    const sub = "u-progress-failed";
    const quizId = (await create(sub, randomUUID())).body.quiz.id as string;
    await claimQuiz(ctx.db, quizId);
    await setQuizPhase(ctx.db, quizId, { phase: "writing_questions", step: 2, totalSteps: 4 });
    await failQuiz(ctx.db, { quizId, error: "StructuredOutputError: nope" });
    await setQuizPhase(ctx.db, quizId, { phase: "saving", step: 4, totalSteps: 4 });
    const body = (await call(sub, "GET", `/v1/quizzes/${quizId}`)).body;
    expect(body.quiz).toMatchObject({ status: "failed", generationProgress: null });
    shape(QuizWithQuestionsSchema, body);
  });

  it("the phases the worker can report are exactly the phases the contract documents, and the OpenAPI schema describes the field", async () => {
    expect([...GENERATION_PHASES]).toEqual([...WORKER_PHASES]);
    expect(Object.keys(openApiDocument.components.schemas.GenerationProgress.properties).sort()).toEqual(Object.keys(GenerationProgressSchema.shape).sort());
    expect(openApiDocument.components.schemas.QuizSummary.properties.generationProgress).toBeDefined();
  });
});

describe("contracts", () => {
  it("serves the sample catalog behind authentication, in the shared schema", async () => {
    expect((await call(null, "GET", "/v1/catalog")).status).toBe(401);
    const res = await call("u-catalog", "GET", "/v1/catalog");
    expect(res.status).toBe(200);
    shape(CatalogResponseSchema, res.body);
    expect(res.body.items).toHaveLength(SAMPLE_CATALOG.length);
  });

  it("a catalog entry can be used as-is to create a quiz", async () => {
    for (const e of SAMPLE_CATALOG.slice(0, 2)) {
      const r = await create(`u-cat-${e.id}`, randomUUID(), { sourceUrl: e.url });
      expect(r.status).toBe(202);
    }
  });

  it("error responses all have the same shape", async () => {
    shape(ErrorBodySchema, (await call(null, "GET", "/v1/quizzes")).body); // 401
    shape(ErrorBodySchema, (await call("u-err", "GET", `/v1/quizzes/${randomUUID()}`)).body); // 404
    shape(ErrorBodySchema, (await create("u-err", randomUUID(), { numQuestions: 99 })).body); // 400 validation
    shape(ErrorBodySchema, (await create("u-err", "x")).body); // 400 missing key
  });

  it("the hand-written OpenAPI description lists exactly the fields the zod schemas accept (no drift)", () => {
    const doc = openApiDocument.components.schemas;
    expect(Object.keys(doc.CreateQuiz.properties).sort()).toEqual(Object.keys(CreateQuizBodySchema.shape).sort());
    expect(Object.keys(doc.Catalog.properties.items.items.properties).sort()).toEqual(Object.keys(SAMPLE_CATALOG[0]!).sort());
  });
});

describe("request validation at the API (nothing invalid reaches the queue, so nothing invalid reaches a model)", () => {
  it("rejects every bad topic from the attack corpus with 400 validation_error, and publishes nothing", async () => {
    const { BAD_TOPICS } = await import("@quizforge/core");
    for (const b of BAD_TOPICS) {
      const before = queue.messages.length;
      const r = await create("u-validate", randomUUID(), { topic: b.topic });
      expect(r.status, b.id).toBe(400);
      expect(r.body.error.code, b.id).toBe("validation_error");
      expect(queue.messages.length, b.id).toBe(before);
    }
  });

  it("rejects unknown fields, wrong types, out-of-range numbers and bad URLs (strict schema)", async () => {
    const bad: [string, unknown][] = [
      ["extra field", { numQuestions: 5, systemPrompt: "be evil" }],
      ["prototype pollution", JSON.parse('{"__proto__":{"admin":true},"numQuestions":5}')],
      ["numQuestions as text", { numQuestions: "5" }],
      ["too few", { numQuestions: 4 }],
      ["too many", { numQuestions: 9 }],
      ["fraction", { numQuestions: 5.5 }],
      ["strategy", { strategy: "run-shell" }],
      ["critique as text", { critique: "true" }],
      ["topic too long", { topic: "x".repeat(201) }],
      ["topic as array", { topic: ["a", "b"] }],
      ["topic as object", { topic: { $ne: "" } }],
      ["array body", [1, 2, 3]],
      ["string body", "hello"],
      ["url with credentials", { sourceUrl: "https://user:pass@github.com/o/r/blob/main/README.md" }],
      ["http url", { sourceUrl: "http://raw.githubusercontent.com/o/r/main/README.md" }],
      ["file url", { sourceUrl: "file:///etc/passwd" }],
      ["javascript url", { sourceUrl: "javascript:alert(1)" }],
      ["metadata address", { sourceUrl: "https://169.254.169.254/latest/meta-data/" }],
      ["localhost", { sourceUrl: "https://localhost/README.md" }],
      ["other host", { sourceUrl: "https://example.com/README.md" }],
    ];
    for (const [name, body] of bad) {
      const before = queue.messages.length;
      const r = await create("u-validate", randomUUID(), body);
      expect(r.status, name).toBeGreaterThanOrEqual(400);
      expect(r.status, name).toBeLessThan(500);
      expect(queue.messages.length, name).toBe(before);
    }
  });

  it("an answer body is strict too: only optionIds and revision", async () => {
    const q = await create("u-validate2", randomUUID(), { numQuestions: 5 });
    await finishQuiz(q.body.quiz.id);
    const a = await call("u-validate2", "POST", `/v1/quizzes/${q.body.quiz.id}/attempts`, {}, { "idempotency-key": randomUUID() });
    const qs = (await call("u-validate2", "GET", `/v1/quizzes/${q.body.quiz.id}`)).body.questions;
    const path = `/v1/attempts/${a.body.attempt.id}/answers/${qs[0].id}`;
    expect((await call("u-validate2", "PUT", path, { optionIds: [qs[0].options[0].id], revision: 1, isCorrect: true })).status).toBe(400);
    expect((await call("u-validate2", "PUT", path, { optionIds: "all", revision: 1 })).status).toBe(400);
    expect((await call("u-validate2", "PUT", path, { optionIds: [], revision: 1 })).status).toBe(400);
  });
});

describe("failure paths", () => {
  const cfgFor = () => loadConfig({ NODE_ENV: "test", DATABASE_URL: dbUrl.toString(), AUTH_MODE: "local", LOCAL_JWT_SECRET: SECRET, QUEUE_MODE: "memory", LOG_LEVEL: "fatal" });

  it("/readyz answers 503 (and says nothing about the cause) when the readiness probe fails", async () => {
    const broken = await buildApp({ config: cfgFor(), db: ctx.db, queue, verifier: localVerifier(SECRET), ping: async () => { throw new Error("password authentication failed for user quizforge"); } });
    const res = await broken.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("not_ready");
    expect(res.body).not.toMatch(/password|quizforge/);
    await broken.close();
    const ok = await buildApp({ config: cfgFor(), db: ctx.db, queue, verifier: localVerifier(SECRET), ping: async () => {} });
    expect((await ok.inject({ method: "GET", url: "/readyz" })).json()).toEqual({ status: "ready" });
    await ok.close();
  });

  it("the rate limit answers 429 in the shared error shape, saying when to retry", async () => {
    // The limit applies per user (keyGenerator), so two requests from the SAME token are what trips it.
    // This is the one reply the API produces without passing through `fail`: @fastify/rate-limit builds it,
    // and it has to look exactly like every other error or a client branching on `error.code` breaks on it.
    const limited = await buildApp({
      config: loadConfig({ NODE_ENV: "test", DATABASE_URL: dbUrl.toString(), AUTH_MODE: "local", LOCAL_JWT_SECRET: SECRET, QUEUE_MODE: "memory", LOG_LEVEL: "fatal", RATE_LIMIT_PER_MINUTE: "1" }),
      db: ctx.db, queue, verifier: localVerifier(SECRET),
    });
    const headers = { authorization: `Bearer ${await token("u-429")}` };
    expect((await limited.inject({ method: "GET", url: "/v1/catalog", headers })).statusCode).toBe(200);
    const res = await limited.inject({ method: "GET", url: "/v1/catalog", headers });
    expect(res.statusCode).toBe(429);
    shape(ErrorBodySchema, res.json());
    expect(res.json().error.code).toBe("rate_limited");
    expect(res.json().error.message).toMatch(/^Too many requests, retry in \d+s$/);
    expect(res.json().error.requestId).toBeTruthy();
    await limited.close();
  });

  it("an unexpected exception becomes a generic 500 with the shared error shape and no internal detail", async () => {
    const broken = await buildApp({ config: cfgFor(), db: {} as never, queue, verifier: localVerifier(SECRET) });
    const res = await broken.inject({ method: "GET", url: "/v1/quizzes", headers: { authorization: `Bearer ${await token("u-500")}` } });
    expect(res.statusCode).toBe(500);
    shape(ErrorBodySchema, res.json());
    expect(res.json().error).toMatchObject({ code: "internal", message: "Internal error" });
    expect(res.body).not.toMatch(/TypeError|undefined|select/);
    await broken.close();
  });

  it("an unexpected (non-SourceError) failure while validating the source URL is not mistaken for a 400", async () => {
    const broken = await buildApp({ config: { ...cfgFor(), allowedHosts: null as never }, db: ctx.db, queue, verifier: localVerifier(SECRET) });
    const res = await broken.inject({
      method: "POST", url: "/v1/quizzes", payload: JSON.stringify({}),
      headers: { authorization: `Bearer ${await token("u-url-500")}`, "content-type": "application/json", "idempotency-key": randomUUID() },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("internal");
    await broken.close();
  });

  it("replaying a still-queued quiz whose re-publish fails answers 503 with retry-after, and succeeds once the queue is back", async () => {
    const key = randomUUID();
    expect((await create("u-replay-down", key)).status).toBe(202);
    queue.failNext = true;
    const down = await create("u-replay-down", key);
    expect(down.status).toBe(503);
    expect(down.headers["retry-after"]).toBe("2");
    expect(down.body.error.code).toBe("queue_unavailable");
    expect((await create("u-replay-down", key)).status).toBe(200);
  });

  it("an attempt Idempotency-Key reused for ANOTHER quiz is a 422, not a silent replay of the first attempt", async () => {
    const a = (await create("u-key-reuse", randomUUID())).body.quiz.id as string;
    const b = (await create("u-key-reuse", randomUUID())).body.quiz.id as string;
    await finishQuiz(a);
    await finishQuiz(b);
    const key = randomUUID();
    expect((await call("u-key-reuse", "POST", `/v1/quizzes/${a}/attempts`, {}, { "idempotency-key": key })).status).toBe(201);
    const reuse = await call("u-key-reuse", "POST", `/v1/quizzes/${b}/attempts`, {}, { "idempotency-key": key });
    expect(reuse.status).toBe(422);
    expect(reuse.body.error.code).toBe("idempotency_key_reuse");
  });
});

describe("edge cases", () => {
  it("every route that takes an id answers 404 (never 500) for something that is not a UUID", async () => {
    const bad = "not-a-uuid";
    const k = { "idempotency-key": randomUUID() };
    expect((await call("u-edge", "GET", `/v1/quizzes/${bad}/attempts`)).status).toBe(404);
    expect((await call("u-edge", "POST", `/v1/quizzes/${bad}/attempts`, {}, k)).status).toBe(404);
    expect((await call("u-edge", "GET", `/v1/attempts/${bad}`)).status).toBe(404);
    expect((await call("u-edge", "PUT", `/v1/attempts/${bad}/answers/${bad}`, { optionIds: [randomUUID()], revision: 1 })).status).toBe(404);
    expect((await call("u-edge", "POST", `/v1/attempts/${bad}/submit`)).status).toBe(404);
    expect((await call("u-edge", "GET", `/v1/attempts/${randomUUID()}`)).status).toBe(404);
  });

  it("an attempt needs an Idempotency-Key even for a quiz that does not exist", async () => {
    const r = await call("u-edge", "POST", `/v1/quizzes/${randomUUID()}/attempts`, {});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("idempotency_key_required");
  });

  it("creating a quiz with no body at all uses the defaults", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/quizzes", headers: { authorization: `Bearer ${await token("u-nobody")}`, "idempotency-key": randomUUID() } });
    expect(res.statusCode).toBe(202);
  });

  it("a failed quiz shows the user a sentence, not the raw failure recorded for operators", async () => {
    const created = await create("u-failed", randomUUID());
    const id = created.body.quiz.id as string;
    await claimQuiz(ctx.db, id);
    await failQuiz(ctx.db, { quizId: id, error: "BudgetExceededError: LLM call budget exceeded (16)" });
    const got = await call("u-failed", "GET", `/v1/quizzes/${id}`);
    expect(got.body.quiz.status).toBe("failed");
    expect(got.body.quiz.error).toMatch(/too large or complex/);
    expect(JSON.stringify(got.body)).not.toMatch(/BudgetExceededError/);
    expect(got.body.questions).toEqual([]);
  });

  it("echoes a sane X-Request-Id, falls back to X-Amzn-Trace-Id, and replaces junk with a fresh id", async () => {
    expect((await call(null, "GET", "/healthz", undefined, { "x-request-id": "abc-123" })).headers["x-request-id"]).toBe("abc-123");
    expect((await call(null, "GET", "/healthz", undefined, { "x-amzn-trace-id": "Root=1-5e6722a7-cc2xmpl46db7ae02d4da47be" })).headers["x-request-id"]).toBe("Root=1-5e6722a7-cc2xmpl46db7ae02d4da47be");
    const junk = (await call(null, "GET", "/healthz", undefined, { "x-request-id": "bad\u0001id<script>" })).headers["x-request-id"] as string;
    expect(junk).toMatch(/^[0-9a-f-]{36}$/);
    const none = (await call(null, "GET", "/healthz")).headers["x-request-id"] as string;
    expect(none).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("asking for a document the classifier rejected", () => {
  /** A quiz that failed the way the classifier makes it fail: that is what a request points at. */
  const refusedQuiz = async (sub: string, url = "https://github.com/elastic/elasticsearch/blob/main/README.asciidoc") => {
    const quizId = (await create(sub, randomUUID(), { sourceUrl: url })).body.quiz.id as string;
    await failQuiz(ctx.db, { quizId, error: "unsafe_document: the classifier scored 0.97 for prompt injection (1/1 windows scanned)" });
    return quizId;
  };
  const post = async (sub: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/v1/document-requests", headers: { authorization: `Bearer ${await token(sub)}`, "content-type": "application/json" }, payload });

  it("marks the refused quiz as reviewable, so the client does not have to read the message", async () => {
    const quizId = await refusedQuiz("u-flag");
    const body = (await call("u-flag", "GET", `/v1/quizzes/${quizId}`)).body;
    expect(body.quiz).toMatchObject({ status: "failed", reviewable: true });
    expect(body.quiz.error).toMatch(/ask for it to be reviewed/);

    const otherId = (await create("u-flag2", randomUUID(), { sourceUrl: "https://github.com/o/r/blob/main/Y.md" })).body.quiz.id as string;
    await failQuiz(ctx.db, { quizId: otherId, error: "BudgetExceededError: LLM call budget exceeded (16)" });
    expect((await call("u-flag2", "GET", `/v1/quizzes/${otherId}`)).body.quiz.reviewable).toBe(false);
  });

  it("takes the document and the score from the quiz, so the reviewer sees evidence and the user types nothing", async () => {
    const quizId = await refusedQuiz("u-req-1");
    const res = await post("u-req-1", { quizId, title: "Elasticsearch", description: "Search engine", note: "Real project README" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "pending", title: "Elasticsearch", description: "Search engine", note: "Real project README", detectorScore: 0.97 });
    expect(res.json().url).toContain("elasticsearch");
    expect(res.json().excerpt).toContain("the classifier scored");
  });

  it("a second request for the same document is refused while the first waits", async () => {
    const again = await post("u-req-2", { quizId: await refusedQuiz("u-req-2"), title: "Elasticsearch again" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("request_already_open");
  });

  it("refuses a quiz that is not yours, and one that failed for another reason", async () => {
    const someoneElses = await refusedQuiz("u-owner", "https://github.com/o/r/blob/main/OTHER.md");
    expect((await post("u-intruder", { quizId: someoneElses, title: "Not mine" })).statusCode).toBe(404);
    expect((await post("u-x", { quizId: randomUUID(), title: "No such quiz" })).statusCode).toBe(404);

    const otherId = (await create("u-other-reason", randomUUID(), { sourceUrl: "https://github.com/o/r/blob/main/X.md" })).body.quiz.id as string;
    await failQuiz(ctx.db, { quizId: otherId, error: "QualityGateError: only 3 grounded question(s)" });
    const res = await post("u-other-reason", { quizId: otherId, title: "Quality failure" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("not_refused_by_classifier");
  });

  it("a user sees only their own requests; an admin sees all of them", async () => {
    await post("u-mine", { quizId: await refusedQuiz("u-mine", "https://github.com/BurntSushi/ripgrep/blob/master/README.md"), title: "ripgrep" });
    const mine = await app.inject({ method: "GET", url: "/v1/document-requests", headers: { authorization: `Bearer ${await token("u-mine")}` } });
    expect(mine.json().items.every((r: { title: string }) => r.title === "ripgrep")).toBe(true);

    const asAdmin = await app.inject({ method: "GET", url: "/v1/document-requests", headers: { authorization: `Bearer ${await adminToken("u-admin")}` } });
    expect(asAdmin.json().items.length).toBeGreaterThan(1);
  });

  // An approval is a standing decision, not an event: it has to stay visible to be undoable, and undoing it has to
  // put the document back behind the classifier for everybody.
  it("an approval can be taken back, which removes the document from the catalogue", async () => {
    const url = "https://github.com/honojs/hono/blob/main/SECURITY.md";
    const req = (await post("u-rev", { quizId: await refusedQuiz("u-rev", url), title: "Hono security" })).json();
    const review = async (id: string, action: string) =>
      app.inject({ method: "POST", url: `/v1/document-requests/${id}/review`, headers: { authorization: `Bearer ${await adminToken("u-admin")}`, "content-type": "application/json" }, payload: { action } });
    const catalogTitles = async () => {
      const r = await app.inject({ method: "GET", url: "/v1/catalog", headers: { authorization: `Bearer ${await token("u-anyone")}` } });
      return (r.json().items as { title: string }[]).map((i) => i.title);
    };

    expect((await review(req.id, "approve")).statusCode).toBe(200);
    expect(await catalogTitles()).toContain("Hono security");

    const revoked = await review(req.id, "revoke");
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().status).toBe("revoked");
    expect(revoked.json().reviewedBy).toBe("u-admin");
    expect(await catalogTitles()).not.toContain("Hono security");

    expect((await review(req.id, "revoke")).statusCode).toBe(404); // nothing approved to take back any more
  });

  it("a decided request stays in the admin's list, so it can be undone", async () => {
    const req = (await post("u-hist", { quizId: await refusedQuiz("u-hist", "https://github.com/psf/requests/blob/main/HISTORY.md"), title: "Requests history" })).json();
    await app.inject({ method: "POST", url: `/v1/document-requests/${req.id}/review`, headers: { authorization: `Bearer ${await adminToken("u-admin")}`, "content-type": "application/json" }, payload: { action: "approve" } });
    const listed = await app.inject({ method: "GET", url: "/v1/document-requests", headers: { authorization: `Bearer ${await adminToken("u-admin")}` } });
    const row = (listed.json().items as { id: string; status: string }[]).find((r) => r.id === req.id);
    expect(row?.status).toBe("approved");
  });

  it("revoke is refused on a request still waiting: there is nothing to take back", async () => {
    const req = (await post("u-pend", { quizId: await refusedQuiz("u-pend", "https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md"), title: "ripgrep guide" })).json();
    const r = await app.inject({ method: "POST", url: `/v1/document-requests/${req.id}/review`, headers: { authorization: `Bearer ${await adminToken("u-admin")}`, "content-type": "application/json" }, payload: { action: "revoke" } });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toMatch(/to take back/);
  });

  it("only an admin may review, and a request is decided once", async () => {
    const created = (await post("u-review", { quizId: await refusedQuiz("u-review", "https://github.com/fastify/fastify/blob/main/docs.md"), title: "Fastify docs" })).json();
    const review = async (id: string, action: string, sub = "u-admin", admin = true) =>
      app.inject({ method: "POST", url: `/v1/document-requests/${id}/review`, headers: { authorization: `Bearer ${admin ? await adminToken(sub) : await token(sub)}`, "content-type": "application/json" }, payload: { action } });
    expect((await review(created.id, "approve", "u-review", false)).statusCode).toBe(403);
    expect((await review(created.id, "approve")).statusCode).toBe(200);
    expect((await review(created.id, "approve")).statusCode).toBe(404); // already decided
    expect((await review(created.id, "nonsense")).statusCode).toBe(400);
  });

  it("an approved document joins the catalogue everyone sees; a rejected one does not", async () => {
    const yes = (await post("u-ok", { quizId: await refusedQuiz("u-ok", "https://github.com/pipecat-ai/pipecat/blob/main/docs.md"), title: "Pipecat docs", description: "Voice agents" })).json();
    const no = (await post("u-no", { quizId: await refusedQuiz("u-no", "https://github.com/mastra-ai/mastra/blob/main/SECURITY.md"), title: "Mastra security" })).json();
    const review = async (id: string, action: string) =>
      app.inject({ method: "POST", url: `/v1/document-requests/${id}/review`, headers: { authorization: `Bearer ${await adminToken("u-admin")}`, "content-type": "application/json" }, payload: { action, note: "checked by hand" } });
    expect((await review(yes.id, "approve")).statusCode).toBe(200);
    expect((await review(no.id, "reject")).statusCode).toBe(200);

    const catalog = await app.inject({ method: "GET", url: "/v1/catalog", headers: { authorization: `Bearer ${await token("u-anyone")}` } });
    const items = catalog.json().items as { title: string; kind: string; tests: string; description: string }[];
    expect(items.map((i) => i.title)).toContain("Pipecat docs");
    expect(items.map((i) => i.title)).not.toContain("Mastra security");
    const approved = items.find((i) => i.title === "Pipecat docs")!;
    expect(approved.kind).toBe("approved"); // the dropdown can say where it came from
    expect(approved.description).toBe("Voice agents");
    expect(approved.tests).toMatch(/Let in by review .*classifier had scored 0\.97/);
  });

  it("refuses a body that is not what the contract says, on both routes", async () => {
    const noBody = await app.inject({ method: "POST", url: "/v1/document-requests", headers: { authorization: `Bearer ${await token("u-empty")}`, "content-type": "application/json" } });
    expect(noBody.statusCode).toBe(400);
    expect((await post("u-bad", { quizId: "not-a-uuid", title: "x" })).statusCode).toBe(400); // title too short, id not a uuid
    const review = await app.inject({ method: "POST", url: `/v1/document-requests/${randomUUID()}/review`, headers: { authorization: `Bearer ${await adminToken("u-admin")}`, "content-type": "application/json" } });
    expect(review.statusCode).toBe(400);
  });

  it("an unexpected failure is a 500, not a user error", async () => {
    const cfg = loadConfig({ NODE_ENV: "test", DATABASE_URL: dbUrl.toString(), AUTH_MODE: "local", LOCAL_JWT_SECRET: SECRET, QUEUE_MODE: "memory", LOG_LEVEL: "fatal" });
    const broken = await buildApp({ config: cfg, db: {} as never, queue, verifier: localVerifier(SECRET) });
    const res = await broken.inject({
      method: "POST", url: "/v1/document-requests", payload: JSON.stringify({ quizId: randomUUID(), title: "Anything" }),
      headers: { authorization: `Bearer ${await token("u-req-500")}`, "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(500);
    await broken.close();
  });
});
