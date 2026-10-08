import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://quizforge:quizforge@localhost:5433/postgres";
const dbName = `qf_mig_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const url = new URL(ADMIN_URL);
url.pathname = `/${dbName}`;

afterAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.end();
});

/** Runs the REAL migrate entrypoint (the one ECS runs before a deploy) as a separate process. */
describe("migrate.ts entrypoint", () => {
  it("applies all migrations on an empty database, exits 0, and is safe to run twice", async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    await admin.end();

    const script = fileURLToPath(new URL("./migrate.ts", import.meta.url));
    const run = () => spawnSync("node", ["--import", "tsx", script], { env: { ...process.env, DATABASE_URL: url.toString() }, encoding: "utf8", timeout: 40_000 });
    const first = run();
    expect(first.error).toBeUndefined(); // a deadlock would surface as a spawn timeout
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("migrations applied");
    expect(run().status).toBe(0);

    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    const tables = (await c.query("select table_name from information_schema.tables where table_schema='public' order by 1")).rows.map((r) => r.table_name);
    await c.end();
    expect(tables).toEqual(expect.arrayContaining(["quizzes", "questions", "options", "attempts", "answers", "answer_selections", "eval_scores", "generation_jobs", "sources"]));
  }, 90_000);
});
