/**
 * Asking for a document the classifier rejected, and reviewing those asks.
 *
 * Why this exists at all: the classifier scores some real READMEs above the block threshold (measured: 6 of
 * 722), so a rejection is not proof of an attack and the user must not be left at a dead end.
 *
 * Why the request records the FINDING -- the detector score and the excerpt -- rather than just the user's
 * words: an approval puts the document in everyone's dropdown, so the reviewer has to judge the document,
 * not the asking. And why a reviewer sees decided requests too, not only the waiting ones: an approval stays
 * in force until somebody takes it back, and you cannot revoke what the list does not show you.
 */
import { CreateDocumentRequestBodySchema, ReviewDocumentRequestBodySchema } from "@quizforge/core";
import { createDocumentRequest, getOwnedQuiz, listDocumentRequests, reviewDocumentRequest } from "@quizforge/db";
import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { isAdmin } from "../../auth.js";
import { fail } from "../../lib/http.js";
import { classifierFinding } from "../../user-errors.js";
import type { RouteDeps } from "./deps.js";

export function documentRequestRoutes(v1: FastifyInstance, { config, db }: RouteDeps): void {
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

  /** A reviewer sees every request, decided ones included; everybody else sees only what they asked for. */
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
}
