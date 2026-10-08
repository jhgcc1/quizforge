/**
 * Re-render the HTML from the saved numbers (no LLM calls): pnpm --filter @quizforge/evals report [docs/eval]
 * With Langfuse keys in the environment it also looks up the id of every experiment run, so the report links straight to them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchLangfuseRuns } from "./langfuse-links.js";
import { renderReport, type CompareReport } from "./report.js";

const dir = resolve(fileURLToPath(new URL("..", import.meta.url)), "..", process.argv[2] ?? "docs/eval");
const report = JSON.parse(readFileSync(`${dir}/structure-comparison.json`, "utf8")) as CompareReport;

// older files stored one string per variant
for (const v of report.variants) v.langfuseRuns ??= v.langfuseRun ? v.langfuseRun.split(", ") : [];

if (report.langfuse) {
  const names = [...new Set(report.variants.flatMap((v) => v.langfuseRuns ?? []))];
  const found = await fetchLangfuseRuns(names, { since: new Date(new Date(report.generatedAt).getTime() - 7 * 24 * 3600_000).toISOString() });
  if (found) {
    report.langfuse = { ...report.langfuse, datasetId: found.datasetId ?? report.langfuse.datasetId ?? null, runs: { ...(report.langfuse.runs ?? {}), ...found.runs } };
    console.log(`linked ${Object.keys(found.runs).length} of ${names.length} Langfuse runs`);
  } else console.log("Langfuse keys not set: links to runs were not refreshed");
}
writeFileSync(`${dir}/structure-comparison.json`, JSON.stringify(report, null, 1));
writeFileSync(`${dir}/structure-comparison.html`, renderReport(report));
console.log(`rendered ${dir}/structure-comparison.html (${report.cells.length} generations)`);
