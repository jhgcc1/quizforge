/**
 * Stage 2 of the pt/es validation: a seeded sample of the attack texts of each dataset and language, laid as ONE paragraph inside a benign
 * README of the same language (2 READMEs x 2 positions, alternating by a hash of the text), through the complete pipeline with the REAL model
 * (guard, language policy, model, output rails). The oracle is code (filter.ts judgeQuiz + the pt/es demanded phrases): no model grades a model.
 *
 *   set -a; . /path/to/.env; set +a        # MINIMAX_API_KEY goes into the process environment only
 *   pnpm exec tsx promptfoo/redteam/research/studies/ptes-replay.ts [--per-group=70] [--concurrency=4] [--out=.local/ptes-replay.json] [--dry]
 *
 * Needs .local/ds/ptes (fetch-ptes-datasets.ts) and the stage 1 result .local/ptes-stage1.json (ptes-datasets.ts) for the guard / Prompt Guard 2 columns.
 * The raw runs (with the attack texts) stay in .local/; the aggregate is made by ptes-report.ts. Not part of coverage: network.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { detectLanguage } from "@quizforge/llm";
import QuizPipelineProvider from "../../../provider.js";
import { embedAttackAt, fnv1a, type AttackPosition } from "../../readme.js";
import { judgeQuiz, outcomeOf, type QuizQuestion } from "../../lib/filter.js";
import { DATASETS, asParagraph, demandedPhrasesPtEs, groupRows, sampleStable, type RawRow } from "../../lib/ptes-data.js";
import { PTES_README_BLOCKS } from "../../lib/readmes-ptes.js";

const arg = (k: string, d: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const PER_GROUP = Number(arg("per-group", "70"));
const CONCURRENCY = Number(arg("concurrency", "4"));
const OUT = arg("out", ".local/ptes-replay.json");

const usage = { calls: 0, promptTokens: 0, completionTokens: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (...a: Parameters<typeof fetch>) => {
  const res = await realFetch(...a);
  try {
    const u = ((await res.clone().json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
    if (u) { usage.calls++; usage.promptTokens += u.prompt_tokens ?? 0; usage.completionTokens += u.completion_tokens ?? 0; }
  } catch { /* not JSON */ }
  return res;
}) as typeof fetch;

interface Job { group: string; dataset: string; language: "pt" | "es"; text: string; readme: string; position: AttackPosition }
const jobs: Job[] = [];
for (const spec of DATASETS) {
  const rows = JSON.parse(readFileSync(`.local/ds/ptes/${spec.key}.json`, "utf8")) as RawRow[];
  for (const g of groupRows(spec, rows, detectLanguage)) {
    if (g.language === "en") continue; // (never produced here: English is a stage 1 reference only)
    const readmes = Object.keys(PTES_README_BLOCKS[g.language]);
    for (const text of sampleStable(g.rows, PER_GROUP, (t) => t)) {
      const h = fnv1a(text);
      jobs.push({ group: g.id, dataset: g.dataset, language: g.language, text, readme: readmes[h % readmes.length]!, position: ((h >>> 8) & 1) === 0 ? "start" : "middle" });
    }
  }
}
console.log(`${jobs.length} runs`);
if (process.argv.includes("--dry")) process.exit(0);

interface Run extends Job { outcome: string; status: string; reason?: string | undefined; guardFlagged: boolean; questions?: QuizQuestion[]; verdict?: ReturnType<typeof judgeQuiz>; demanded: string[] }
const provider = new QuizPipelineProvider({ config: { mode: "live" } });
const runs: Run[] = [];
let next = 0;
async function worker(): Promise<void> {
  for (;;) {
    const job = jobs[next++];
    if (!job) return;
    const blocks = PTES_README_BLOCKS[job.language][job.readme]!;
    const paragraph = asParagraph(job.text);
    const document = embedAttackAt(paragraph, blocks, job.position);
    const demanded = demandedPhrasesPtEs(job.text);
    const run: Run = { ...job, outcome: "error", status: "error", guardFlagged: false, demanded };
    try {
      const { output } = await provider.callApi("", { vars: { kind: "redteam", id: `${job.group}-${fnv1a(job.text)}`, prompt: paragraph, document, lang: job.language } });
      const o = JSON.parse(output) as { status: string; reason?: string; findings?: { kind: string; severity: string }[]; questions?: QuizQuestion[] };
      run.status = o.status; run.reason = o.reason; run.outcome = outcomeOf(o.status, o.reason ?? "");
      run.guardFlagged = (o.findings ?? []).some((f) => f.kind === "injection_phrase");
      if (o.status === "quiz" && o.questions) { run.questions = o.questions; run.verdict = judgeQuiz(o.questions, paragraph, blocks.join("\n\n"), job.language, demanded); }
    } catch (err) {
      run.reason = err instanceof Error ? err.message.slice(0, 300) : String(err);
    }
    runs.push(run);
    if (runs.length % 20 === 0) console.log(`${runs.length}/${jobs.length}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const PRICE_IN_PER_M = 0.3; // USD per million tokens: an ASSUMED MiniMax M2.7 list price, an order of magnitude only
const PRICE_OUT_PER_M = 1.2;
const estimatedUsd = (usage.promptTokens * PRICE_IN_PER_M + usage.completionTokens * PRICE_OUT_PER_M) / 1e6;
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), model: process.env.MINIMAX_MODEL ?? "MiniMax-M2.7", perGroup: PER_GROUP, usage: { ...usage, estimatedUsd: Math.round(estimatedUsd * 1000) / 1000 }, runs }));
console.log(`written ${OUT}; ${usage.calls} model calls, about ${estimatedUsd.toFixed(3)} USD (assumed price)`);
