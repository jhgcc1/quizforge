/** Live smoke test: README -> MiniMax -> validated quiz, traced to Langfuse. Usage: pnpm smoke [url] [strategy] [critique] */
import { checkGrounding } from "@quizforge/core";
import { createMiniMaxClient, fetchMarkdown, flushTracing, generateQuiz, type StrategyRequest } from "../index.js";

const url = process.argv[2] ?? "https://github.com/pipecat-ai/pipecat/blob/main/README.md";
const strategy = (process.argv[3] ?? "auto") as StrategyRequest;
const critique = (process.argv[4] ?? "true") === "true";

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) throw new Error("MINIMAX_API_KEY missing (see .env)");

const src = await fetchMarkdown(url);
console.log(`source: ${src.rawUrl} (${src.text.length} chars, sha ${src.sha256.slice(0, 12)})`);

const llm = createMiniMaxClient({
  apiKey,
  baseUrl: process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1",
  model: process.env.MINIMAX_MODEL ?? "MiniMax-M2.7",
});

const t0 = Date.now();
const r = await generateQuiz({
  llm,
  input: { sourceText: src.text, numQuestions: 6, strategy, critique },
  trace: { sessionId: `smoke-${src.sha256.slice(0, 8)}`, userId: "smoke", tags: ["smoke"] },
});
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\nmodel=${r.model} strategy=${r.strategy} (${r.routeReason}) rounds=${r.rounds} repairs=${r.repairs} time=${secs}s`);
console.log(`calls=${r.budget.calls} tokens: prompt=${r.usage.promptTokens} completion=${r.usage.completionTokens}`);
console.log(`trail: ${r.trail.join(" -> ")}`);
console.log(`grounded=${checkGrounding({ questions: r.questions }, src.text).ok} quality=${r.quality?.toFixed(2) ?? "n/a"} lint=${r.metrics.lintPass.toFixed(2)} diffSpread=${r.metrics.difficultySpread.toFixed(2)}`);
if (r.judge) console.log(`judge: ${JSON.stringify(r.judge.scores)}`);
console.log(`langfuse trace: ${r.traceId ?? "(tracing off)"}\n`);
r.questions.forEach((q, i) => {
  console.log(`${i + 1}. [${q.difficulty}/${q.type}] ${q.prompt}`);
  q.options.forEach((o, j) => console.log(`   ${q.correct.includes(j) ? "✔" : " "} ${j + 1}) ${o}`));
});
await flushTracing();
