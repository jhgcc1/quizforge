/**
 * Taking a quiz: start an attempt, save answers as the user goes, submit it.
 *
 * Two properties this file exists to keep. First, an attempt is idempotent per key AND per quiz: the same
 * `Idempotency-Key` reused against a different quiz is a 422, not a silent second attempt on the wrong one.
 * Second, saving an answer is safe to retry in any order — a save that arrives after a newer revision is
 * already stored answers `200 {status:"ignored"}` rather than failing, because the client's retry is
 * correct behaviour on a flaky connection and must not look like an error to the user.
 */
import { SaveAnswerBodySchema, requestFingerprint } from "@quizforge/core";
import {
  findAttemptByKey,
  getAttemptProgress,
  getAttemptResult,
  getOrCreateAttempt,
  getOwnedQuiz,
  saveAnswer,
  submitAttempt,
} from "@quizforge/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fail, idemKey, uuid } from "../../lib/http.js";
import type { RouteDeps } from "./deps.js";

export function attemptRoutes(v1: FastifyInstance, { db }: RouteDeps): void {
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
    // A replay returns the answers already saved, so a client that lost its reply resumes where it was.
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
    // Once submitted the attempt turns into its result: the answer key is only ever revealed here.
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
    // Submitting twice is not an error: the second call replays the first result rather than re-scoring.
    const res = await submitAttempt(db, { attemptId: req.params.id, userSub: req.user!.sub });
    if (res.status === "not_found") return fail(reply, 404, "not_found", "Attempt not found");
    if (res.replayed) reply.header("idempotency-replayed", "true");
    return { replayed: res.replayed, result: res.result };
  });
}
