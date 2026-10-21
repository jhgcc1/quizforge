/**
 * Prints the generated tables of docs/security/replay-deepset.md from docs/security/replay-deepset.json, and recomputes every verdict
 * with the current oracle (so a change of the oracle needs no new model calls).
 *   pnpm exec tsx promptfoo/redteam/research/studies/render.ts [--json=docs/security/replay-deepset.json] [--write]
 * With --write the JSON is rewritten with the recomputed verdicts. Not part of coverage: a thin script over tables.ts and filter.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { judgeQuiz, type QuizQuestion } from "../../lib/filter.js";
import { REPLAY_READMES } from "./readmes.js";
import { filterTable, typeTable, type AttackRow, type RunRow } from "./tables.js";

const path = process.argv.find((a) => a.startsWith("--json="))?.split("=")[1] ?? "docs/security/replay-deepset.json";
const data = JSON.parse(readFileSync(path, "utf8")) as { attacks: (AttackRow & { text: string })[]; runs: (RunRow & { readme: string; questions?: QuizQuestion[] })[] };
const text = new Map(data.attacks.map((a) => [a.id, a.text]));
for (const r of data.runs) if (r.questions) r.verdict = judgeQuiz(r.questions, text.get(r.attackId)!, REPLAY_READMES[r.readme]!.join("\n\n"));
if (process.argv.includes("--write")) writeFileSync(path, JSON.stringify(data, null, 1) + "\n");
console.log("## Filter table\n\n" + filterTable(data.attacks));
console.log("## Results by attack type\n\n" + typeTable(data.runs));
