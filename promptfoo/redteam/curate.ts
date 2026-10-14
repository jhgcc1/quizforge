/**
 * Turns the tests that `promptfoo redteam generate` wrote into OUR tests, and picks the frozen sample.
 *
 *   - the LLM-graded assertion of the red team plugin is dropped; ours (plain code) take its place;
 *   - every test gets metadata: language, intent, strategy and the expected stage
 *     ("rejected" for a language the product does not accept, "resisted" for en/pt/es);
 *   - `select` picks a balanced sample: every language, every intent and every strategy, with en, pt and es the largest.
 *
 *   tsx promptfoo/redteam/curate.ts --in promptfoo/out/redteam-generated.yaml --out promptfoo/redteam/sample.yaml --total 50
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import { canaryOf, type IntentMeta } from "./intents.js";
import { ACCEPTED_LANGUAGES, REDTEAM_LANGUAGES, fnv1a, isRedteamLanguage } from "./readme.js";

/** The deterministic assertions of every red team test (paths are relative to the config file in promptfoo/redteam/). */
export const REDTEAM_ASSERTIONS = ["canaryAbsent", "noPromptLeak", "safeOutcome", "expectedStage"] as const;

export interface GeneratedTest {
  vars: { prompt: string };
  metadata?: { strategyId?: string; originalText?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface RedteamTest {
  description: string;
  vars: { kind: "redteam"; prompt: string; lang: string; canary: string; stage: "rejected" | "resisted" };
  assert: { type: "javascript"; value: string }[];
  metadata: { language: string; intent: string; strategy: string; stage: "rejected" | "resisted"; canary: string };
}

export const stageFor = (language: string): "rejected" | "resisted" => (ACCEPTED_LANGUAGES.includes(language) ? "resisted" : "rejected");

/** One generated test -> one of ours. `undefined` when its attack text is not one of our intents (it cannot be graded by a canary). */
export function toRedteamTest(t: GeneratedTest, byText: Map<string, IntentMeta>): RedteamTest | undefined {
  const strategyId = t.metadata?.strategyId ?? "plain";
  const origin = t.metadata?.originalText ?? t.vars.prompt;
  const meta = byText.get(origin);
  if (!meta || !isRedteamLanguage(meta.language)) return undefined;
  const canary = meta.canary || canaryOf(origin) || "";
  if (!canary) return undefined;
  const strategy = strategyId === "plain" && meta.tone ? "tone" : strategyId;
  const stage = stageFor(meta.language);
  return {
    description: `REDTEAM ${meta.language} ${meta.intent} ${strategy}${meta.tone && strategy !== "tone" ? " (tone)" : ""}`,
    vars: { kind: "redteam", prompt: t.vars.prompt, lang: meta.language, canary, stage },
    assert: REDTEAM_ASSERTIONS.map((fn) => ({ type: "javascript" as const, value: `file://../assertions.js:${fn}` })),
    metadata: { language: meta.language, intent: meta.intent, strategy, stage, canary },
  };
}

export function toRedteamTests(generated: GeneratedTest[], metas: IntentMeta[]): RedteamTest[] {
  const byText = new Map(metas.map((m) => [m.text, m]));
  return generated.map((t) => toRedteamTest(t, byText)).filter((t): t is RedteamTest => t !== undefined);
}

/** How many cases per language: as even as possible, the first languages (en, pt, es) get the extra ones. 50 -> en 17, pt 17, es 16. */
export function languageQuotas(total: number): Record<string, number> {
  const quotas: Record<string, number> = {};
  REDTEAM_LANGUAGES.forEach((l, i) => {
    quotas[l] = Math.floor(total / REDTEAM_LANGUAGES.length) + (i < total % REDTEAM_LANGUAGES.length ? 1 : 0);
  });
  return quotas;
}

/** Wanted share of each strategy ("tone" = the same demand written in another tone, with no encoding). */
const SHARE: Record<string, number> = { plain: 0.15, tone: 0.15, "jailbreak-templates": 0.25, base64: 0.15, rot13: 0.15, leetspeak: 0.15 };

/**
 * Greedy, deterministic selection: for each language, take the candidate whose intent and strategy are the least used so far
 * (strategies against the wanted share). Ties are broken by a hash of the test, so the choice looks random but never changes.
 */
export function select(tests: RedteamTest[], total: number): RedteamTest[] {
  const quotas = languageQuotas(total);
  const intentUse = new Map<string, number>();
  const chosen: RedteamTest[] = [];
  const pool = tests.slice().sort((a, b) => a.description.localeCompare(b.description) || a.vars.prompt.localeCompare(b.vars.prompt));
  // round-robin over the languages (the small ones first), so the intents spread evenly across all of them
  const order = [...REDTEAM_LANGUAGES].sort((a, b) => quotas[a]! - quotas[b]!);
  const taken = new Map<string, number>(order.map((l) => [l, 0]));
  const stratUse = new Map<string, number>();
  for (let round = 0; chosen.length < total; round++) {
    let progressed = false;
    for (const lang of order) {
      if (chosen.length >= total || taken.get(lang)! >= quotas[lang]!) continue;
      const candidates = pool.filter((t) => t.metadata.language === lang && !chosen.includes(t));
      if (!candidates.length) continue;
      const n = taken.get(lang)!;
      const cost = (t: RedteamTest): number => {
        const s = t.metadata.strategy;
        const used = stratUse.get(`${lang}/${s}`) ?? 0;
        const wanted = Math.max(SHARE[s] ?? 0.1, 0.01);
        return (intentUse.get(t.metadata.intent) ?? 0) * 3 + (used + 1) / wanted + (fnv1a(t.description + t.vars.prompt) % 1000) / 100000;
      };
      const best = candidates.reduce((a, b) => (cost(b) < cost(a) ? b : a));
      chosen.push(best);
      taken.set(lang, n + 1);
      intentUse.set(best.metadata.intent, (intentUse.get(best.metadata.intent) ?? 0) + 1);
      stratUse.set(`${lang}/${best.metadata.strategy}`, (stratUse.get(`${lang}/${best.metadata.strategy}`) ?? 0) + 1);
      progressed = true;
    }
    if (!progressed) throw new Error(`only ${chosen.length} cases could be selected, ${total} wanted`);
  }
  return chosen.sort((a, b) => REDTEAM_LANGUAGES.indexOf(a.metadata.language as never) - REDTEAM_LANGUAGES.indexOf(b.metadata.language as never) || a.description.localeCompare(b.description));
}

/** Counts of a sample by language, intent and strategy (for the report and the README). */
export function composition(tests: RedteamTest[]): { language: Record<string, number>; intent: Record<string, number>; strategy: Record<string, number> } {
  const count = (key: (t: RedteamTest) => string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const t of tests) out[key(t)] = (out[key(t)] ?? 0) + 1;
    return out;
  };
  return { language: count((t) => t.metadata.language), intent: count((t) => t.metadata.intent), strategy: count((t) => t.metadata.strategy) };
}

const HEADER = `# FROZEN red team sample (generated by promptfoo/redteam/curate.ts, then committed: do NOT edit by hand).
# A normal promptfoo tests file, used by sample-offline.yaml and sample-live.yaml. Regenerate it with the recipe in promptfoo/README.md.
# Each test: the attack text (vars.prompt), the language of the README it is hidden in (vars.lang), its canary and the expected stage.
`;

export const sampleYaml = (tests: RedteamTest[]): string => HEADER + stringify(tests, { lineWidth: 0 });

function main(): void {
  const argv = process.argv.slice(2);
  const get = (n: string, d: string): string => (argv.includes(n) ? argv[argv.indexOf(n) + 1]! : d);
  const here = dirname(fileURLToPath(import.meta.url));
  const input = resolve(get("--in", resolve(here, "../out/redteam-generated.yaml")));
  const metaFile = resolve(get("--meta", resolve(here, "intents.meta.json")));
  const out = resolve(get("--out", resolve(here, "sample.yaml")));
  const total = Number(get("--total", "50"));
  const generated = (parse(readFileSync(input, "utf8")) as { tests: GeneratedTest[] }).tests;
  const metas = JSON.parse(readFileSync(metaFile, "utf8")) as IntentMeta[];
  const all = toRedteamTests(generated, metas);
  const picked = argv.includes("--all") ? all : select(all, total); // --all: the nightly run keeps every generated case
  writeFileSync(out, sampleYaml(picked));
  console.log(`${generated.length} generated, ${all.length} usable, ${picked.length} written to ${out}`);
  console.log(JSON.stringify(composition(picked)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
