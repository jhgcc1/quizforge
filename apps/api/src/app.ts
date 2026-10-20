import { randomUUID } from "node:crypto";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CreateDocumentRequestBodySchema,
  CreateQuizBodyStrictSchema,
  IdempotencyKeySchema,
  SAMPLE_CATALOG,
  ReviewDocumentRequestBodySchema,
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
  approvedCatalogEntries,
  listedCatalogEntries,
  createDocumentRequest,
  getOwnedQuiz,
  getPublicQuestions,
  listAttemptsByQuiz,
  listAttemptsForQuiz,
  listDocumentRequests,
  listQuizzes,
  reviewDocumentRequest,
  saveAnswer,
  submitAttempt,
  type AttemptSummary,
  type Db,
  type QuizRow,
} from "@quizforge/db";
import { SourceError, assertAllowedUrl, toRawUrl } from "@quizforge/llm/source";
import { isAdmin, type AuthUser, type TokenVerifier } from "./auth.js";
import type { Config } from "./config.js";
import { openApiDocument, swaggerHtml } from "./openapi.js";
import { classifierFinding, userFacingError } from "./user-errors.js";
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
    user?: AuthUser;
  }
}

const uuid = z.string().uuid();

const percent = (score: number): number => (score / 4) * 100;

/** What the user did with a quiz, from its attempts (newest first): count, the open one, the last submitted score, the best score. */
function progress(attempts: AttemptSummary[]) {
  const submitted = attempts.filter((a) => a.status === "submitted" && a.finalScore !== null);
  const last = submitted.sort((a, b) => (b.submittedAt?.getTime() ?? 0) - (a.submittedAt?.getTime() ?? 0))[0];
  return {
    attempts: attempts.length,
    inProgressAttemptId: attempts.find((a) => a.status === "in_progress")?.id ?? null,
    last: last ? { attemptId: last.id, finalScore: last.finalScore!, percent: percent(last.finalScore!), submittedAt: last.submittedAt!.toISOString() } : null,
    best: submitted.length ? Math.max(...submitted.map((a) => a.finalScore!)) : null,
  };
}

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
    reviewable: q.status === "failed" && classifierFinding(q.error) !== undefined, // the client offers the review path on this, not on the wording
    createdAt: q.createdAt,
    generationProgress: generationProgress(q),
  };
}

/** Only while the worker is generating and has reported a phase; null for queued, ready and failed quizzes. */
function generationProgress(q: QuizRow) {
  if (q.status !== "generating" || q.phase === null || q.phaseStep === null || q.phaseTotal === null) return null;
  return { phase: q.phase, step: q.phaseStep, totalSteps: q.phaseTotal, ...(q.phaseDetail ? { detail: q.phaseDetail } : {}) };
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
      const body = CreateQuizBodyStrictSchema.safeParse(req.body ?? {});
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
        refresh: body.data.refresh,
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

    /**
     * The catalogue has three sources, in order of how much is known about the document:
     *   `readme`/`test` — the curated list that ships with the product
     *   `approved`      — the classifier refused it and a human decided it was fine anyway
     *   `used`          — it generated a quiz, so it is offered instead of being pasted again
     * The first entry for a URL wins, so a document that is both curated and used stays curated.
     */
    v1.get("/catalog", async () => {
      const seen = new Set<string>();
      const items = [...SAMPLE_CATALOG, ...(await approvedCatalogEntries(db)), ...(await listedCatalogEntries(db))].filter((e) =>
        seen.has(e.url) ? false : (seen.add(e.url), true),
      );
      return { items };
    });

    /**
     * Ask for a document the classifier rejected.
     *
     * The classifier scores some real READMEs above the block threshold (measured: 6 of 722), so a rejection is not proof
     * of an attack and the user should not be left at a dead end. The request records WHAT WAS FOUND -- the score and the
     * excerpt -- because an approval puts the document in everyone's dropdown, and the reviewer has to judge the document,
     * not the asking.
     */
    v1.post("/document-requests", { config: { rateLimit: { max: config.CREATE_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } } }, async (req, reply) => {
      const body = CreateDocumentRequestBodySchema.safeParse(req.body ?? {});
      if (!body.success) return fail(reply, 400, "validation_error", "Invalid request body", body.error.issues.map((i: z.ZodIssue) => ({ path: i.path.join("."), message: i.message })));
      const quiz = await getOwnedQuiz(db, body.data.quizId, req.user!.sub);
      if (!quiz) return fail(reply, 404, "not_found", "No quiz of yours with that id");
      const found = classifierFinding(quiz.error);
      if (!found) return fail(reply, 422, "not_refused_by_classifier", "That quiz was not refused by the prompt-injection classifier, so there is nothing to review");
      const created = await createDocumentRequest(db, {
        url: quiz.sourceUrl,
        title: body.data.title,
        ...(body.data.description ? { description: body.data.description } : {}),
        ...(body.data.note ? { note: body.data.note } : {}),
        requestedBy: req.user!.sub,
        detectorScore: found.score,
        excerpt: found.excerpt,
      });
      if (!created) return fail(reply, 409, "request_already_open", "Somebody already asked for this document; it is waiting for review");
      req.log.info({ documentRequestId: created.id, url: quiz.sourceUrl, score: found.score }, "document review requested");
      return reply.code(201).send(created);
    });

    /** The admin sees everything waiting; everybody else sees what they asked for. */
    // A reviewer sees every request, not only what is waiting: an approval stays in force until somebody takes it
    // back, so the decided ones have to be visible for that to be possible. Everybody else sees their own.
    v1.get("/document-requests", async (req) => ({ items: await listDocumentRequests(db, isAdmin(req.user!) ? {} : { requestedBy: req.user!.sub }) }));

    v1.post<{ Params: { id: string } }>("/document-requests/:id/review", async (req, reply) => {
      if (!isAdmin(req.user!)) return fail(reply, 403, "forbidden", "Only an administrator can review document requests");
      const body = ReviewDocumentRequestBodySchema.safeParse(req.body ?? {});
      if (!body.success) return fail(reply, 400, "validation_error", "Invalid request body", body.error.issues.map((i: z.ZodIssue) => ({ path: i.path.join("."), message: i.message })));
      const reviewed = await reviewDocumentRequest(db, { id: req.params.id, action: body.data.action, reviewedBy: req.user!.sub, ...(body.data.note ? { note: body.data.note } : {}) });
      if (!reviewed) {
        const why = body.data.action === "revoke" ? "No approved document with that id to take back" : "No request waiting for review with that id";
        return fail(reply, 404, "not_found", why);
      }
      req.log.info({ documentRequestId: reviewed.id, action: body.data.action, reviewedBy: req.user!.sub }, "document request reviewed");
      return reviewed;
    });

    v1.get("/quizzes", async (req) => {
      const sub = req.user!.sub;
      const rows = await listQuizzes(db, sub);
      const attempts = await listAttemptsByQuiz(db, rows.map((q) => q.id), sub); // one query for the whole list
      return { quizzes: rows.map((q) => ({ ...summary(q), progress: progress(attempts.get(q.id) ?? []) })) };
    });

    v1.get<{ Params: { id: string } }>("/quizzes/:id/attempts", async (req, reply) => {
      const sub = req.user!.sub;
      if (!uuid.safeParse(req.params.id).success) return fail(reply, 404, "not_found", "Quiz not found");
      if (!(await getOwnedQuiz(db, req.params.id, sub))) return fail(reply, 404, "not_found", "Quiz not found");
      const attempts = await listAttemptsForQuiz(db, req.params.id, sub);
      return { attempts: attempts.map((a) => ({ id: a.id, status: a.status, startedAt: a.startedAt.toISOString(), submittedAt: a.submittedAt?.toISOString() ?? null, finalScore: a.finalScore, percent: a.finalScore === null ? null : percent(a.finalScore) })) };
    });

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
