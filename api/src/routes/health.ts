/**
 * The two probes, both unauthenticated and both exempt from the rate limit: a load balancer that got a 429
 * would take the task out of service for being busy.
 *
 * They answer different questions on purpose. `/healthz` is liveness — the process is up and serving, which
 * is all ECS needs to decide whether to restart it. `/readyz` is readiness — it touches the database, so a
 * task that is running but cannot reach Postgres is pulled out of the load balancer instead of answering
 * every request with a 500.
 */
import type { FastifyInstance } from "fastify";
import type { Db } from "@quizforge/db";
import { fail } from "../lib/http.js";

export const noLimit = { config: { rateLimit: false } };

export function healthRoutes(app: FastifyInstance, deps: { db: Db; ping?: (() => Promise<void>) | undefined }): void {
  app.get("/healthz", noLimit, async () => ({ status: "ok" }));

  app.get("/readyz", noLimit, async (req, reply) => {
    try {
      await (deps.ping ? deps.ping() : deps.db.execute("select 1"));
      return { status: "ready" };
    } catch (err) {
      req.log.error({ err }, "readiness check failed");
      return fail(reply, 503, "not_ready", "Database unavailable");
    }
  });
}
