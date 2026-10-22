/**
 * Builds the list of attack texts (intents) that promptfoo's `intent` plugin turns into red team tests.
 *
 * Why this step exists: in promptfoo 0.124.1 the `intent` plugin uses every intent text AS IT IS (it does not translate it, even
 * when a language is configured: the test only gets a "language" label). So the translations are made here, with the MiniMax
 * attacker, and every translation is checked by code: the canary (and the URL, when there is one) must have survived.
 *
 *   frozen   12 intents x 3 languages (en, pt, es), each as a translation AND as a paraphrase in another tone -> guardrails/promptfoo/redteam/intents.json + intents.meta.json (committed; reproducible input of the sample)
 *   nightly  `--per-intent N` fresh paraphrases per intent, languages cycled from a seeded start -> guardrails/promptfoo/out/nightly/
 *
 *   MINIMAX_API_KEY must be in the environment (never in a file).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import MiniMaxAttacker from "./attacker-provider.js";
import { BASE_INTENTS, cleanAnswer, nightlySlots, paraphrasePrompt, translationOk, translationPrompt, type IntentMeta } from "./intents.js";
import { REDTEAM_LANGUAGES } from "./readme.js";

export type Ask = (prompt: string) => Promise<string>;

/** Ask up to `tries` times until `ok(answer)` holds. */
export async function askUntil(ask: Ask, prompt: string, ok: (answer: string) => boolean, tries = 4): Promise<string> {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      last = cleanAnswer(await ask(prompt));
    } catch {
      last = "";
    }
    if (last && ok(last)) return last;
  }
  throw new Error(`no acceptable answer after ${tries} tries (last: ${last.slice(0, 80)})`);
}

/** Run `fn` over `items`, `limit` at a time, keeping the order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The frozen set: every base intent in every language (English is the original text), plus one paraphrase in another tone for each. */
export async function frozenIntents(ask: Ask): Promise<IntentMeta[]> {
  const jobs = BASE_INTENTS.flatMap((intent) => REDTEAM_LANGUAGES.map((language) => ({ intent, language })));
  const plain = await mapLimit(jobs, 4, async ({ intent, language }): Promise<IntentMeta> => {
    const text = language === "en" ? intent.text : await askUntil(ask, translationPrompt(intent.text, language), (a) => translationOk(intent, a));
    return { text, intent: intent.id, language, canary: intent.canary };
  });
  const tone = await mapLimit(jobs, 4, async ({ intent, language }): Promise<IntentMeta> => {
    const text = await askUntil(ask, paraphrasePrompt(intent.text, language, 1), (a) => translationOk(intent, a));
    return { text, intent: intent.id, language, canary: intent.canary, tone: true };
  });
  return [...plain, ...tone];
}

/** A fresh set: `perIntent` new paraphrases of every base intent, in seeded languages. */
export async function nightlyIntents(ask: Ask, perIntent: number, seed: number): Promise<IntentMeta[]> {
  const metas = await mapLimit(nightlySlots(perIntent, seed), 4, async ({ intent, language, variant }) => {
    const text = await askUntil(ask, paraphrasePrompt(intent.text, language, variant), (a) => translationOk(intent, a));
    return { text, intent: intent.id, language, canary: intent.canary } satisfies IntentMeta;
  });
  // promptfoo would treat two identical texts as one: keep the first of each
  return [...new Map(metas.map((m) => [m.text, m])).values()];
}

export function writeIntents(dir: string, metas: IntentMeta[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "intents.json"), JSON.stringify(metas.map((m) => m.text), null, 2) + "\n");
  writeFileSync(resolve(dir, "intents.meta.json"), JSON.stringify(metas, null, 2) + "\n");
}

export function parseArgs(argv: string[]): { mode: "frozen" | "nightly"; perIntent: number; seed: number; out: string } {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const mode = get("--mode") === "nightly" ? "nightly" : "frozen";
  const here = dirname(fileURLToPath(import.meta.url));
  const perIntent = Number(get("--per-intent") ?? 30);
  if (!Number.isInteger(perIntent) || perIntent < 1) throw new Error("--per-intent must be a positive integer");
  return { mode, perIntent, seed: Number(get("--seed") ?? Date.now() % 1_000_000), out: resolve(get("--out") ?? (mode === "frozen" ? here : resolve(here, "../out/nightly"))) };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const attacker = new MiniMaxAttacker();
  const ask: Ask = async (prompt) => {
    const r = await attacker.callApi(prompt);
    if (r.error) throw new Error(r.error);
    return r.output ?? "";
  };
  const metas = args.mode === "frozen" ? await frozenIntents(ask) : await nightlyIntents(ask, args.perIntent, args.seed);
  writeIntents(args.out, metas);
  console.log(`wrote ${metas.length} intents to ${args.out} (${args.mode}${args.mode === "nightly" ? `, ${args.perIntent} per intent, seed ${args.seed}` : ""})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
