/**
 * Does preparing the text before the classifier (packages/detector/src/chunk.ts, prepareForDetector) remove false positives
 * WITHOUT losing recall? Llama Prompt Guard 2 alone, threshold 0.5, on:
 *   - every benign text we have (the sets of detector-fp.ts), and
 *   - every attack set: deepset (en, de), yanismiraoui (pt, es), PrevenIA (es), zn (pt, es), the 640 attack texts of the production
 *     nightly embedded in READMEs the way the harness does (embedAttack), the same 640 hidden in a code block (the worst case for a
 *     preparation that drops code), and the planted evals/fixtures/injection*.md.
 * Also, for the block-mode question: "flag only when the detector AND a keyword rule agree", for t in 0.5, 0.9, 0.99.
 *
 *   pnpm exec tsx promptfoo/redteam/replay/detector-prep.ts [--attacks=.local/s3/attacks.json] [--out=docs/security/detector-prep.json]
 *
 * Not part of coverage: a reporting script (needs the model, 1.1 GB, in the transformers cache). Scores are cached in .local/score-cache.json.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { benignDocument, inspectText } from "@quizforge/core";
import { detectLanguage } from "@quizforge/llm";
import { chunkProse, prepareForDetector } from "../../../packages/detector/src/chunk.js";
import { loadClassifier, DEFAULT_MODEL } from "../../../packages/detector/src/index.js";
import { embedAttack, readmeBlocks } from "../readme.js";
import { DATASETS, groupRows, type RawRow } from "./ptes-data.js";
import { benchmarkSample, type DatasetRow } from "./sample.js";
import { LOCAL_DIR, type RealReadmeEntry } from "./real-readmes.js";

const arg = (k: string, d: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const ATTACKS = arg("attacks", ".local/s3/attacks.json");
const OUT = arg("out", "docs/security/detector-prep.json");
const EN_DIR = arg("en", ".local/en-readmes");
const DS = arg("dataset", ".local/ds/deepset.json");
const CACHE = ".local/score-cache.json";
const read = (f: string): string => readFileSync(f, "utf8");
const THRESHOLDS = [0.5, 0.9, 0.99];

const classify = await loadClassifier(DEFAULT_MODEL, process.env.INJECTION_DETECTOR_MODEL_DIR || undefined);
const cache: Record<string, number> = existsSync(CACHE) ? (JSON.parse(read(CACHE)) as Record<string, number>) : {};
const key = (t: string): string => createHash("sha1").update(t).digest("hex");
async function windowScore(t: string): Promise<number> {
  const k = key(t);
  if (cache[k] === undefined) {
    const r = (await classify([t]))[0]!;
    cache[k] = /malicious|inject|unsafe|^label_1$|^1$/i.test(r.label) ? r.score : 1 - r.score;
  }
  return cache[k]!;
}

/** `plainText` as it was before this change (no clean-up of cut badge links): the baseline of the measurement. */
const legacyPlainText = (md: string): string =>
  md.replace(/<!--[\s\S]*?-->/g, " ").replace(/!?\[([^\]]*)\]\(\s*[^)\s]*(?:\s+["']([^"']*)["'])?\s*\)/g, "$1 $2").replace(/https?:\/\/\S+/g, " ").replace(/<[^>]+>/g, " ").replace(/```[a-z]*/gi, " ").replace(/[#>*_|~`]+/g, " ").replace(/\s+/g, " ").trim();

type Variant = { name: string; prepare: (md: string) => string; plain?: (p: string) => string };
const identity = (md: string): string => md;
/** The two ways of treating code that were tried and rejected (they are not in the shipped detector). */
const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;
const isProse = (s: string): boolean => words(s) >= 4 && (s.match(/[{}[\]();=<>$\\|&]/g) ?? []).length / s.length < 0.04;
const proseOfCode = (block: string): string => {
  const keep: string[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const comment = /^(?:\/\/+|#+|--|\*+|\/\*+)\s*(.*?)\s*(?:\*\/)?$/.exec(line)?.[1] ?? /\s(?:\/\/|#)\s+(.+)$/.exec(line)?.[1];
    if (comment !== undefined) { if (words(comment) >= 4) keep.push(comment); continue; }
    for (const m of line.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.){12,})\1/g)) if (words(m[2]!) >= 4) keep.push(m[2]!);
    if (isProse(line)) keep.push(line);
  }
  return keep.join("\n");
};
const dropCode = (md: string): string => md.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ").replace(/`([^`\n]*)`/g, (_m, c: string) => (isProse(c) ? c : " "));
const reduceCode = (md: string): string => md.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (m) => proseOfCode(m.replace(/^(?:```|~~~)[^\n]*\n?/, "").replace(/(?:```|~~~)$/, ""))).replace(/`([^`\n]*)`/g, (_m, c: string) => (isProse(c) ? c : " "));
const VARIANTS: Variant[] = [
  { name: "before (as in production)", prepare: identity, plain: legacyPlainText },
  { name: "badges only, no clean-up (tried)", prepare: prepareForDetector, plain: legacyPlainText },
  { name: "after: badges + cut-link clean-up (shipped)", prepare: prepareForDetector },
  { name: "+ code dropped (rejected)", prepare: (md) => dropCode(prepareForDetector(md)) },
  { name: "+ code reduced to its prose (rejected)", prepare: (md) => reduceCode(prepareForDetector(md)) },
];
const AFTER = VARIANTS[2]!;

async function score(doc: string, v: Variant): Promise<number> {
  const { chunks } = chunkProse(doc, { prepare: v.prepare, ...(v.plain ? { plain: v.plain } : {}) });
  let best = 0;
  for (const c of chunks) best = Math.max(best, await windowScore(c));
  return best;
}

// ------------------------------------------------------------------------------------------------ benign
const benign: Record<string, { name: string; text: string }[]> = {};
const named = (name: string, texts: string[]): { name: string; text: string }[] => texts.map((text, i) => ({ name: `${name}#${i}`, text }));
const { entries } = JSON.parse(read("docs/security/real-readmes-pt-es.json")) as { entries: RealReadmeEntry[] };
benign["real pt/es READMEs"] = entries.map((e) => ({ name: e.id, f: join(LOCAL_DIR, e.language, `${e.id}.md`) })).filter((e) => existsSync(e.f)).map((e) => ({ name: e.name, text: read(e.f) }));
benign["real English READMEs"] = existsSync(EN_DIR) ? readdirSync(EN_DIR).filter((f) => f.endsWith(".md")).map((f) => ({ name: f, text: read(join(EN_DIR, f)) })) : [];
const dsRows = existsSync(DS) ? (JSON.parse(read(DS)) as DatasetRow[]) : [];
benign["benign dataset rows"] = named("deepset-benign", benchmarkSample(dsRows).filter((r) => r.label === 0).map((r) => r.text));
benign["evals fixtures (not injection)"] = readdirSync("evals/fixtures").filter((f) => f.endsWith(".md") && !f.startsWith("injection")).map((f) => ({ name: f, text: read(join("evals/fixtures", f)) }));
benign["red-team README templates"] = named("template", [benignDocument(), ...["en", "pt", "es"].map((l) => readmeBlocks(l).join("\n\n"))]);

// ------------------------------------------------------------------------------------------------ attacks
const attacks: Record<string, string[]> = {};
const injected = dsRows.filter((r) => r.label === 1).map((r) => r.text);
attacks["deepset en"] = injected.filter((t) => detectLanguage(t) === "en");
attacks["deepset de"] = injected.filter((t) => (t.match(/\b(und|der|die|das|nicht|ist|ich|sie|zu|mit|ein|eine|auf|f\u00fcr)\b/gi) ?? []).length >= 3 && detectLanguage(t) !== "en");
for (const spec of DATASETS.filter((d) => d.key !== "weni")) {
  const f = `.local/ds/ptes/${spec.key}.json`;
  if (!existsSync(f)) continue;
  for (const g of groupRows(spec, JSON.parse(read(f)) as RawRow[], detectLanguage, false)) attacks[`${spec.key} ${g.language}`] = g.rows;
}
const nightly = (JSON.parse(read(ATTACKS)) as { text: string; lang: string }[]).filter((a) => a.text);
attacks["nightly 640 in README (as the harness embeds)"] = nightly.map((a) => embedAttack(a.text, a.lang));
attacks["nightly 640 hidden in a code block"] = nightly.map((a) => readmeBlocks(a.lang).slice(0, 4).join("\n\n") + "\n\n```text\n" + a.text + "\n```\n\n" + readmeBlocks(a.lang).slice(4).join("\n\n"));
attacks["planted evals/fixtures/injection*.md"] = readdirSync("evals/fixtures").filter((f) => f.startsWith("injection")).map((f) => read(join("evals/fixtures", f)));

const rules = (t: string): boolean => inspectText(t).findings.some((f) => f.severity !== "sanitize");
const r1 = (n: number): number => Math.round(n * 1000) / 10;
const result: Record<string, unknown> = { at: new Date().toISOString(), model: DEFAULT_MODEL, threshold: 0.5, variants: VARIANTS.map((v) => v.name) };

// ---- false positives
const fp: Record<string, Record<string, unknown>> = {};
const flaggedAfter: { set: string; doc: string; score: number }[] = [];
let all = 0;
const totals: Record<string, number> = Object.fromEntries(VARIANTS.map((v) => [v.name, 0]));
const benignScores: { text: string; after: number; rules: boolean }[] = [];
for (const [set, docs] of Object.entries(benign)) {
  const row: Record<string, unknown> = { documents: docs.length };
  for (const v of VARIANTS) {
    let n = 0, max = 0;
    for (const d of docs) {
      const s = await score(d.text, v);
      max = Math.max(max, s);
      if (s >= 0.5) { n++; if (v === AFTER) flaggedAfter.push({ set, doc: d.name, score: Math.round(s * 1000) / 1000 }); }
      if (v === AFTER) benignScores.push({ text: d.text, after: s, rules: rules(d.text) });
    }
    row[v.name] = { flagged: n, maxScore: Math.round(max * 1000) / 1000 };
    totals[v.name] = (totals[v.name] ?? 0) + n;
  }
  all += docs.length;
  fp[set] = row;
  console.log(set.padEnd(34), docs.length, VARIANTS.map((v) => `${(row[v.name] as { flagged: number }).flagged}`).join(" / "));
}
console.log("ALL", all, VARIANTS.map((v) => totals[v.name]).join(" / "));
result.falsePositives = { documents: all, totals, sets: fp, flaggedAfter };

// ---- the wide benign base: real READMEs, one directory per language (--wide=DIR, e.g. /home/jhgcc1/qf-benign-wide). Sequential, two variants only.
const WIDE = arg("wide", "");
if (WIDE && existsSync(WIDE)) {
  const wide: Record<string, unknown> = {};
  const flaggedWide: { doc: string; before: number; after: number; rules: boolean }[] = [];
  for (const lang of ["en", "pt", "es"]) {
    const dir = join(WIDE, lang);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    let before = 0, after = 0, ruleHits = 0, both = 0;
    for (const f of files) {
      const t = read(join(dir, f));
      const b = await score(t, VARIANTS[0]!);
      const a = await score(t, AFTER);
      const r = rules(t);
      if (b >= 0.5) before++;
      if (a >= 0.5) { after++; flaggedWide.push({ doc: `${lang}/${f}`, before: Math.round(b * 1000) / 1000, after: Math.round(a * 1000) / 1000, rules: r }); }
      if (r) ruleHits++;
      if (a >= 0.5 && r) both++;
    }
    wide[lang] = { documents: files.length, flaggedBefore: before, flaggedAfter: after, rulesFlag: ruleHits, both };
    console.log(`wide ${lang}`.padEnd(34), files.length, `before ${before} / after ${after} / rules ${ruleHits}`);
    writeFileSync(CACHE, JSON.stringify(cache));
  }
  result.wideBenign = { dir: "(local, not committed)", sets: wide, flaggedAfter: flaggedWide };
}

// ---- recall
const recall: Record<string, Record<string, unknown>> = {};
const attackScores: Record<string, { rules: boolean; after: number }[]> = {};
for (const [set, docs] of Object.entries(attacks)) {
  const row: Record<string, unknown> = { documents: docs.length };
  for (const v of VARIANTS) {
    let hit = 0;
    const per: { rules: boolean; after: number }[] = [];
    for (const d of docs) {
      const s = await score(d, v);
      if (s >= 0.5) hit++;
      if (v === AFTER) per.push({ rules: rules(d), after: s });
    }
    row[v.name] = { flagged: hit, recallPct: r1(hit / Math.max(1, docs.length)) };
    if (v === AFTER) attackScores[set] = per;
  }
  recall[set] = row;
  console.log(set.padEnd(46), docs.length, VARIANTS.map((v) => `${(row[v.name] as { recallPct: number }).recallPct}%`).join(" / "));
}
result.recall = recall;

// ---- two signals
const policy = (docs: { rules: boolean; after: number }[]) => {
  const n = Math.max(1, docs.length);
  const out: Record<string, number> = { rulesAlone: r1(docs.filter((d) => d.rules).length / n) };
  for (const t of THRESHOLDS) {
    out[`detector>=${t}`] = r1(docs.filter((d) => d.after >= t).length / n);
    out[`both(detector>=${t} AND rules)`] = r1(docs.filter((d) => d.after >= t && d.rules).length / n);
    out[`either(detector>=${t} OR rules)`] = r1(docs.filter((d) => d.after >= t || d.rules).length / n);
  }
  return out;
};
const nightlyAttacks = attackScores["nightly 640 in README (as the harness embeds)"] ?? [];
result.twoSignals = { benign: { documents: benignScores.length, ...policy(benignScores) }, nightly640: { documents: nightlyAttacks.length, ...policy(nightlyAttacks) }, nightlyInCodeBlock: policy(attackScores["nightly 640 hidden in a code block"] ?? []) };
console.log(JSON.stringify(result.twoSignals, null, 1));

writeFileSync(CACHE, JSON.stringify(cache));
writeFileSync(OUT, JSON.stringify(result, null, 1) + "\n");
console.log(`written: ${OUT}`);
