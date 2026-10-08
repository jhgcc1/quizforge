/**
 * One-off migration runner. In AWS this runs as an ECS run-task before the services are updated
 * (never at app boot). A Postgres advisory lock prevents two runners from migrating concurrently.
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDb } from "./index.js";
import { resolveDatabaseUrl } from "./url.js";

const MIGRATION_LOCK_ID = 7_243_001;

async function main() {
  const url = resolveDatabaseUrl();
  // 2 connections: one holds the advisory lock, the other runs the migrations (max: 1 would deadlock)
  const { db, pool } = createDb(url, { max: 2 });
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
    console.log("migrations applied");
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
