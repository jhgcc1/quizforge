/**
 * Who is making this request. Registered inside the `/v1` scope, so it guards every route there and none of
 * the public ones (`/healthz`, `/readyz`, `/openapi.json`, `/docs`) by construction rather than by a list
 * somebody has to remember to update.
 *
 * On success it puts the user on `req.user` and binds `userSub` to the request logger, so every line that
 * request produces afterwards says who caused it. On failure it answers 401 with `www-authenticate`, and the
 * log records only the error's NAME ("JWTExpired", "JWSSignatureVerificationFailed") -- never the token, and
 * never the claims of a token we just decided not to trust.
 */
import type { FastifyInstance } from "fastify";
import type { TokenVerifier } from "../auth.js";
import { fail } from "../lib/http.js";

export function registerAuth(scope: FastifyInstance, verifier: TokenVerifier): void {
  scope.addHook("onRequest", async (req, reply) => {
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
}
