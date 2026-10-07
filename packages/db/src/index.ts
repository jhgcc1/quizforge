import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export * as schema from "./schema.js";

export function createDb(connectionString: string, opts: { max?: number } = {}) {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10, connectionTimeoutMillis: 10_000 });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>["db"];
export * from "./repo.js";

// Re-exported so apps and tests share ONE drizzle-orm instance (duplicates break the types).
export { and, eq, sql } from "drizzle-orm";
export { migrate } from "drizzle-orm/node-postgres/migrator";
export * from "./url.js";
