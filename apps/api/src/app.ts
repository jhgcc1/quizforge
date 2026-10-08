import { randomUUID } from "node:crypto";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CreateQuizBodySchema,
  IdempotencyKeySchema,
  SaveAnswerBodySchema,
  requestFingerprint,
} from "@quizforge/core";
import {
  countRecentQuizzes,
  createQuizIdempotent,
  findAttemptByKey,
  findQuizByKey,
  getAttemptProgress,
  getAttemptResult,
  getOrCreateAttempt,
  getOwnedQuiz,
  getPublicQuestions,
  listQuizzes,
  saveAnswer,
  submitAttempt,
  type Db,
  type QuizRow,
} from "@quizforge/db";
import { SourceError, assertAllowedUrl, toRawUrl } from "@quizforge/llm/source";
import type { TokenVerifier } from "./auth.js";
import type { Config } from "./config.js";
import { openApiDocument, swaggerHtml } from "./openapi.js";
import { userFacingError } from "./user-errors.js";
import type { QuizQueue } from "./queue.js";

export interface AppDeps {
  config: Config;
  db: Db;
  queue: QuizQueue;
  verifier: TokenVerifier;
  /** A queued quiz replayed with the same key is re-published after this long (self-heals lost messages). */
  reenqueueAfterMs?: number;
  /** Probe used by /readyz. */
  ping?: () => Promise<void>;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: { sub: string };
  }
}

const uuid = z.string().uuid();

function summary(q: QuizRow) {
  return {
    id: q.id,
    status: q.status,
    sourceUrl: q.sourceUrl,
    topic: q.topic,
    numQuestions: q.numQuestions,
    strategyRequested: q.strategyRequested,
    strategyUsed: q.strategyUsed,
    critique: q.critique,
    error: q.status === "failed" ? userFacingError(q.error) : null, // raw detail stays in the database and logs
    createdAt: q.createdAt,
  };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, queue, verifier } = deps;
  const reenqueueAfterMs = deps.reenqueueAfterMs ?? 5000;

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: { paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'], censor: "[redacted]" },
    },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 16 * 1024,
    genReqId: (req) => {
      const h = req.headers["x-request-id"] ?? req.headers["x-amzn-trace-id"];
      const v = Array.isArray(h) ? h[0] : h;
      return v && /^[\w\-=;:.,/ ]{1,200}$/.test(v) ? v : randomUUID();
    },
  });

  const fail = (reply: FastifyReply, status: number, code: string, message: string, details?: unknown) =>
    reply.status(status).send({ error: { code, message, ...(details ? { details } : {}), requestId: reply.request.id } });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    hook: "preHandler",
    keyGenerator: (req) => req.user?.sub ?? req.ip,
    errorResponseBuilder: (req, ctx) => ({ error: { code: "rate_limited", message: `Too many requests, retry in ${Math.ceil(ctx.ttl / 1000)}s`, requestId: req.id } }),
  });

  app.setNotFoundHandler((req, reply) => fail(reply, 404, "not_found", "Route not found"));
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err.statusCode && err.statusCode < 500) return fail(reply, err.statusCode, "bad_request", err.message);
    req.log.error({ err }, "unhandled error");
    return fail(reply, 500, "internal", "Internal error");
  });

  /* ---------- public, unauthenticated ---------- */
  const noLimit = { config: { rateLimit: false } };
  app.get("/healthz", noLimit, async () => ({ status: "ok" }));
  app.get("/readyz", noLimit, async (req, reply) => {
    try {
      await (deps.ping ? deps.ping() : db.execute("select 1"));
      return { status: "ready" };
    } catch (err) {
      req.log.error({ err }, "readiness check failed");
      return fail(reply, 503, "not_ready", "Database unavailable");
    }
  });
  app.get("/openapi.json", noLimit, async () => openApiDocument);
  app.get("/docs", noLimit, async (_req, reply) => reply.type("text/html").send(swaggerHtml));

  /* ---------- authenticated /v1 ---------- */
  app.register(async (v1) => {
    v1.addHook("onRequest", async (req, reply) => {
      const header = req.headers.authorization;
      const m = typeof header === "string" ? /^Bearer\s+(\S+)$/i.exec(header) : null;
      if (!m) {
        reply.header("www-authenticate", "Bearer");
        return fail(reply, 401, "unauthenticated", "Missing bearer token");
      }
      try {
        req.user = await verifier.verify(m[1]!);
        req.log = req.log.child({ userSub: req.user.sub });
      } catch (err) {
        req.log.warn({ reason: (err as Error).name }, "token rejected");
        reply.header("www-authenticate", 'Bearer error="invalid_token"');
        return fail(reply, 401, "invalid_token", "Invalid or expired token");
      }
    });

    const idemKey = (req: FastifyRequest, reply: FastifyReply): string | undefined => {
      const parsed = IdempotencyKeySchema.safeParse(req.headers["idempotency-key"]);
      if (!parsed.success) {
        fail(reply, 400, "idempotency_key_required", "Send a unique Idempotency-Key header (8-128 chars of [A-Za-z0-9_-:.]); reuse it when retrying");
        return undefined;
      }
      return parsed.data;
    };

    const enqueue = (quizId: string, requestId: string) => queue.publish({ v: 1, quizId, requestId });

    v1.post("/quizzes", { config: { rateLimit: { max: config.CREATE_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } } }, async (req, reply) => {
      const sub = req.user!.sub;
      const key = idemKey(req, reply);
      if (!key) return;
      const body = CreateQuizBodySchema.safeParse(req.body ?? {});
      if (!body.success) return fail(reply, 400, "validation_error", "Invalid request body", body.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));

      let rawUrl: string;
      try {
        const requested = body.data.sourceUrl ?? config.DEFAULT_SOURCE_URL;
        assertAllowedUrl(requested, config.allowedHosts); // validate what the user sent, not only its rewritten form
        rawUrl = toRawUrl(requested);
        assertAllowedUrl(rawUrl, config.allowedHosts);
      } catch (err) {
        if (err instanceof SourceError) return fail(reply, 400, err.code === "host_not_allowed" ? "source_host_not_allowed" : "source_url_invalid", err.message);
        throw err;
      }

      const hash = requestFingerprint({ sourceUrl: rawUrl, topic: body.data.topic, numQuestions: body.data.numQuestions, strategy: body.data.strategy, critique: body.data.critique });
      const replay = async (quiz: QuizRow) => {
        if (quiz.requestHash !== hash) return fail(reply, 422, "idempotency_key_reuse", "This Idempotency-Key was already used with a different request body");
        if (quiz.status === "queued" && Date.now() - quiz.createdAt.getTime() >= reenqueueAfterMs) {
          try {
            await enqueue(quiz.id, req.id);
          } catch (err) {
            req.log.error({ err, quizId: quiz.id }, "re-enqueue failed");
            reply.header("retry-after", "2");
            return fail(reply, 503, "queue_unavailable", "Could not queue the quiz, retry with the same Idempotency-Key");
          }
        }
        return reply.header("idempotency-replayed", "true").status(200).send({ quiz: summary(quiz) });
      };

      const existing = await findQuizByKey(db, sub, key);
      if (existing) return replay(existing);

      const used = await countRecentQuizzes(db, sub, new Date(Date.now() - 24 * 3600 * 1000));
      if (used >= config.DAILY_QUIZ_QUOTA) {
        return fail(reply, 429, "quota_exceeded", `Daily limit of ${config.DAILY_QUIZ_QUOTA} quizzes reached`);
      }

      const { quiz, created } = await createQuizIdempotent(db, {
        ownerSub: sub,
        sourceUrl: rawUrl,
        topic: body.data.topic,
        numQuestions: body.data.numQuestions,
        strategy: body.data.strategy,
        critique: body.data.critique,
        idempotencyKey: key,
        requestHash: hash,
      });
      if (!created) return replay(quiz); // lost the race to an identical concurrent request
      try {
        await enqueue(quiz.id, req.id);
      } catch (err) {
        // The row exists as `queued`; the client retries with the same key and that replay re-publishes it.
        req.log.error({ err, quizId: quiz.id }, "enqueue failed");
        reply.header("retry-after", "2");
        return fail(reply, 503, "queue_unavailable", "Could not queue the quiz, retry with the same Idempotency-Key");
      }
      req.log.info({ quizId: quiz.id }, "quiz queued");
      return reply.status(202).header("location", `/v1/quizzes/${quiz.id}`).send({ quiz: summary(quiz) });
    });

    v1.get("/quizzes", async (req) => ({ quizzes: (await listQuizzes(db, req.user!.sub)).map(summary) }));

    v1.get<{ Params: { id: string } }>("/quizzes/:id", async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return fail(reply, 404, "not_found", "Quiz not found");
      const quiz = await getOwnedQuiz(db, req.params.id, req.user!.sub);
      if (!quiz) return fail(reply, 404, "not_found", "Quiz not found");
      return { quiz: summary(quiz), questions: quiz.status === "ready" ? await getPublicQuestions(db, quiz.id) : [] };
    });

    v1.post<{ Params: { id: string } }>("/quizzes/:id/attempts", async (req, reply) => {
      const sub = req.user!.sub;
      const key = idemKey(req, reply);
      if (!key) return;
      if (!uuid.safeParse(req.params.id).success) return fail(reply, 404, "not_found", "Quiz not found");
      const quiz = await getOwnedQuiz(db, req.params.id, sub);
      if (!quiz) return fail(reply, 404, "not_found", "Quiz not found");
      if (quiz.status !== "ready") return fail(reply, 409, "quiz_not_ready", `Quiz is ${quiz.status}`);

      const hash = requestFingerprint({ quizId: quiz.id });
      const byKey = await findAttemptByKey(db, sub, key);
      if (byKey && (byKey.requestHash !== hash || byKey.quizId !== quiz.id)) {
        return fail(reply, 422, "idempotency_key_reuse", "This Idempotency-Key was already used for a different request");
      }
      const { attempt, created } = await getOrCreateAttempt(db, { quizId: quiz.id, userSub: sub, idempotencyKey: key, requestHash: hash });
      const progress = await getAttemptProgress(db, attempt.id, sub);
      if (!created) reply.header("idempotency-replayed", "true");
      return reply.status(created ? 201 : 200).send({
        attempt: { id: attempt.id, quizId: attempt.quizId, status: attempt.status, startedAt: attempt.startedAt },
        answers: progress?.answers ?? [],
      });
    });

    v1.get<{ Params: { id: string } }>("/attempts/:id", async (req, reply) => {
      const sub = req.user!.sub;
      if (!uuid.safeParse(req.params.id).success) return fail(reply, 404, "not_found", "Attempt not found");
      const progress = await getAttemptProgress(db, req.params.id, sub);
      if (!progress) return fail(reply, 404, "not_found", "Attempt not found");
      if (progress.attempt.status === "submitted") return { result: await getAttemptResult(db, req.params.id, sub) };
      const a = progress.attempt;
      return { attempt: { id: a.id, quizId: a.quizId, status: a.status, startedAt: a.startedAt }, answers: progress.answers };
    });

    v1.put<{ Params: { id: string; questionId: string } }>("/attempts/:id/answers/:questionId", async (req, reply) => {
      const ids = z.object({ id: uuid, questionId: uuid }).safeParse(req.params);
      if (!ids.success) return fail(reply, 404, "not_found", "Attempt or question not found");
      const body = SaveAnswerBodySchema.safeParse(req.body);
      if (!body.success) return fail(reply, 400, "validation_error", "Invalid request body", body.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
      const res = await saveAnswer(db, { attemptId: ids.data.id, userSub: req.user!.sub, questionId: ids.data.questionId, ...body.data });
      switch (res.status) {
        case "applied":
          return { status: "saved" };
        case "stale":
          return { status: "ignored", reason: "a newer revision is already stored" }; // success: retries are safe
        case "not_found":
          return fail(reply, 404, "not_found", "Attempt or question not found");
        case "attempt_submitted":
          return fail(reply, 409, "attempt_submitted", "This attempt was already submitted");
        case "invalid":
          return fail(reply, 422, "invalid_answer", res.reason);
      }
    });

    v1.post<{ Params: { id: string } }>("/attempts/:id/submit", async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return fail(reply, 404, "not_found", "Attempt not found");
      const res = await submitAttempt(db, { attemptId: req.params.id, userSub: req.user!.sub });
      if (res.status === "not_found") return fail(reply, 404, "not_found", "Attempt not found");
      if (res.replayed) reply.header("idempotency-replayed", "true");
      return { replayed: res.replayed, result: res.result };
    });
  }, { prefix: "/v1" });

  return app;
}
