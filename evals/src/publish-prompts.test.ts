import { describe, expect, it } from "vitest";
import { PROMPT_CATALOG, PROMPT_VERSION, currentLock } from "@quizforge/llm";
import { publishPrompts, readLock, summaryTable, type PromptApi } from "./publish-prompts.js";

/** A fake Langfuse: remembers the versions it was given. */
function fakeApi(initial: Record<string, string> = {}) {
  const store = new Map<string, { text: string; version: number; labels: string[]; config: Record<string, unknown> }[]>();
  for (const [name, text] of Object.entries(initial)) store.set(name, [{ text, version: 1, labels: ["production"], config: {} }]);
  const created: { name: string; labels: string[]; config: Record<string, unknown> }[] = [];
  const api: PromptApi = {
    latest: async (name) => store.get(name)?.at(-1),
    create: async (p) => {
      const list = store.get(p.name) ?? [];
      list.push({ text: p.text, version: list.length + 1, labels: p.labels, config: p.config });
      store.set(p.name, list);
      created.push({ name: p.name, labels: p.labels, config: p.config });
      return { version: list.length };
    },
  };
  return { api, created };
}

describe("publishing the prompts to Langfuse (only from the pipeline)", () => {
  it("the lock file in Git matches the prompts: a prompt change is always a visible, deliberate change (run `pnpm prompts:lock`)", () => {
    expect(readLock()).toEqual(currentLock());
    expect(readLock().promptVersion).toBe(PROMPT_VERSION);
  });

  it("every prompt of the catalog has a distinct name and a non-empty text", () => {
    expect(new Set(PROMPT_CATALOG.map((p) => p.name)).size).toBe(PROMPT_CATALOG.length);
    for (const p of PROMPT_CATALOG) expect(p.text.length, p.name).toBeGreaterThan(100);
  });

  it("first publish: every prompt becomes version 1 with the labels production and sha-<commit>, and the version and commit in its config", async () => {
    const { api, created } = fakeApi();
    const rows = await publishPrompts(api, { sha: "abcdef1234567890" });
    expect(rows.every((r) => r.action === "published" && r.version === 1)).toBe(true);
    expect(created).toHaveLength(PROMPT_CATALOG.length);
    expect(created[0]!.labels).toEqual(["production", "sha-abcdef1"]);
    expect(created[0]!.config).toMatchObject({ promptVersion: PROMPT_VERSION, gitSha: "abcdef1234567890", source: "git" });
  });

  it("publishing again with the same text changes nothing (idempotent: a rerun or a docs-only merge creates no version)", async () => {
    const { api, created } = fakeApi(Object.fromEntries(PROMPT_CATALOG.map((p) => [p.name, p.text])));
    const rows = await publishPrompts(api, { sha: "1234567" });
    expect(rows.every((r) => r.action === "unchanged")).toBe(true);
    expect(created).toHaveLength(0);
  });

  it("only the prompt whose text changed gets a new version", async () => {
    const initial = Object.fromEntries(PROMPT_CATALOG.map((p) => [p.name, p.text]));
    initial["quizforge/judge"] = "an older judge prompt";
    const { api, created } = fakeApi(initial);
    const rows = await publishPrompts(api, { sha: "1234567" });
    expect(created.map((c) => c.name)).toEqual(["quizforge/judge"]);
    expect(rows.find((r) => r.name === "quizforge/judge")).toMatchObject({ action: "published", version: 2 });
  });

  it("without Langfuse (a pull request, --dry-run) nothing is sent and the table says what would happen", async () => {
    const rows = await publishPrompts(undefined);
    expect(rows.every((r) => r.action === "would-publish")).toBe(true);
    expect(summaryTable(rows)).toContain("would-publish");
  });
});
