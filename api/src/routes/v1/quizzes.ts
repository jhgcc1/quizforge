/**
 * Creating, listing and reading quizzes.
 *
 * `POST /quizzes` is the only route in the API that costs money, and most of its length is the reason why:
 * the same `Idempotency-Key` must never produce a second quiz, and a lost SQS publish must not leave a row
 * stuck in `queued` for ever. So the order is deliberate —
 *
 *   1. the key is required, and a replay of it returns the FIRST quiz, never a new one;
 *   2. the URL is checked twice, as the user sent it and as the raw form it is rewritten to, because the
 *      allow-list has to hold for both and a rewrite is exactly where a host check gets skipped;
 *   3. the request is fingerprinted, so the same key with a different body is a 422 rather than a surprise;
 *   4. the quota is counted before anything is written;
 *   5. the row is created and only then published. If the publish fails the row stays `queued`, the client
 *      retries with the same key, and the replay path publishes it again. The sweeper is the backstop.
 */
import { CreateQuizBodyStrictSchema, requestFingerprint } from "@quizforge/core";
import {
  countRecentQuizzes,
  createQuizIdempotent,
  findQuizByKey,
  getOwnedQuiz,
  getPublicQuestions,
  listAttemptsByQuiz,
  listAttemptsForQuiz,
  listQuizzes,
  type QuizRow,
} from "@quizforge/db";
import { SourceError, assertAllowedUrl, toRawUrl } from "@quizforge/llm/source";
import type { FastifyInstance } from "fastify";
import { fail, idemKey, uuid } from "../../lib/http.js";
import { attemptRow, progress, summary } from "../../lib/presenters.js";
import type { RouteDeps } from "./deps.js";

export function quizRoutes(v1: FastifyInstance, { config, db, queue, reenqueueAfterMs }: RouteDeps): void {
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

  v1.get("/quizzes", async (req) => {
    const sub = req.user!.sub;
    const rows = await listQuizzes(db, sub);
    const attempts = await listAttemptsByQuiz(db, rows.map((q) => q.id), sub); // one query for the whole list
    return { quizzes: rows.map((q) => ({ ...summary(q), progress: progress(attempts.get(q.id) ?? []) })) };
  });

  v1.get<{ Params: { id: string } }>("/quizzes/:id", async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return fail(reply, 404, "not_found", "Quiz not found");
    const quiz = await getOwnedQuiz(db, req.params.id, req.user!.sub);
    if (!quiz) return fail(reply, 404, "not_found", "Quiz not found");
    // The questions carry no answer key until the quiz is ready, and `getPublicQuestions` never returns one.
    return { quiz: summary(quiz), questions: quiz.status === "ready" ? await getPublicQuestions(db, quiz.id) : [] };
  });

  v1.get<{ Params: { id: string } }>("/quizzes/:id/attempts", async (req, reply) => {
    const sub = req.user!.sub;
    if (!uuid.safeParse(req.params.id).success) return fail(reply, 404, "not_found", "Quiz not found");
    // Ownership is checked before the attempts are read, so a valid id of somebody else's quiz is a 404 too.
    if (!(await getOwnedQuiz(db, req.params.id, sub))) return fail(reply, 404, "not_found", "Quiz not found");
    const attempts = await listAttemptsForQuiz(db, req.params.id, sub);
    return { attempts: attempts.map(attemptRow) };
  });
}
