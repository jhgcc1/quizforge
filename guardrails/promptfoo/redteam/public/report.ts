/**
 * Markdown report of a public-dataset run (the job summary of `guardrails/run-suite.sh redteam-public`). Reports, never fails.
 *
 *   tsx guardrails/promptfoo/redteam/public/report.ts guardrails/promptfoo/out/redteam-public.json guardrails/promptfoo/out/public/build.json [--json out.json]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readResults } from "../report.js";
import { alertLines, skippedSummary, summarize, type BuildInfo, type PublicSummary } from "./aggregate.js";

const pct = (n: number, of: number): string => (of === 0 ? "0%" : `${Math.round((n / of) * 1000) / 10}%`);

export function renderMarkdown(s: PublicSummary): string {
  const out: string[] = [`### Red team: public datasets (seed ${s.config.seed}, ${s.cases} cases)`, ""];
  out.push("| Source | Licence | Status | Rows | Pinned revision | Read revision |", "|---|---|---|---:|---|---|");
  for (const x of s.sources) out.push(`| ${x.id} | ${x.license} | ${x.status}${x.error ? ": " + x.error : ""} | ${x.rows} | ${x.pinnedRevision.slice(0, 12)} | ${(x.observedRevision ?? "?").slice(0, 12)}${x.drifted ? " (drifted)" : ""} |`);
  out.push("", "**Stage A: supported languages, before the model**", "", "| Dataset / language | Pool | n | Blocked | Rules flag | PG2 flags | Either | Passed both |", "|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const a of s.stageA) out.push(`| ${a.dataset} / ${a.language} | ${a.pool} | ${a.n} | ${a.blocked} | ${a.rulesFlagged} (${pct(a.rulesFlagged, a.n)}) | ${a.pg2Flagged} (${pct(a.pg2Flagged, a.n)}) | ${a.either} (${pct(a.either, a.n)}) | ${a.passedBoth} (${pct(a.passedBoth, a.n)}) |`);
  const b = s.stageB;
  out.push("", `**Stage B: real model**: ${b.cases} cases, ${b.rejectedBeforeModel} rejected before the model, ${b.rejectedByRails} by the rails, ${b.quizzes} quizzes, ${b.contaminated} contaminated, ${b.errors} errors.`);
  for (const c of b.contaminatedCases) out.push(`- contaminated ${c.dataset}/${c.language}: ${c.detail} | layers: ${c.layers} | text: ${c.text.slice(0, 160)}`);
  const bl = s.blockedLanguages;
  out.push("", `**Blocked languages**: ${bl.cases} documents, ${bl.rejectedBeforeModel} rejected before the model, ${bl.reachedModel} REACHED THE MODEL.`, "", "| Language | Cases | Rejected before the model | Reached the model |", "|---|---:|---:|---:|");
  for (const [l, c] of Object.entries(bl.byLanguage)) out.push(`| ${l} | ${c.cases} | ${c.rejectedBeforeModel} | ${c.reachedModel} |`);
  const f = s.foreignInSupported;
  out.push("", `**Informational, a foreign sentence inside a supported README**: ${f.cases} documents: ${f.blockedByGuard} blocked by the guard, ${f.rejectedByLanguage} refused by the language policy, ${f.flaggedOnly} flagged only, ${f.passed} passed.`);
  out.push("", `**Encoded dataset texts**: ${Object.entries(s.encoded).map(([k, e]) => `${k} ${e.cases} cases, ${e.blockedBeforeModel} blocked, ${e.reachedModel} reached the model`).join("; ") || "none"}.`);
  out.push("", `**Benign control**: ${s.benign.cases} documents, ${s.benign.blocked} blocked, ${s.benign.rulesFlagged} flagged by a rule, ${s.benign.pg2Flagged} by Prompt Guard 2.`);
  return out.join("\n");
}

function main(): void {
  const argv = process.argv.slice(2);
  const [results, buildFile] = argv;
  if (!results || !buildFile) throw new Error("usage: report.ts <results.json> <build.json> [--json out.json]");
  const build = existsSync(buildFile) ? (JSON.parse(readFileSync(buildFile, "utf8")) as BuildInfo) : undefined;
  const s = build && existsSync(results) ? summarize(readResults(results), build) : skippedSummary(build, "no results");
  console.log(renderMarkdown(s));
  for (const l of alertLines(s)) console.error(l);
  const json = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : undefined;
  if (json) writeFileSync(json, JSON.stringify(s, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
