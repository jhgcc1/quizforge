/** Re-render the HTML from the saved numbers (no LLM calls): pnpm --filter @quizforge/evals report [docs/eval] */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderReport, type CompareReport } from "./report.js";

const dir = resolve(fileURLToPath(new URL("..", import.meta.url)), "..", process.argv[2] ?? "docs/eval");
const report = JSON.parse(readFileSync(`${dir}/structure-comparison.json`, "utf8")) as CompareReport;
writeFileSync(`${dir}/structure-comparison.html`, renderReport(report));
console.log(`rendered ${dir}/structure-comparison.html (${report.cells.length} generations)`);
