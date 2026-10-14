/**
 * Stage 1 of the pt/es validation with public attack datasets: every attack text, as the BODY of a document, through the language policy,
 * the keyword rules of the input guard and Llama Prompt Guard 2 (flag only). No generation model here (free).
 *
 *   pnpm exec tsx promptfoo/redteam/replay/fetch-ptes-datasets.ts      (once: downloads the datasets into .local/ds/ptes)
 *   pnpm exec tsx promptfoo/redteam/replay/ptes-datasets.ts [--no-detector] [--out=.local/ptes-stage1.json]
 *
 * Writes the per-row results to .local/ (the texts of Weni have no declared licence and are never committed); the committed numbers are
 * aggregates (docs/security/replay-ptes.json). Prompt Guard 2 is the ungated ONNX conversion (1.1 GB, downloaded once into the Hugging Face cache).
 * Not part of coverage: a reporting script over the helpers in ptes-data.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { inspectText } from "@quizforge/core";
import { detectLanguage } from "@quizforge/llm";
import { DATASETS, groupRows, ruleCounts, summarize, type RawRow, type RowResult } from "./ptes-data.js";

const arg = (k: string, d: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const OUT = arg("out", ".local/ptes-stage1.json");
const USE_DETECTOR = !process.argv.includes("--no-detector");

const detectorModule = "../../../packages/detector/src/index.ts";
const detector = USE_DETECTOR ? ((await import(/* @vite-ignore */ detectorModule)) as { createOnnxDetector(o?: { threshold?: number }): { detect(t: string): Promise<{ score: number }> } }).createOnnxDetector({ threshold: 0.5 }) : undefined;

const perRow: Record<string, RowResult[]> = {};
for (const spec of DATASETS) {
  const rows = JSON.parse(readFileSync(`.local/ds/ptes/${spec.key}.json`, "utf8")) as RawRow[];
  for (const g of groupRows(spec, rows, detectLanguage, true)) {
    const results: RowResult[] = [];
    for (const text of g.rows) {
      const lang = detectLanguage(text);
      const r = inspectText(text);
      const serious = r.findings.filter((f) => f.severity !== "sanitize");
      results.push({
        text, language: lang, policyOk: lang === "en" || lang === "pt" || lang === "es" || lang === "unknown",
        guard: r.blocked ? "block" : serious.length ? "flag" : "pass", rules: [...new Set(serious.map((f) => f.rule ?? f.kind))],
        detector: detector ? (await detector.detect(text)).score : 0,
      });
    }
    perRow[g.id] = results;
    console.log(g.id, summarize(g.id, results));
  }
}
const summary = Object.entries(perRow).map(([id, rs]) => ({ ...summarize(id, rs), rules: ruleCounts(rs), detectedAs: Object.fromEntries([...new Set(rs.map((r) => r.language))].map((l) => [l, rs.filter((r) => r.language === l).length])) }));
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), detector: USE_DETECTOR, summary, rows: perRow }));
writeFileSync(OUT.replace(/\.json$/, "-summary.json"), JSON.stringify({ at: new Date().toISOString(), detector: USE_DETECTOR, summary }, null, 1) + "\n");
console.log(`written ${OUT}`);
