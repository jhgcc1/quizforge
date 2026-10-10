/**
 * Publish the agent's prompts to Langfuse Prompt Management, ONLY from the pipeline, ONLY after every gate is green.
 *
 *   pull request    nothing is published (no Langfuse keys); `--dry-run` shows what the catalog holds, and a unit test makes sure
 *                   the lock file in Git matches the prompts (so a prompt change is always a visible, deliberate change)
 *   merge to main   the `publish-prompts` job runs after quality, integration, e2e, promptfoo (offline) and llm-eval (real model,
 *                   promptfoo live). A prompt whose text differs from the latest version labelled `production` in Langfuse becomes
 *                   a NEW version, labelled `production` and `sha-<commit>`, with the PROMPT_VERSION and the commit in its config.
 *
 * Usage (from the repo root):
 *   pnpm prompts:publish -- --dry-run     list the catalog (no network)
 *   pnpm prompts:publish                   publish (needs LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL)
 *   pnpm prompts:lock                      rewrite prompts/prompts.lock.json after a deliberate prompt change (bump PROMPT_VERSION first)
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { PROMPT_CATALOG, PROMPT_VERSION, currentLock, hashPrompt, type CatalogPrompt } from "@quizforge/llm";

export const LOCK_PATH = new URL("../../prompts/prompts.lock.json", import.meta.url);

/** The two calls we need from Langfuse (the real client is adapted below; tests pass a fake). */
export interface PromptApi {
  latest(name: string): Promise<{ text: string; version: number } | undefined>;
  create(p: { name: string; text: string; labels: string[]; config: Record<string, unknown>; commitMessage: string }): Promise<{ version: number }>;
}

export interface PublishRow {
  name: string;
  action: "published" | "unchanged" | "would-publish";
  version?: number;
}

export async function publishPrompts(api: PromptApi | undefined, opts: { sha?: string; message?: string; prompts?: readonly CatalogPrompt[] } = {}): Promise<PublishRow[]> {
  const rows: PublishRow[] = [];
  for (const p of opts.prompts ?? PROMPT_CATALOG) {
    if (!api) {
      rows.push({ name: p.name, action: "would-publish" });
      continue;
    }
    const latest = await api.latest(p.name);
    if (latest && latest.text === p.text) {
      rows.push({ name: p.name, action: "unchanged", version: latest.version });
      continue;
    }
    const sha = opts.sha ?? "local";
    const created = await api.create({
      name: p.name,
      text: p.text,
      labels: ["production", `sha-${sha.slice(0, 7)}`],
      config: { promptVersion: PROMPT_VERSION, gitSha: sha, hash: hashPrompt(p.text), source: "git" },
      commitMessage: opts.message ?? `Published by the pipeline from ${sha.slice(0, 7)} (prompt version ${PROMPT_VERSION})`,
    });
    rows.push({ name: p.name, action: "published", version: created.version });
  }
  return rows;
}

export const summaryTable = (rows: PublishRow[]): string =>
  ["### Prompts → Langfuse", "", "| Prompt | Result | Version |", "|---|---|---:|", ...rows.map((r) => `| \`${r.name}\` | ${r.action} | ${r.version ?? ""} |`)].join("\n");

async function realApi(): Promise<PromptApi> {
  const { LangfuseClient } = await import("@langfuse/client");
  const lf = new LangfuseClient({ publicKey: process.env.LANGFUSE_PUBLIC_KEY!, secretKey: process.env.LANGFUSE_SECRET_KEY!, ...(process.env.LANGFUSE_BASE_URL ? { baseUrl: process.env.LANGFUSE_BASE_URL } : {}) });
  return {
    async latest(name) {
      try {
        const p = await lf.prompt.get(name, { type: "text", label: "production", cacheTtlSeconds: 0 });
        return { text: p.prompt, version: p.version };
      } catch (err) {
        if (/not found|404/i.test(String((err as Error).message))) return undefined;
        throw err;
      }
    },
    async create(p) {
      const made = await lf.prompt.create({ name: p.name, type: "text", prompt: p.text, labels: p.labels, config: p.config, commitMessage: p.commitMessage });
      return { version: made.version };
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--write-lock")) {
    writeFileSync(LOCK_PATH, JSON.stringify(currentLock(), null, 2) + "\n");
    console.log(`wrote ${LOCK_PATH.pathname}`);
    return;
  }
  const dry = args.includes("--dry-run");
  if (!dry && !(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY)) throw new Error("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required (use --dry-run to only list the catalog)");
  const rows = await publishPrompts(dry ? undefined : await realApi(), { sha: process.env.GITHUB_SHA ?? "local" });
  const table = summaryTable(rows);
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table + "\n");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();

export const readLock = () => JSON.parse(readFileSync(LOCK_PATH, "utf8")) as { promptVersion: string; prompts: Record<string, string> };
