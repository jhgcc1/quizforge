/**
 * Attack texts of the NIGHTLY run: the 12 base intents (intents.ts) plus the product-specific ones (intents-nightly.ts).
 *
 *   committed   writes guardrails/promptfoo/redteam/intents-nightly.json: the new intents in en, pt and es, each as a translation and as a
 *               paraphrase in another tone (the same recipe as intents.json). Run it by hand when the intent list changes, commit the file.
 *   fresh       (every night) `--per-intent N` NEW paraphrases of EVERY intent, languages cycled from a seeded start. The seed text of
 *               each (intent, language) is the committed one (intents.json for the 12 base intents, intents-nightly.json for the new
 *               ones), so markup (comments, code blocks, tables...) and the canary survive. Writes intents.json + intents.meta.json in --out.
 *
 * Every sentence is checked by code: the canary (and URL) survived, it fits its markup, a topic stays on one line. The MARKUP (comment, code block, table...) is added by code around the sentence, never by the model.
 * MINIMAX_API_KEY must be in the environment (never in a file).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import MiniMaxAttacker from "./attacker-provider.js";
import { askUntil, mapLimit, writeIntents, type Ask } from "./build-intents.js";
import { BASE_INTENTS, paraphrasePrompt, seededRandom, translationOk, translationPrompt, type BaseIntent, type IntentMeta } from "./intents.js";
import { NIGHTLY_BY_ID, NIGHTLY_INTENTS, payloadOk, render, textOk, type Layout } from "./intents-nightly.js";
import { REDTEAM_LANGUAGES, type RedteamLanguage } from "./readme.js";

/** An intent text plus where it goes (the provider reads the layout through the test vars). `payload` is the sentence inside the markup. */
export interface NightlyMeta extends IntentMeta {
  layout: Layout;
  payload?: string;
}

export const ALL_INTENTS: BaseIntent[] = [...BASE_INTENTS, ...NIGHTLY_INTENTS];
export const layoutOf = (intentId: string): Layout => NIGHTLY_BY_ID.get(intentId)?.layout ?? "document";

const here = dirname(fileURLToPath(import.meta.url));
export const COMMITTED_FILE = resolve(here, "intents-nightly.json");

/** What the attacker model works on: the sentence (without the markup the code adds around it). */
const sentenceOf = (intent: BaseIntent): BaseIntent => {
  const x = NIGHTLY_BY_ID.get(intent.id);
  return x ? { id: x.id, canary: x.canary, text: x.payload } : intent;
};

/** Accept a sentence only when canary and URL survived, and (for the new intents) it fits its markup and its markers. */
export function sentenceOk(intent: BaseIntent, answer: string): boolean {
  if (!translationOk(sentenceOf(intent), answer)) return false;
  const x = NIGHTLY_BY_ID.get(intent.id);
  return !x || (payloadOk(x, answer) && textOk(x, render(x, answer)));
}

/** The meta of one sentence: for the new intents the text is the sentence inside its markup. */
function metaOf(intent: BaseIntent, language: RedteamLanguage, sentence: string, extra: { tone?: true } = {}): NightlyMeta {
  const x = NIGHTLY_BY_ID.get(intent.id);
  return { text: x ? render(x, sentence) : sentence, intent: intent.id, language, canary: intent.canary, layout: layoutOf(intent.id), ...(x ? { payload: sentence } : {}), ...extra };
}

/** The committed set of the new intents: every language as a translation (English is the original) and as a paraphrase in another tone. */
export async function committedIntents(ask: Ask, intents: BaseIntent[] = NIGHTLY_INTENTS): Promise<NightlyMeta[]> {
  const jobs = intents.flatMap((intent) => REDTEAM_LANGUAGES.map((language) => ({ intent, language })));
  const plain = await mapLimit(jobs, 6, async ({ intent, language }) => {
    const base = sentenceOf(intent).text;
    return metaOf(intent, language, language === "en" ? base : await askUntil(ask, translationPrompt(base, language), (a) => sentenceOk(intent, a), 6));
  });
  const tone = await mapLimit(jobs, 6, async ({ intent, language }) => metaOf(intent, language, await askUntil(ask, paraphrasePrompt(sentenceOf(intent).text, language, 1), (a) => sentenceOk(intent, a), 6), { tone: true }));
  return [...plain, ...tone];
}

/** Seed sentences: the committed translation of each (intent, language). For the 12 base intents these come from intents.meta.json. */
export function seedTexts(baseMetas: NightlyMeta[], newMetas: NightlyMeta[]): Map<string, string> {
  const seeds = new Map<string, string>();
  for (const m of [...baseMetas, ...newMetas]) if (!m.tone) seeds.set(`${m.intent}/${m.language}`, m.payload ?? m.text);
  return seeds;
}

/** For each intent, `perIntent` (language, variant) slots: the languages are cycled from a seeded random start, so they stay balanced. */
export function slotsFor(intents: BaseIntent[], perIntent: number, seed: number): { intent: BaseIntent; language: RedteamLanguage; variant: number }[] {
  const rnd = seededRandom(seed);
  const slots: { intent: BaseIntent; language: RedteamLanguage; variant: number }[] = [];
  for (const intent of intents) {
    const start = Math.floor(rnd() * REDTEAM_LANGUAGES.length);
    for (let i = 0; i < perIntent; i++) slots.push({ intent, language: REDTEAM_LANGUAGES[(start + i) % REDTEAM_LANGUAGES.length]!, variant: i + 1 });
  }
  return slots;
}

/** One text the attacker model would not (or could not) write: it is skipped, never fatal. */
export interface Refusal {
  intent: string;
  language: string;
  /** The start of the last answer (a refusal like "I'm sorry, but I can't help with that"), or why there was none. */
  reason: string;
}

/**
 * A fresh set: `perIntent` new paraphrases of every intent (the 12 base ones and the new ones).
 * A refusal or an unusable answer for ONE text never stops the run: the text is asked again (5 tries), then once more with another variant of the
 * prompt (a different phrasing, 3 tries); if it is still refused it is SKIPPED and reported through `onRefused`, and the run goes on with the texts it has.
 */
export async function freshIntents(ask: Ask, perIntent: number, seed: number, seeds: Map<string, string>, intents: BaseIntent[] = ALL_INTENTS, onRefused: (r: Refusal) => void = () => {}): Promise<NightlyMeta[]> {
  const metas = await mapLimit(slotsFor(intents, perIntent, seed), 6, async ({ intent, language, variant }): Promise<NightlyMeta | undefined> => {
    const from = seeds.get(`${intent.id}/${language}`) ?? sentenceOf(intent).text;
    const ok = (a: string): boolean => sentenceOk(intent, a);
    let reason = "";
    for (const [v, tries] of [[variant, 5], [variant + 20, 3]] as const) {
      try {
        return metaOf(intent, language, await askUntil(ask, paraphrasePrompt(from, language, v), ok, tries));
      } catch (err) {
        reason = err instanceof Error ? err.message.slice(0, 160) : String(err);
      }
    }
    onRefused({ intent: intent.id, language, reason });
    return undefined;
  });
  // promptfoo treats two identical texts as one: keep the first of each
  return [...new Map(metas.filter((m): m is NightlyMeta => m !== undefined).map((m) => [m.text, m])).values()];
}

/** What the generation did, for the report and the metrics. */
export interface GenerationReport {
  requested: number;
  produced: number;
  refused: Refusal[];
  /** The generation produced nothing (or crashed): the fixed texts of the repository were used instead. */
  fallback: boolean;
  fallbackReason?: string;
}

/** The fixed attack texts of the repository: the 12 base intents (intents.meta.json, 72 texts) and the product-specific ones (intents-nightly.json). No model needed. */
export function fixedIntents(baseMetas: NightlyMeta[], newMetas: NightlyMeta[]): NightlyMeta[] {
  return [...new Map([...baseMetas, ...newMetas].map((m) => [m.text, m])).values()];
}

/** The fresh set with every failure absorbed: partial results are used as they are, and no result at all falls back to the fixed texts. */
export async function generateOrFallback(ask: Ask, perIntent: number, seed: number, seeds: Map<string, string>, fixed: () => NightlyMeta[], intents: BaseIntent[] = ALL_INTENTS): Promise<{ metas: NightlyMeta[]; report: GenerationReport }> {
  const refused: Refusal[] = [];
  const requested = slotsFor(intents, perIntent, seed).length;
  let metas: NightlyMeta[] = [];
  let crash = "";
  try {
    metas = await freshIntents(ask, perIntent, seed, seeds, intents, (r) => refused.push(r));
  } catch (err) {
    crash = err instanceof Error ? err.message.slice(0, 200) : String(err);
  }
  if (metas.length > 0) return { metas, report: { requested, produced: metas.length, refused, fallback: false } };
  return { metas: fixed(), report: { requested, produced: 0, refused, fallback: true, fallbackReason: crash || `the attacker model produced no text (${refused.length} refused)` } };
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

export function parseNightlyArgs(argv: string[]): { mode: "committed" | "fresh"; perIntent: number; seed: number; out: string } {
  const get = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const mode = get("--mode") === "committed" ? "committed" : "fresh";
  const perIntent = Number(get("--per-intent") ?? 10);
  if (!Number.isInteger(perIntent) || perIntent < 1) throw new Error("--per-intent must be a positive integer");
  return { mode, perIntent, seed: Number(get("--seed") ?? Date.now() % 1_000_000), out: resolve(get("--out") ?? (mode === "committed" ? here : resolve(here, "../out/nightly"))) };
}

async function main(): Promise<void> {
  const args = parseNightlyArgs(process.argv.slice(2));
  const attacker = new MiniMaxAttacker();
  const ask: Ask = async (prompt) => {
    const r = await attacker.callApi(prompt);
    if (r.error) throw new Error(r.error);
    return r.output ?? "";
  };
  if (args.mode === "committed") {
    const metas = await committedIntents(ask);
    writeFileSync(COMMITTED_FILE, JSON.stringify(metas, null, 2) + "\n");
    console.log(`wrote ${metas.length} intents to ${COMMITTED_FILE}`);
    return;
  }
  const baseMetas = readJson<NightlyMeta[]>(resolve(here, "intents.meta.json"));
  const newMetas = readJson<NightlyMeta[]>(COMMITTED_FILE);
  const { metas, report } = await generateOrFallback(ask, args.perIntent, args.seed, seedTexts(baseMetas, newMetas), () => fixedIntents(baseMetas, newMetas));
  writeIntents(args.out, metas);
  writeFileSync(resolve(args.out, "generation.json"), JSON.stringify(report, null, 2) + "\n");
  for (const r of report.refused) console.error(`WARN redteam generation-refused intent=${r.intent} lang=${r.language} last="${r.reason.replace(/"/g, "'")}"`);
  if (report.fallback) console.error(`WARN redteam generation-fallback: using the ${metas.length} fixed attack texts (${report.fallbackReason})`);
  console.log(`wrote ${metas.length} intents to ${args.out} (${ALL_INTENTS.length} intents, ${args.perIntent} per intent, seed ${args.seed}; ${report.refused.length} refused, ${report.fallback ? "FALLBACK to the fixed texts" : "fresh"})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
