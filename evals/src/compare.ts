/**
 * Compare quiz-generation STRUCTURES (3 LangGraph topologies) x PROMPTS (3 variants) on the golden set.
 *   pnpm --filter @quizforge/evals compare                  real MiniMax + Langfuse + local embeddings (a few cents, ~15 min)
 *   pnpm --filter @quizforge/evals compare --offline        fake LLM + TF-IDF: proves the harness, costs nothing
 *   options: --variants=a,b (substring of "structure/prompt")  --only=item,item  --samples=3 (judge runs)  --concurrency=3
 *            --no-langfuse   --out=docs/eval   --merge=<previous json>  (adds one more repetition to an earlier run: the
 *            difference between repetitions is the run-to-run noise, which the report uses to decide whether a lead is real)
 * Every variant is one Langfuse Experiment (dataset run) on the dataset `quizforge-golden`, so the runs can be put side
 * by side in the UI. Each generated quiz is scored by three kinds of instrument that are combined in a weighted average
 * (composite.ts): an LLM judge (a different model than the generator), deterministic checks, and embedding cosine
 * similarity (against hand-written reference questions, the document, and the quiz itself).
 * Output: <out>/structure-comparison.html (the report) and .json (the raw numbers).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LangfuseClient } from "@langfuse/client";
import { createFakeLlm, createMiniMaxClient, flushTracing, generateQuiz, initTracing, tracingEnabled, type LlmClient } from "@quizforge/llm";
import { composite, COMPOSITE_WEIGHTS } from "./composite.js";
import { DATASET, syncDataset } from "./dataset.js";
import { cachedEmbedder, EMBEDDING_MODEL, localEmbedder } from "./embeddings.js";
import { ensureModelPrices } from "./ensure-models.js";
import { GOLDEN, type GoldenItem } from "./golden.js";
import { evaluateQuiz } from "./metrics.js";
import { loadReferences } from "./references.js";
import { renderReport, type CellResult, type CompareReport } from "./report.js";
import { semanticScores, type Reference } from "./semantic.js";
import { tfidfEmbedder, type Embedder } from "./similarity.js";
import { VARIANTS, type Variant } from "./variants.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);
const offline = flag("offline");
const useLangfuse = !offline && !flag("no-langfuse");
const samples = Number(arg("samples") ?? 3);
const concurrency = Number(arg("concurrency") ?? 3);
const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = resolve(root, "..", arg("out") ?? "docs/eval");
const onlyItems = arg("only")?.split(",");
const onlyVariants = arg("variants")?.split(",");
const previous: CompareReport | undefined = arg("merge") ? (JSON.parse(readFileSync(resolve(root, "..", arg("merge")!), "utf8")) as CompareReport) : undefined;
const rep = previous ? Math.max(...previous.cells.map((c) => c.rep ?? 1)) + 1 : 1;

const items = GOLDEN.filter((g) => !offline || !g.modelOnly).filter((g) => !onlyItems || onlyItems.includes(g.id));
const variants = VARIANTS.filter((v) => !onlyVariants || onlyVariants.some((s) => v.id.includes(s)));
if (!items.length || !variants.length) throw new Error("nothing to run: check --only / --variants");

const apiKey = process.env.MINIMAX_API_KEY;
if (!offline && !apiKey) throw new Error("MINIMAX_API_KEY is required (or pass --offline)");
const mk = (model: string) => createMiniMaxClient({ apiKey: apiKey!, baseUrl: process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1", model });
const llm: LlmClient = offline ? createFakeLlm() : mk(process.env.MINIMAX_MODEL ?? "MiniMax-M2.7");
const judgeLlm: LlmClient | undefined = offline ? undefined : mk(process.env.MINIMAX_JUDGE_MODEL ?? "MiniMax-M3");

const texts = new Map<string, string>(items.map((g) => [g.id, readFileSync(`${root}${(g.source as { file: string }).file}`, "utf8")]));
const refs = new Map<string, Reference[]>(items.map((g) => [g.id, loadReferences(g.id).questions]));
const othersOf = (id: string): Reference[] => [...refs].filter(([k]) => k !== id).flatMap(([, v]) => v);

console.log(offline ? "offline: fake LLM + TF-IDF embeddings" : `loading embedding model ${EMBEDDING_MODEL} (first run downloads ~120 MB)...`);
const embedder: Embedder = offline
  ? tfidfEmbedder([...texts.values(), ...[...refs.values()].flat().map((r) => `${r.prompt} ${r.answer}`)])
  : cachedEmbedder(await localEmbedder());

const cells: CellResult[] = [];
const cellKey = (v: Variant, g: GoldenItem) => `${v.id}|${g.id}`;
const done = new Map<string, CellResult>();

async function runCell(v: Variant, g: GoldenItem): Promise<CellResult> {
  const started = Date.now();
  const base = { variant: v.id, structure: v.structure.id, prompt: v.prompt.id, item: g.id, rep };
  try {
    const sourceText = texts.get(g.id)!;
    const r = await generateQuiz({
      llm,
      ...(judgeLlm ? { judgeLlm, judgeSamples: samples } : {}),
      input: { sourceText, numQuestions: g.numQuestions, ...v.structure.input, promptVariant: v.prompt.id },
      trace: { sessionId: `compare-${v.id}-${g.id}-r${rep}`, userId: "eval", tags: ["eval", "compare", v.structure.id, v.prompt.id, g.id, `rep${rep}`] },
    });
    const ev = await evaluateQuiz({ questions: r.questions, sourceText, judgeOverall: r.judge?.overall, expect: g.expect });
    const sem = await semanticScores({ questions: r.questions, references: refs.get(g.id)!, sourceText, embedder, otherReferences: othersOf(g.id) });
    const scores = { ...ev.scores, ...sem };
    const c = composite(scores);
    const cost = (r.usage.promptTokens * 0.3 + r.usage.completionTokens * 1.2) / 1e6;
    return {
      ...base, ok: true, scores, composite: c.value, gated: c.gated, failures: ev.failures, strategy: r.strategy, rounds: r.rounds, repairs: r.repairs, calls: r.budget.calls,
      costUsd: cost, seconds: (Date.now() - started) / 1000, traceId: r.traceId ?? null, trail: r.trail, questions: r.questions.map((q) => ({ prompt: q.prompt, options: q.options, correct: q.correct, difficulty: q.difficulty })),
    };
  } catch (err) {
    return { ...base, ok: false, scores: {}, composite: 0, gated: false, failures: [], error: `${(err as Error).name}: ${(err as Error).message}`.slice(0, 300), seconds: (Date.now() - started) / 1000, trail: [], questions: [] };
  }
}

async function mapLimit<T>(xs: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, async () => { while (next < xs.length) await fn(xs[next++]!); }));
}

initTracing();
const lf = useLangfuse && tracingEnabled() ? new LangfuseClient() : undefined;
if (useLangfuse && !lf) console.log("Langfuse keys not set: running without experiments");
if (lf) {
  const priced = await ensureModelPrices(lf);
  if (priced.length) console.log(`registered Langfuse prices for: ${priced.join(", ")}`);
  await syncDataset(lf, GOLDEN);
}
const stamp = new Date().toISOString().slice(0, 16);
const experimentName = "quizforge-structure-comparison";
const runNames = new Map<string, string>();

for (const v of variants) {
  const t0 = Date.now();
  if (lf) {
    const dataset = await lf.dataset.get(DATASET);
    const runName = `${v.id}@${stamp}#r${rep}`;
    runNames.set(v.id, [...(runNames.get(v.id) ? [runNames.get(v.id)!] : []), runName].join(", "));
    dataset.items = dataset.items.filter((it) => items.some((g) => `golden-${g.id}` === it.id));
    await dataset.runExperiment({
      name: experimentName,
      runName,
      description: `${v.structure.title} | prompt: ${v.prompt.title}`,
      metadata: { rep, structure: v.structure.id, prompt: v.prompt.id, graph: v.structure.graph, model: llm.model, judge: judgeLlm?.model, embeddings: EMBEDDING_MODEL, weights: COMPOSITE_WEIGHTS },
      maxConcurrency: concurrency,
      task: async (item) => {
        const g = items.find((x) => x.id === (item.input as { id: string }).id)!;
        const cell = await runCell(v, g);
        done.set(cellKey(v, g), cell);
        return { ok: cell.ok, composite: cell.composite, error: cell.error };
      },
      evaluators: [
        async ({ input }) => {
          const cell = done.get(`${v.id}|${(input as { id: string }).id}`);
          const s = { ...(cell?.scores ?? {}), composite: cell?.composite ?? 0 };
          return Object.entries(s).map(([name, value]) => ({ name, value, dataType: "NUMERIC" as const }));
        },
      ],
      runEvaluators: [
        async () => {
          const mine = items.map((g) => done.get(cellKey(v, g))?.composite ?? 0);
          return { name: "composite_mean", value: mine.reduce((a, b) => a + b, 0) / mine.length, dataType: "NUMERIC" as const };
        },
      ],
    });
  } else {
    await mapLimit(items, concurrency, async (g) => void done.set(cellKey(v, g), await runCell(v, g)));
  }
  const mine = items.map((g) => done.get(cellKey(v, g))!);
  cells.push(...mine);
  const mean = mine.reduce((a, c) => a + c.composite, 0) / mine.length;
  console.log(`${v.id.padEnd(32)} composite=${mean.toFixed(3)}  failed=${mine.filter((c) => !c.ok).length}/${mine.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
await flushTracing();

const report: CompareReport = {
  generatedAt: new Date().toISOString(),
  offline,
  models: { generator: llm.model, judge: judgeLlm?.model ?? "(same, offline)", embeddings: offline ? "TF-IDF (offline)" : EMBEDDING_MODEL, judgeSamples: offline ? 0 : samples },
  weights: { ...COMPOSITE_WEIGHTS },
  items: items.map((g) => ({ id: g.id, numQuestions: g.numQuestions, references: refs.get(g.id)!.length, origin: g.origin ?? ("file" in g.source ? g.source.file : g.source.url) })),
  variants: variants.map((v) => ({ id: v.id, structure: v.structure.id, structureTitle: v.structure.title, graph: v.structure.graph, prompt: v.prompt.id, promptTitle: v.prompt.title, langfuseRun: [previous?.variants.find((p) => p.id === v.id)?.langfuseRun, runNames.get(v.id)].filter(Boolean).join(", ") || null })),
  langfuse: lf ? { dataset: DATASET, experiment: experimentName, project: null } : null,
  cells: [...(previous?.cells.map((x) => ({ ...x, rep: x.rep ?? 1 })) ?? []), ...cells],
};
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/structure-comparison.json`, JSON.stringify(report, null, 1));
writeFileSync(`${outDir}/structure-comparison.html`, renderReport(report));
console.log(`\nreport: ${outDir}/structure-comparison.html`);
