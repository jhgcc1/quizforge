/**
 * The two plugins that apply to every request: security headers and the rate limit.
 *
 * The rate limit is keyed on the authenticated user when there is one and on the IP otherwise, and it runs at
 * `preHandler` rather than `onRequest` for exactly that reason: the auth hook must have run first, or every
 * request from behind one NAT would share a bucket. Creating routes narrow it further with their own
 * `config.rateLimit`, because creating a quiz costs a model call and reading one does not.
 */
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";

export async function registerSecurity(app: FastifyInstance, config: Config): Promise<void> {
  // contentSecurityPolicy off: this serves JSON and one Swagger page, and a CSP here would only break that page.
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    hook: "preHandler",
    keyGenerator: (req) => req.user?.sub ?? req.ip,
    // @fastify/rate-limit THROWS what this returns, so it has to look like an error to the error handler:
    // `statusCode` decides the status (without it the handler sees none and answers 500, which is what this
    // API did until the refactor that split this file out), and `error` is already the API's body shape,
    // which registerErrorHandling passes through so the client still sees `code: "rate_limited"`.
    errorResponseBuilder: (req, ctx) => ({
      statusCode: 429,
      error: { code: "rate_limited", message: `Too many requests, retry in ${Math.ceil(ctx.ttl / 1000)}s`, requestId: req.id },
    }),
  });
}
