/**
 * LLM regression run over the golden set.
 *   pnpm --filter @quizforge/evals eval            real MiniMax (needs MINIMAX_API_KEY), traced + scored in Langfuse
 *   pnpm --filter @quizforge/evals eval:offline    fake LLM: proves the harness itself works, costs nothing
 * The golden set lives in code (golden.ts) AND is mirrored to a Langfuse Dataset, so every run is an Experiment you can
 * compare in the UI (per item, per metric, across prompt/model versions).
 * The agent under test is the production one (generateQuiz); the judge is a DIFFERENT model (MINIMAX_JUDGE_MODEL, default MiniMax-M3).
 * Exit code 1 when any gated metric is below its threshold, so CI can block a prompt/model change that makes quizzes worse.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LangfuseClient } from "@langfuse/client";
import { createFakeLlm, createMiniMaxClient, fetchMarkdown, flushTracing, generateQuiz, initTracing, tracingEnabled, type LlmClient } from "@quizforge/llm";
import { GOLDEN, type GoldenItem } from "./golden.js";
import { MEAN_JUDGE_MIN, THRESHOLDS, evaluateQuiz, type QuizEval } from "./metrics.js";

const offline = process.argv.includes("--offline");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const root = fileURLToPath(new URL("..", import.meta.url));

function makeLlm(): LlmClient {
  if (offline) return createFakeLlm();
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error("MINIMAX_API_KEY is required (or pass --offline)");
  return createMiniMaxClient({ apiKey, baseUrl: process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1", model: process.env.MINIMAX_MODEL ?? "MiniMax-M2.7" });
}

async function loadText(item: GoldenItem): Promise<string> {
  if ("url" in item.source) return (await fetchMarkdown(item.source.url)).text;
  return readFileSync(`${root}${item.source.file}`, "utf8");
}

interface Outcome {
  id: string;
  ok: boolean;
  eval?: QuizEval;
  strategy?: string;
  rounds?: number;
  repairs?: number;
  calls?: number;
  costUsd?: number;
  seconds?: number;
  traceId?: string | undefined;
  error?: string;
  skipped?: string;
}

const llm = makeLlm();
/** A different model judges the generator's output (avoids self-preference bias). Offline = the fake plays both roles. */
const judgeLlm: LlmClient | undefined = offline
  ? undefined
  : createMiniMaxClient({ apiKey: process.env.MINIMAX_API_KEY!, baseUrl: process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1", model: process.env.MINIMAX_JUDGE_MODEL ?? "MiniMax-M3" });
const DATASET = "quizforge-golden";
const items = GOLDEN.filter((g) => !only || g.id === only);
const outcomes = new Map<string, Outcome>();

async function runItem(item: GoldenItem): Promise<Outcome> {
  if (offline && item.modelOnly) return { id: item.id, ok: true, skipped: "needs a real model (a fake LLM copies the injected text)" };
  const started = Date.now();
  try {
    const sourceText = await loadText(item);
    const r = await generateQuiz({
      llm,
      ...(judgeLlm ? { judgeLlm, judgeSamples: 3 } : {}), // median of 3 judgements: one noisy outlier cannot flip the gate
      input: { sourceText, numQuestions: item.numQuestions, strategy: item.strategy, critique: item.critique },
      trace: { sessionId: `golden-${item.id}`, userId: "eval", tags: ["eval", offline ? "offline" : "live", item.id] },
    });
    const ev = await evaluateQuiz({ questions: r.questions, sourceText, judgeOverall: r.judge?.overall, expect: item.expect });
    const cost = (r.usage.promptTokens * 0.3 + r.usage.completionTokens * 1.2) / 1e6;
    return { id: item.id, ok: ev.failures.length === 0, eval: ev, strategy: r.strategy, rounds: r.rounds, repairs: r.repairs, calls: r.budget.calls, costUsd: cost, seconds: (Date.now() - started) / 1000, traceId: r.traceId };
  } catch (err) {
    return { id: item.id, ok: false, error: `${(err as Error).name}: ${(err as Error).message}`.slice(0, 300), seconds: (Date.now() - started) / 1000 };
  }
}

initTracing();
if (tracingEnabled() && !offline && !only) {
  const lf = new LangfuseClient();

  // 1. mirror the golden set into a Langfuse Dataset (items are upserted by id, so this is idempotent)
  await lf.api.datasets.create({ name: DATASET, description: "QuizForge golden set: documents the quiz generator must handle well", metadata: { thresholds: THRESHOLDS } });
  for (const g of items) {
    await lf.api.datasetItems.create({
      datasetName: DATASET,
      id: `golden-${g.id}`,
      input: { id: g.id, source: g.source, numQuestions: g.numQuestions, strategy: g.strategy, critique: g.critique },
      expectedOutput: { thresholds: THRESHOLDS, expect: g.expect ?? null },
      metadata: { modelOnly: g.modelOnly ?? false },
    });
  }

  // 2. run the production agent over the dataset: one Experiment run, each item linked to its trace, metrics as scores
  const dataset = await lf.dataset.get(DATASET);
  await dataset.runExperiment({
    name: "quizforge-golden-set",
    runName: `${llm.model}+judge-${judgeLlm?.model}-${new Date().toISOString().slice(0, 16)}`,
    description: "Regression run of the quiz generator over the golden dataset",
    metadata: { model: llm.model, judge: judgeLlm?.model, sha: process.env.GITHUB_SHA ?? "local" },
    task: async (item) => {
      const id = (item.input as { id: string }).id;
      const out = await runItem(items.find((g) => g.id === id)!);
      outcomes.set(out.id, out);
      return { ok: out.ok, error: out.error, strategy: out.strategy };
    },
    evaluators: [
      async ({ input }) =>
        Object.entries(outcomes.get((input as { id: string }).id)?.eval?.scores ?? {}).map(([name, value]) => ({ name, value, dataType: "NUMERIC" as const })),
    ],
  });
} else {
  for (const g of items) outcomes.set(g.id, await runItem(g));
}
await flushTracing();

/* ---------------------------------------------------------------- report + gate */
const rows = [...outcomes.values()];
const pad = (s: string, n: number) => s.padEnd(n);
console.log(`\nmodel=${llm.model} judge=${judgeLlm?.model ?? "(same)"}${offline ? " (offline harness check)" : ""}  thresholds=${JSON.stringify(THRESHOLDS)}\n`);
console.log(pad("item", 18), pad("result", 8), pad("strategy", 20), "grounded lint  judge  divers relev  cover lang  inject calls cost$   secs");
for (const o of rows) {
  const s = o.eval?.scores ?? {};
  const f = (k: string) => (s[k] === undefined ? "  -  " : s[k]!.toFixed(2).padStart(5));
  console.log(pad(o.id, 18), pad(o.skipped ? "skipped" : o.ok ? "PASS" : "FAIL", 8), pad(o.strategy ?? "-", 20), f("grounded"), f("lint_pass"), f("judge_overall"), f("question_diversity"), f("relevance"), f("coverage"), f("language_match"), f("injection_resisted"), String(o.calls ?? "-").padStart(5), (o.costUsd ?? 0).toFixed(4), (o.seconds ?? 0).toFixed(0).padStart(5));
  for (const m of o.eval?.failures ?? []) console.log(`   ✘ ${m}`);
  if (o.error) console.log(`   ✘ ${o.error}`);
  if (o.skipped) console.log(`   · ${o.skipped}`);
}
const judged = rows.map((o) => o.eval?.scores.judge_overall).filter((v): v is number => v !== undefined);
console.log(`\nmean judge_overall: ${judged.length ? (judged.reduce((a, b) => a + b, 0) / judged.length).toFixed(3) : "n/a"}   total cost: $${rows.reduce((a, o) => a + (o.costUsd ?? 0), 0).toFixed(4)}`);
writeFileSync(`${root}report.json`, JSON.stringify({ model: llm.model, offline, at: new Date().toISOString(), thresholds: THRESHOLDS, results: rows }, null, 2));

const failed = rows.filter((o) => !o.ok);
// dataset-level judge bar: the mean is robust to a single noisy judgement, per-item floors are not
const meanJudge = judged.length ? judged.reduce((a, b) => a + b, 0) / judged.length : undefined;
const judgeBarFailed = !offline && meanJudge !== undefined && meanJudge < MEAN_JUDGE_MIN;
if (judgeBarFailed) console.log(`\n✘ mean judge_overall ${meanJudge!.toFixed(3)} < ${MEAN_JUDGE_MIN}`);
console.log(failed.length || judgeBarFailed ? `\n${failed.length} item(s) FAILED${judgeBarFailed ? " and the dataset-level judge bar was missed" : ""}: quality gate FAILED` : "\nquality gate PASSED");
process.exit(failed.length || judgeBarFailed ? 1 : 0);
