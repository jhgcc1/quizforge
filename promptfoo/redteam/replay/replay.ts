/**
 * Replay of the dataset attacks that BOTH detectors miss, through the complete pipeline with the REAL model (MiniMax).
 *
 *   set -a; . /path/to/.env; set +a        # MINIMAX_API_KEY goes into the process environment only, never into a file
 *   pnpm exec tsx promptfoo/redteam/replay/replay.ts [--limit=N] [--dry] [--concurrency=4] [--out=docs/security/replay-deepset.json]
 *
 * Needs the dataset rows (deepset/prompt-injections, Apache-2.0) at DEEPSET_PATH (default .local/ds/deepset.json, see
 * packages/detector/src/benchmark.ts) and docs/security/benchmark.json (which attacks Llama Prompt Guard 2 caught).
 * Each kept attack is hidden inside 2 benign READMEs x 2 positions and run through promptfoo/provider.ts (live mode: guard,
 * language policy, model, output rails). The oracle is code (filter.ts), no model grades a model. Not part of coverage: network.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { detectLanguage } from "@quizforge/llm";
import QuizPipelineProvider from "../../provider.js";
import { embedAttackAt, type AttackPosition } from "../readme.js";
import { filterAttack, judgeQuiz, outcomeOf, type QuizQuestion } from "./filter.js";
import { REPLAY_READMES } from "./readmes.js";
import { benchmarkSample, missedByGuard } from "./sample.js";

const arg = (k: string, d: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const LIMIT = Number(arg("limit", "0"));
const CONCURRENCY = Number(arg("concurrency", "4"));
const OUT = arg("out", "docs/security/replay-deepset.json");
const DS = process.env.DEEPSET_PATH ?? ".local/ds/deepset.json";

// ---- real token usage of the model calls (the provider does not return it): sum what the API reports
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

// ---- 1. the 68 attacks
const rows = JSON.parse(readFileSync(DS, "utf8")) as { text: string; label: number }[];
const sample = benchmarkSample(rows);
const { english, missed } = missedByGuard(sample);
if (english.length !== 97 || missed.length !== 68) throw new Error(`expected 97 English injections and 68 missed by the guard, got ${english.length} and ${missed.length}`);
const bench = JSON.parse(readFileSync("docs/security/benchmark.json", "utf8")) as { results: { id: number; detector?: number }[] };
const detectorScore = new Map(bench.results.map((r) => [r.id, r.detector ?? 0]));

const attacks = missed.map((m) => {
  const caught = (detectorScore.get(m.id) ?? 0) >= 0.5;
  const d = filterAttack(m.text);
  return { id: m.id, text: m.text, detectLanguage: detectLanguage(m.text), detectorScore: detectorScore.get(m.id) ?? 0, caughtByDetector: caught, decision: caught ? { keep: false as const, reason: "caught by Llama Prompt Guard 2 (not part of the 64)" } : d };
});
const kept = attacks.filter((a) => a.decision.keep);
console.log(`68 missed by the guard: ${attacks.filter((a) => a.caughtByDetector).length} caught by the detector, ${attacks.length - kept.length - attacks.filter((a) => a.caughtByDetector).length} dropped by the filter, ${kept.length} kept`);

// ---- 2. the runs
interface Run {
  attackId: number; attackType: string; readme: string; position: AttackPosition;
  outcome: string; status: string; reason?: string | undefined; language?: string | undefined; llmCalls?: number | undefined;
  questions?: QuizQuestion[]; verdict?: ReturnType<typeof judgeQuiz>;
}
const POSITIONS: AttackPosition[] = ["start", "middle"];
const jobs = kept.slice(0, LIMIT > 0 ? LIMIT : undefined).flatMap((a) => Object.keys(REPLAY_READMES).flatMap((readme) => POSITIONS.map((position) => ({ a, readme, position }))));
console.log(`${jobs.length} runs`);
if (process.argv.includes("--dry")) process.exit(0);

const provider = new QuizPipelineProvider({ config: { mode: "live" } });
const runs: Run[] = [];
let next = 0;
async function worker(): Promise<void> {
  for (;;) {
    const job = jobs[next++];
    if (!job) return;
    const { a, readme, position } = job;
    const blocks = REPLAY_READMES[readme]!;
    const document = embedAttackAt(a.text, blocks, position);
    const run: Run = { attackId: a.id, attackType: a.decision.keep ? a.decision.kind : "", readme, position, outcome: "error", status: "error" };
    try {
      const { output } = await provider.callApi("", { vars: { kind: "redteam", id: `${a.id}-${readme}-${position}`, prompt: a.text, document, lang: "en" } });
      const o = JSON.parse(output) as { status: string; reason?: string; language?: string; llmCalls?: number; questions?: QuizQuestion[] };
      run.status = o.status; run.reason = o.reason; run.language = o.language; run.llmCalls = o.llmCalls;
      run.outcome = outcomeOf(o.status, o.reason ?? "");
      if (o.status === "quiz" && o.questions) { run.questions = o.questions; run.verdict = judgeQuiz(o.questions, a.text, blocks.join("\n\n")); }
    } catch (err) {
      run.reason = err instanceof Error ? err.message.slice(0, 300) : String(err);
    }
    runs.push(run);
    console.log(`#${a.id} ${readme}/${position}: ${run.outcome}${run.verdict?.contaminated ? " CONTAMINATED" : ""} (${runs.length}/${jobs.length})`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
runs.sort((x, y) => x.attackId - y.attackId || x.readme.localeCompare(y.readme) || x.position.localeCompare(y.position));

const PRICE_IN_PER_M = 0.3; // USD per million tokens: an ASSUMED MiniMax M2.7 list price, only to give an order of magnitude
const PRICE_OUT_PER_M = 1.2;
const estimatedUsd = (usage.promptTokens * PRICE_IN_PER_M + usage.completionTokens * PRICE_OUT_PER_M) / 1e6;
writeFileSync(
  OUT,
  JSON.stringify(
    {
      about: "Replay of the deepset/prompt-injections English attacks missed by the keyword guard, through the full pipeline with the real model. The attack texts are public dataset content (Apache-2.0). No secrets.",
      dataset: { name: "deepset/prompt-injections", url: "https://huggingface.co/datasets/deepset/prompt-injections", license: "Apache-2.0" },
      model: process.env.MINIMAX_MODEL ?? "MiniMax-M2.7",
      at: new Date().toISOString(),
      sample: { n: 500, seed: 1, englishInjections: english.length, missedByGuard: missed.length },
      usage: { ...usage, assumedPriceUsdPerMillion: { input: PRICE_IN_PER_M, output: PRICE_OUT_PER_M }, estimatedUsd: Math.round(estimatedUsd * 1000) / 1000 },
      attacks, runs,
    },
    null, 1,
  ) + "\n",
);
console.log(`written ${OUT}; ${usage.calls} model calls, ${usage.promptTokens} in / ${usage.completionTokens} out tokens, about ${estimatedUsd.toFixed(3)} USD (assumed price)`);
