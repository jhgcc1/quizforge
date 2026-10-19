import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export * as schema from "./schema.js";

/**
 * A pool and a drizzle handle over it.
 *
 * The `error` listener is not optional. `pg.Pool` emits `error` when a client sitting IDLE in the pool loses its
 * connection — an RDS failover, a maintenance window, an administrator terminating the backend — and an `error`
 * event with no listener is an uncaught exception, which takes the process down. The pool itself recovers: the dead
 * client is discarded and the next query opens a new one. So the right behaviour is to notice and carry on, which is
 * what a default of "log it" does; `onPoolError` lets a caller route it to its own logger or metric.
 */
export function createDb(connectionString: string, opts: { max?: number; onPoolError?: (err: Error) => void } = {}) {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10, connectionTimeoutMillis: 10_000 });
  pool.on("error", (err) => (opts.onPoolError ?? defaultPoolError)(err));
  const db = drizzle(pool, { schema });
  return { db, pool };
}

/* c8 ignore next 3 -- a one-line fallback for callers that pass no handler; the handled path is what the tests cover */
function defaultPoolError(err: Error): void {
  console.error(JSON.stringify({ level: "error", msg: "idle database client failed; the pool will open a new one", err: err.message }));
}

export type Db = ReturnType<typeof createDb>["db"];
export * from "./repo.js";

// Re-exported so apps and tests share ONE drizzle-orm instance (duplicates break the types).
export { and, eq, sql } from "drizzle-orm";
export { migrate } from "drizzle-orm/node-postgres/migrator";
export * from "./url.js";
