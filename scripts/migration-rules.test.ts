import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM module shared with the CI script
import { checkMigrationSql } from "./migration-rules.mjs";

const rules = (sql: string): string[] => checkMigrationSql(sql).map((v: { rule: string }) => v.rule);

describe("migration policy (expand/contract)", () => {
  it("allows additive changes", () => {
    expect(rules('CREATE TABLE "x" ("id" uuid);\n--> statement-breakpoint\nALTER TABLE "x" ADD COLUMN "y" text;\nCREATE INDEX i ON x (y);')).toEqual([]);
    expect(rules('ALTER TABLE "quizzes" ADD COLUMN "request_hash" text NOT NULL DEFAULT \'\';')).toEqual([]);
  });
  it.each([
    ["DROP TABLE x;", "drop-table"],
    ['ALTER TABLE "x" DROP COLUMN "y";', "drop-column"],
    ['ALTER TABLE "x" RENAME COLUMN "a" TO "b";', "rename"],
    ['ALTER TABLE "x" RENAME TO "z";', "rename"],
    ['ALTER TABLE "x" ALTER COLUMN "a" SET DATA TYPE integer USING a::integer;', "alter-type"],
    ['ALTER TABLE "x" ALTER COLUMN "a" TYPE integer;', "alter-type"],
    ['ALTER TABLE "x" ALTER COLUMN "a" SET NOT NULL;', "set-not-null"],
    ["TRUNCATE x;", "truncate"],
    ["DROP SCHEMA public CASCADE;", "drop-schema-or-db"],
  ])("rejects %s", (sql, rule) => {
    expect(rules(sql)).toContain(rule);
  });
  it("is case-insensitive and sees statements after breakpoints", () => {
    expect(rules('CREATE TABLE a (id int);\n--> statement-breakpoint\ndrop table a;')).toContain("drop-table");
  });
  it("accepts an explicit, reasoned opt-in, but not an empty one", () => {
    expect(rules("-- destructive-ok: column unused since release 12\nALTER TABLE x DROP COLUMN y;")).toEqual([]);
    expect(rules("-- destructive-ok:\nALTER TABLE x DROP COLUMN y;")).toContain("drop-column");
  });
  it("ignores keywords inside comments", () => {
    expect(rules("-- we used to DROP TABLE x here\nALTER TABLE y ADD COLUMN z int;")).toEqual([]);
  });
  it("the migrations already in the repo satisfy their own policy (initial schema is additive)", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL("../packages/db/migrations/", import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
      expect(rules(readFileSync(new URL(f, dir), "utf8")), f).toEqual([]);
    }
  });
});
