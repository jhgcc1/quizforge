/**
 * Builds the API. It registers things; it implements nothing.
 *
 * The order below is the one Fastify's guide asks for — ecosystem plugins, then our own, then hooks, then
 * routes — and it is load-bearing twice over: the rate limit keys on `req.user`, so the auth hook has to be
 * registered before it runs, and the `/v1` scope exists so that authentication guards every route inside it
 * by construction rather than by a list somebody has to remember to update. `/healthz`, `/readyz`,
 * `/openapi.json` and `/docs` are outside that scope, which is exactly why they stay public.
 *
 * `buildApp` returns the instance without listening. `server.ts` is what opens a port, and that split is
 * what lets `app.int.test.ts` run the whole API against a real Postgres with `app.inject` and no socket.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { Db } from "@quizforge/db";
import type { AuthUser, TokenVerifier } from "./auth.js";
import type { Config } from "./config.js";
import { registerAuth } from "./plugins/auth-hook.js";
import { registerErrorHandling } from "./plugins/errors.js";
import { registerSecurity } from "./plugins/security.js";
import { docsRoutes } from "./routes/docs.js";
import { healthRoutes } from "./routes/health.js";
import { attemptRoutes } from "./routes/v1/attempts.js";
import { catalogRoutes } from "./routes/v1/catalog.js";
import type { RouteDeps } from "./routes/v1/deps.js";
import { documentRequestRoutes } from "./routes/v1/document-requests.js";
import { quizRoutes } from "./routes/v1/quizzes.js";
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

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, queue, verifier } = deps;
  const routeDeps: RouteDeps = { config, db, queue, reenqueueAfterMs: deps.reenqueueAfterMs ?? 5000 };

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: { paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'], censor: "[redacted]" },
    },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 16 * 1024,
    // A caller's own request id is kept so a trace spans the front end and the API, but only if it looks like
    // an id: an unchecked header ends up in every log line, and that is a log-injection hole.
    genReqId: (req) => {
      const h = req.headers["x-request-id"] ?? req.headers["x-amzn-trace-id"];
      const v = Array.isArray(h) ? h[0] : h;
      return v && /^[\w\-=;:.,/ ]{1,200}$/.test(v) ? v : randomUUID();
    },
  });

  registerErrorHandling(app);
  await registerSecurity(app, config);

  /* ---------- public, unauthenticated ---------- */
  healthRoutes(app, { db, ping: deps.ping });
  docsRoutes(app);

  /* ---------- authenticated /v1 ---------- */
  app.register(
    async (v1) => {
      registerAuth(v1, verifier);
      quizRoutes(v1, routeDeps);
      attemptRoutes(v1, routeDeps);
      catalogRoutes(v1, routeDeps);
      documentRequestRoutes(v1, routeDeps);
    },
    { prefix: "/v1" },
  );

  return app;
}
