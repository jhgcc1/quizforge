/**
 * What every `/v1` route group is handed. Passing it explicitly, rather than decorating the Fastify instance,
 * keeps each route file a plain function of its dependencies — which is why `app.int.test.ts` can build the
 * whole API against a real Postgres with an in-memory queue and no AWS.
 */
import type { Db } from "@quizforge/db";
import type { Config } from "../../config.js";
import type { QuizQueue } from "../../queue.js";

export interface RouteDeps {
  config: Config;
  db: Db;
  queue: QuizQueue;
  /** A queued quiz replayed with the same key is re-published after this long (self-heals lost messages). */
  reenqueueAfterMs: number;
}
