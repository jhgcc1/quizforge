import { fileURLToPath } from "node:url";
import pg from "pg";
import { createDb, migrate } from "@quizforge/db";

const ADMIN = "postgres://quizforge:quizforge@localhost:5433/postgres";
const DB_NAME = "quizforge_e2e";

/** Runs BEFORE Playwright starts the stack (webServers start before globalSetup). Fresh database for every run, then the real migrations. Also makes sure the SQS queue is reachable. */
async function prepare() {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.query(`create database ${DB_NAME}`);
  await admin.end();
  const { db, pool } = createDb(`postgres://quizforge:quizforge@localhost:5433/${DB_NAME}`, { max: 2 });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../packages/db/migrations", import.meta.url)) });
  await pool.end();

  const res = await fetch("http://localhost:9324/?Action=ListQueues").catch(() => undefined);
  if (!res?.ok) throw new Error("ElasticMQ is not running on :9324 — run `pnpm db:up` first");
}

prepare().catch((e) => {
  console.error(e);
  process.exit(1);
});
