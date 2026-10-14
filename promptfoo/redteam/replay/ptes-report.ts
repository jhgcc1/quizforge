/**
 * Builds the committed aggregate of the pt/es dataset validation from the local raw results.
 *   pnpm exec tsx promptfoo/redteam/replay/ptes-report.ts [--stage1=.local/ptes-stage1.json] [--replay=.local/ptes-replay.json] [--out=docs/security/replay-ptes.json]
 * The aggregate has counts only, plus (for the datasets whose licence allows quoting) a few attack texts. The Weni texts never leave .local/.
 * Not part of coverage: a thin script over ptes-data.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { INJECTION_RULES, inspectText } from "@quizforge/core";
import { DATASETS, reasonCounts, replaySummary, replayTable, stage1Table, summarize, type RowResult } from "./ptes-data.js";

const arg = (k: string, d: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const stage1 = JSON.parse(readFileSync(arg("stage1", ".local/ptes-stage1.json"), "utf8")) as { rows: Record<string, RowResult[]> };
const replay = JSON.parse(readFileSync(arg("replay", ".local/ptes-replay.json"), "utf8")) as { model: string; at: string; perGroup: number; usage: unknown; runs: { group: string; dataset: string; language: string; text: string; readme: string; position: string; outcome: string; guardFlagged: boolean; verdict?: { contaminated: boolean; reasons: string[] }; questions?: { prompt: string }[] }[] };
const OUT = arg("out", "docs/security/replay-ptes.json");
// the replay ran while the rules were being tuned: recount "guard flagged" with the rules of this commit (the model output does not depend on it, the guard only flags)
for (const r of replay.runs) r.guardFlagged = inspectText(r.text).findings.some((f) => f.kind === "injection_phrase");
const categoryOf = new Map(INJECTION_RULES.map((r) => [r.id, r.category]));

const mayQuote = new Set(DATASETS.filter((d) => d.texts === "may be quoted").map((d) => d.key));
const groups = Object.keys(stage1.rows);
const s1 = groups.map((g) => summarize(g, stage1.rows[g]!));
const s2 = groups.map((g) => replaySummary(g, replay.runs));
const contaminated = replay.runs.filter((r) => r.verdict?.contaminated && mayQuote.has(r.dataset)).map((r) => ({ group: r.group, readme: r.readme, position: r.position, text: r.text.replace(/\s+/g, " ").slice(0, 240), reasons: r.verdict!.reasons.slice(0, 3), firstQuestion: r.questions?.[0]?.prompt }));
const perRule: Record<string, Record<string, number>> = {};
const perCategory: Record<string, Record<string, number>> = {};
for (const g of groups) {
  for (const r of stage1.rows[g]!) {
    for (const id of new Set(r.rules)) (perRule[g] ??= {})[id] = ((perRule[g] ??= {})[id] ?? 0) + 1;
    for (const c of new Set(r.rules.map((id) => categoryOf.get(id) ?? id))) (perCategory[g] ??= {})[c] = ((perCategory[g] ??= {})[c] ?? 0) + 1;
  }
}

writeFileSync(OUT, JSON.stringify({
  about: "Validation of the guard and the pipeline with PUBLIC Portuguese and Spanish attack datasets (chatbot-style direct attacks, laid as the body of a document). Counts only; the texts of Weni/prompt-injections-1.0.0 (no declared licence) are not in this file.",
  datasets: DATASETS.map((d) => ({ key: d.key, name: d.name, license: d.license, texts: d.texts })),
  at: replay.at, model: replay.model, replaySamplePerGroup: replay.perGroup, usage: replay.usage,
  stage1: s1, ruleHitsByGroup: perRule, categoryHitsByGroup: perCategory, replay: s2,
  oracleReasonCounts: reasonCounts(replay.runs),
  contaminatedExamples: contaminated,
}, null, 1) + "\n");
console.log("## Stage 1\n\n" + stage1Table(s1) + "\n## Replay\n\n" + replayTable(s2));
