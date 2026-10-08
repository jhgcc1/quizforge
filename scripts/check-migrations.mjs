#!/usr/bin/env node
// CI gate: every migration ADDED or MODIFIED in this PR must satisfy the expand/contract policy,
// and already-released migrations must never be edited (their checksum is recorded in production).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { checkMigrationSql } from "./migration-rules.mjs";

const base = process.env.BASE_REF ?? "origin/main";
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const changed = git("diff", "--name-status", `${base}...HEAD`, "--", "packages/db/migrations/").split("\n").filter(Boolean);

let bad = 0;
for (const line of changed) {
  const [status, file] = line.split(/\s+/);
  if (!file?.endsWith(".sql")) continue;
  if (status !== "A") {
    console.error(`::error file=${file}::Released migrations are immutable (${status}). Add a new migration instead.`);
    bad++;
    continue;
  }
  for (const v of checkMigrationSql(readFileSync(file, "utf8"))) {
    console.error(`::error file=${file}::${v.rule}: ${v.why}. If this is intentional and the previous release no longer depends on it, add a line "-- destructive-ok: <reason>".`);
    bad++;
  }
}
console.log(changed.length ? `checked ${changed.length} changed migration file(s)` : "no migration changes");
process.exit(bad ? 1 : 0);
