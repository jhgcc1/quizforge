/**
 * Measures the POLITE rules (`*-polite-*`, packages/core/src/injection-rules-polite.ts) on both sides:
 *   - false positives: every benign text we have (real pt/es READMEs, real English READMEs, the benign rows of the public dataset, every
 *     evals fixture that is not an injection one, the benign README templates of the red team). The bar is 0 hits of ANY rule;
 *   - recall: the attack texts the nightly red team wrote (a run's summary JSON, `--attacks=FILE` made from redteam-nightly.json), the 120
 *     nightly intents, the frozen red-team sample. Reported for the old rules alone and for old + polite, per language and intent.
 *   pnpm exec tsx promptfoo/redteam/replay/polite-check.ts [--en=.local/en-readmes] [--attacks=.local/s3/attacks.json] [--out=docs/security/polite-rules.json]
 * Not part of coverage: a reporting script. The unit tests do not need the downloaded files.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { INJECTION_RULES } from "@quizforge/core";
import { benignDocument } from "@quizforge/core";
import { embedAttack, readmeBlocks } from "../readme.js";
import { hitsOf } from "./ptes-fp.js";
import { benchmarkSample, type DatasetRow } from "./sample.js";
import { LOCAL_DIR, type RealReadmeEntry } from "./real-readmes.js";

const arg = (k: string, d: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const EN_DIR = arg("en", ".local/en-readmes");
const ATTACKS = arg("attacks", ".local/s3/attacks.json");
const DS = arg("dataset", ".local/ds/deepset.json");
const OUT = arg("out", "docs/security/polite-rules.json");
const isPolite = (id: string): boolean => id.includes("-polite-");

const read = (f: string): string => readFileSync(f, "utf8");
const benign: Record<string, string[]> = {};
const { entries } = JSON.parse(read("docs/security/real-readmes-pt-es.json")) as { entries: RealReadmeEntry[] };
benign["real pt/es READMEs"] = entries.map((e) => join(LOCAL_DIR, e.language, `${e.id}.md`)).filter(existsSync).map(read);
benign["real English READMEs"] = existsSync(EN_DIR) ? readdirSync(EN_DIR).filter((f) => f.endsWith(".md")).map((f) => read(join(EN_DIR, f))) : [];
if (existsSync(DS)) benign["benign dataset rows"] = benchmarkSample(JSON.parse(read(DS)) as DatasetRow[]).filter((r) => r.label === 0).map((r) => r.text);
benign["evals fixtures (not injection)"] = readdirSync("evals/fixtures").filter((f) => f.endsWith(".md") && !f.startsWith("injection")).map((f) => read(join("evals/fixtures", f)));
benign["red-team README templates"] = [benignDocument(), ...["en", "pt", "es"].map((l) => readmeBlocks(l).join("\n\n"))];

const fp: Record<string, { documents: number; anyRule: number; polite: number; hits: string[] }> = {};
for (const [name, docs] of Object.entries(benign)) {
  const hits = docs.flatMap((d) => hitsOf(d));
  fp[name] = { documents: docs.length, anyRule: hits.length, polite: hits.filter((h) => isPolite(h.rule)).length, hits: hits.slice(0, 10).map((h) => `${h.rule}: ${h.line.slice(0, 120)}`) };
}

interface Atk { text: string; lang: string; intent: string; leaked?: boolean }
const attacks: Atk[] = [];
if (existsSync(ATTACKS)) {
  for (const a of JSON.parse(read(ATTACKS)) as { text: string; lang: string; meta: { intent: string }; ok: boolean }[]) attacks.push({ text: a.text, lang: a.lang, intent: a.meta.intent, leaked: !a.ok });
}
const nightly = JSON.parse(read("promptfoo/redteam/intents-nightly.json")) as { text: string; language: string; intent: string }[];
const sample = parse(read("promptfoo/redteam/sample.yaml")) as { vars: { prompt: string; lang?: string }[] }[];
const sets: Record<string, Atk[]> = {
  "red-team run (attacks of one nightly run)": attacks,
  "nightly intents (120 texts)": nightly.map((n) => ({ text: n.text, lang: n.language, intent: n.intent })),
  "frozen sample (50)": sample.map((s, i) => ({ text: s.vars.prompt, lang: s.vars.lang ?? "en", intent: `sample-${i}` })),
};

const oldRules = INJECTION_RULES.filter((r) => !isPolite(r.id));
const flaggedBy = (rules: readonly { re: RegExp }[], doc: string): boolean => rules.some((r) => r.re.test(doc.toLowerCase()));
const recall: Record<string, { cases: number; old: number; withPolite: number; leakedBefore?: number; leakedStillUnflagged?: number }> = {};
const stillMissing: string[] = [];
for (const [name, list] of Object.entries(sets)) {
  let o = 0, p = 0, lb = 0, lu = 0;
  for (const a of list) {
    const doc = ["en", "pt", "es"].includes(a.lang) ? embedAttack(a.text, a.lang) : a.text;
    const old = flaggedBy(oldRules, doc);
    const now = flaggedBy(INJECTION_RULES, doc);
    if (old) o++;
    if (now) p++;
    if (a.leaked) { lb++; if (!now) { lu++; stillMissing.push(`${a.lang} ${a.intent}: ${a.text.slice(0, 160).replace(/\n/g, " ")}`); } }
  }
  recall[name] = { cases: list.length, old: o, withPolite: p, ...(name.startsWith("red-team run") ? { leakedBefore: lb, leakedStillUnflagged: lu } : {}) };
}

const rules = INJECTION_RULES.filter((r) => isPolite(r.id)).map((r) => r.id);
writeFileSync(OUT, JSON.stringify({ politeRules: rules.length, totalRules: INJECTION_RULES.length, falsePositives: fp, recall, leaksNotFlaggedByAnyRule: stillMissing }, null, 1) + "\n");
console.log(JSON.stringify({ politeRules: rules.length, totalRules: INJECTION_RULES.length, falsePositives: Object.fromEntries(Object.entries(fp).map(([k, v]) => [k, `${v.anyRule} of ${v.documents} docs/rows (polite ${v.polite})`])), recall }, null, 1));
for (const [k, v] of Object.entries(fp)) for (const h of v.hits) console.log(`FP [${k}] ${h}`);
for (const m of stillMissing) console.log(`STILL NOT FLAGGED: ${m}`);
