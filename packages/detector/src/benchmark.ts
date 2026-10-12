/**
 * Security benchmark: the input guard (and optionally the ONNX classifier) against a PUBLIC prompt-injection dataset.
 *   pnpm --filter @quizforge/detector benchmark                 500 samples, guard only (offline, free, seconds)
 *   pnpm --filter @quizforge/detector benchmark -- --detector   also the classifier (downloads ~740 MB once)
 *   options: --n=500 --seed=1 --out=docs/security
 * Dataset: deepset/prompt-injections (Hugging Face, Apache-2.0, 662 labelled prompts, English and German; label 1 = injection).
 * It is downloaded to .local/ds (git-ignored). The sample is stratified (keeps the injection / benign ratio) and seeded, so a run is repeatable.
 * Every sample is treated as the BODY of a document, which is how the guard sees input in production.
 * Counted as DETECTED: the guard blocks or flags it. Language policy (en, pt, es only) is reported separately: a German sample is
 * refused by the language policy, which stops it, but that is not detection of the injection itself.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inspectText } from "@quizforge/core";
import { detectLanguage } from "@quizforge/llm";
import { createOnnxDetector } from "./index.js";

const arg = (k: string, d: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const N = Number(arg("n", "500"));
const SEED = Number(arg("seed", "1"));
const OUT = join(process.cwd(), "../..", arg("out", "docs/security"));
const USE_DETECTOR = process.argv.includes("--detector");
const root = join(process.cwd(), "../..");
const DS = join(root, ".local/ds/deepset.json");

interface Row { split: string; text: string; label: number }

async function load(): Promise<Row[]> {
  if (existsSync(DS)) return JSON.parse(readFileSync(DS, "utf8"));
  mkdirSync(dirname(DS), { recursive: true });
  const rows: Row[] = [];
  for (const split of ["train", "test"]) {
    for (let off = 0; ; off += 100) {
      const r = await fetch(`https://datasets-server.huggingface.co/rows?dataset=deepset/prompt-injections&config=default&split=${split}&offset=${off}&length=100`);
      const d = (await r.json()) as { rows: { row: Row }[]; num_rows_total: number };
      rows.push(...d.rows.map((x) => ({ ...x.row, split })));
      if (off + 100 >= d.num_rows_total) break;
    }
  }
  writeFileSync(DS, JSON.stringify(rows));
  return rows;
}

// small seeded PRNG (mulberry32) so the sample is the same on every machine
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}

const all = (await load()).map((r, i) => ({ ...r, id: i }));
const rand = rng(SEED);
const inj = shuffle(all.filter((r) => r.label === 1), rand);
const ben = shuffle(all.filter((r) => r.label === 0), rand);
const nInj = Math.round((N * inj.length) / all.length);
const sample = [...inj.slice(0, nInj), ...ben.slice(0, N - nInj)];

const detector = USE_DETECTOR ? createOnnxDetector({ threshold: 0.5 }) : undefined;

interface Result { id: number; label: number; lang: string; supported: boolean; guard: "block" | "flag" | "pass"; rules: string[]; detector?: number; text: string }
const results: Result[] = [];
for (const s of sample) {
  const lang = detectLanguage(s.text);
  const r = inspectText(s.text);
  const serious = r.findings.filter((f) => f.severity !== "sanitize");
  const out: Result = {
    id: s.id, label: s.label, lang, supported: lang === "en" || lang === "pt" || lang === "es" || lang === "unknown",
    guard: r.blocked ? "block" : serious.length ? "flag" : "pass", rules: [...new Set(serious.map((f) => f.rule ?? f.kind))],
    text: s.text.replace(/\s+/g, " ").slice(0, 160),
  };
  if (detector) out.detector = (await detector.detect(s.text)).score;
  results.push(out);
}

const pct = (a: number, b: number): number => (b ? Math.round((a / b) * 1000) / 10 : 0);
function stats(rows: Result[]) {
  const injections = rows.filter((r) => r.label === 1);
  const benign = rows.filter((r) => r.label === 0);
  const g = (r: Result) => r.guard !== "pass";
  const d = (r: Result) => (r.detector ?? 0) >= 0.5;
  return {
    total: rows.length, injections: injections.length, benign: benign.length,
    guardCaught: injections.filter(g).length, guardRecallPct: pct(injections.filter(g).length, injections.length),
    guardFalsePositives: benign.filter(g).length, guardFalsePositivePct: pct(benign.filter(g).length, benign.length),
    ...(detector ? {
      detectorCaught: injections.filter(d).length, detectorRecallPct: pct(injections.filter(d).length, injections.length),
      detectorFalsePositives: benign.filter(d).length, detectorFalsePositivePct: pct(benign.filter(d).length, benign.length),
      eitherCaught: injections.filter((r) => g(r) || d(r)).length, eitherRecallPct: pct(injections.filter((r) => g(r) || d(r)).length, injections.length),
      eitherFalsePositives: benign.filter((r) => g(r) || d(r)).length, eitherFalsePositivePct: pct(benign.filter((r) => g(r) || d(r)).length, benign.length),
    } : {}),
    refusedByLanguagePolicy: rows.filter((r) => !r.supported).length,
  };
}
const byLang: Record<string, ReturnType<typeof stats>> = {};
for (const l of [...new Set(results.map((r) => r.lang))]) byLang[l] = stats(results.filter((r) => r.lang === l));
const english = results.filter((r) => r.lang === "en");
const ruleHits: Record<string, number> = {};
for (const r of results.filter((x) => x.label === 1)) for (const rule of r.rules) ruleHits[rule] = (ruleHits[rule] ?? 0) + 1;

const summary = {
  dataset: { name: "deepset/prompt-injections", url: "https://huggingface.co/datasets/deepset/prompt-injections", license: "Apache-2.0", size: all.length, labelled: "1 = injection" },
  sample: { n: sample.length, seed: SEED, stratified: true },
  at: new Date().toISOString(),
  detector: detector ? { name: detector.name, threshold: 0.5, languages: ["en"] } : null,
  all: stats(results), english: stats(english), byLanguage: byLang,
  topRules: Object.entries(ruleHits).sort((a, b) => b[1] - a[1]).slice(0, 12),
};
const missed = results.filter((r) => r.label === 1 && r.guard === "pass" && (r.detector ?? 0) < 0.5 && r.lang === "en").slice(0, 25);
const falsePos = results.filter((r) => r.label === 0 && (r.guard !== "pass" || (r.detector ?? 0) >= 0.5)).slice(0, 25);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "benchmark.json"), JSON.stringify({ ...summary, missedInjectionsEnglish: missed, falsePositives: falsePos, results }, null, 1));
console.log(JSON.stringify(summary, null, 2));
console.log(`\nwritten: ${join(OUT, "benchmark.json")}`);
