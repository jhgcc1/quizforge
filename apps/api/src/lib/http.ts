/**
 * The two things every route in this API needs and must do identically: fail in one shape, and read the
 * idempotency key the same way.
 *
 * Why `fail` is here rather than per route: the error body is part of the public contract
 * (`ErrorBodySchema` in @quizforge/contract) and the front end branches on `error.code`. A route that
 * invented its own shape would break a client silently, so there is exactly one way to say no.
 */
import { IdempotencyKeySchema } from "@quizforge/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

/** Route params are compared against this before they ever reach the database. */
export const uuid = z.string().uuid();

/**
 * The one error shape: `{ error: { code, message, details?, requestId } }`.
 * `requestId` is the id Fastify put on the request, so a user can quote it and it is found in the logs.
 */
export function fail(reply: FastifyReply, status: number, code: string, message: string, details?: unknown): FastifyReply {
  return reply.status(status).send({ error: { code, message, ...(details ? { details } : {}), requestId: reply.request.id } });
}

/**
 * The `Idempotency-Key` header, or `undefined` after a 400 has already been sent.
 *
 * Returning undefined and replying at the same time is the shape the callers want: a creating route reads
 * `const key = idemKey(req, reply); if (!key) return;` and never has to repeat the message. The key is
 * REQUIRED on every route that creates something, because a retried POST must not create a second row.
 */
export function idemKey(req: FastifyRequest, reply: FastifyReply): string | undefined {
  const parsed = IdempotencyKeySchema.safeParse(req.headers["idempotency-key"]);
  if (!parsed.success) {
    fail(reply, 400, "idempotency_key_required", "Send a unique Idempotency-Key header (8-128 chars of [A-Za-z0-9_-:.]); reuse it when retrying");
    return undefined;
  }
  return parsed.data;
}
