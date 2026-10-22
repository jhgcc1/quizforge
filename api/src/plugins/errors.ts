/**
 * What happens when a request goes wrong, and the request id that ties it all together.
 *
 * Three rules, in one place so no route can break them:
 *   - every reply carries `x-request-id`, the same id the logs use, so a user's report maps to a log line;
 *   - an unknown route is a 404 in the API's own error shape, not Fastify's default body;
 *   - a thrown error below 500 is the client's problem and says so; 500 and above is logged with the stack
 *     and answered with "Internal error" and nothing else. A stack trace in a reply is an information leak.
 */
import type { FastifyInstance } from "fastify";
import { fail } from "../lib/http.js";

export function registerErrorHandling(app: FastifyInstance): void {
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  app.setNotFoundHandler((req, reply) => fail(reply, 404, "not_found", "Route not found"));

  app.setErrorHandler((err: Error & { statusCode?: number; error?: { code?: string } }, req, reply) => {
    // An error that already carries the API's error body is sent as it is. @fastify/rate-limit builds one
    // and throws it; re-wrapping would replace its `code` with the generic "bad_request", and the front end
    // branches on that code to tell "slow down" from "your request was wrong".
    if (err.error?.code) return reply.status(err.statusCode ?? 400).send({ error: err.error });
    if (err.statusCode && err.statusCode < 500) return fail(reply, err.statusCode, "bad_request", err.message);
    req.log.error({ err }, "unhandled error");
    return fail(reply, 500, "internal", "Internal error");
  });
}
