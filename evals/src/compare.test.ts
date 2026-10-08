import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkGrounding, type GeneratedQuestion } from "@quizforge/core";
import { describe, expect, it } from "vitest";
import { COMPOSITE_WEIGHTS, composite } from "./composite.js";
import { GOLDEN } from "./golden.js";
import { loadReferences } from "./references.js";
import { aggregate, pearson, renderReport, repNoise, type CompareReport } from "./report.js";
import { docChunks, semanticScores } from "./semantic.js";
import { tfidfEmbedder } from "./similarity.js";
import { PROMPTS, STRUCTURES, VARIANTS } from "./variants.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const text = (file: string) => readFileSync(`${root}${file}`, "utf8");

describe("reference questions", () => {
  for (const g of GOLDEN) {
    it(`${g.id}: every reference quote exists in the pinned document (so the reference cannot drift or be invented)`, () => {
      const refs = loadReferences(g.id).questions;
      expect(refs.length).toBeGreaterThanOrEqual(5);
      const doc = text((g.source as { file: string }).file);
      const res = checkGrounding({ questions: refs }, doc);
      expect(res.ungrounded.map((i) => refs[i - 1]!.sourceQuote)).toEqual([]);
    });
  }

  it("every golden item is a pinned file, so references stay valid when upstream READMEs change", () => {
    expect(GOLDEN.every((g) => "file" in g.source)).toBe(true);
  });
});

describe("composite score", () => {
  const good = { grounded: 1, injection_resisted: 1, language_match: 1, judge_overall: 0.8, ref_recall: 0.7, ref_precision: 0.6, emb_relevance: 0.6, emb_diversity: 0.5, lint_pass: 1, coverage: 0.8 };

  it("weights sum to 1", () => {
    expect(Object.values(COMPOSITE_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("is the weighted average of the metrics", () => {
    const expected = 0.35 * 0.8 + 0.2 * 0.7 + 0.05 * 0.6 + 0.1 * 0.6 + 0.1 * 0.5 + 0.1 * 1 + 0.1 * 0.8;
    expect(composite(good).value).toBeCloseTo(expected, 9);
  });

  it("a failed hard gate zeroes it, whatever the other metrics say", () => {
    for (const gate of ["grounded", "injection_resisted", "language_match"]) {
      expect(composite({ ...good, [gate]: 0 })).toMatchObject({ value: 0, gated: true });
    }
  });

  it("a metric that does not apply is left out and the rest renormalised (documents stay comparable)", () => {
    const { coverage: _c, ...noCoverage } = good;
    const c = composite(noCoverage);
    expect(c.used).not.toContain("coverage");
    expect(c.value).toBeCloseTo((0.35 * 0.8 + 0.2 * 0.7 + 0.05 * 0.6 + 0.1 * 0.6 + 0.1 * 0.5 + 0.1 * 1) / 0.9, 9);
  });

  it("clamps out-of-range inputs and is monotonic in the judge score", () => {
    expect(composite({ ...good, judge_overall: 5 }).value).toBeLessThanOrEqual(1);
    expect(composite({ ...good, judge_overall: 0.9 }).value).toBeGreaterThan(composite({ ...good, judge_overall: 0.5 }).value);
  });
});

describe("semantic scores", () => {
  const doc = text("fixtures/short-doc.md");
  const refs = loadReferences("short-doc").questions;
  const others = loadReferences("portuguese-doc").questions;
  const mkq = (prompt: string, answer: string): GeneratedQuestion => ({ type: "single", prompt, options: [answer, "wrong a", "wrong b", "wrong c"], correct: [0], explanation: "x", sourceQuote: "it is a quote", difficulty: "easy" });
  const embedder = tfidfEmbedder([doc, ...refs.map((r) => `${r.prompt} ${r.answer}`), ...others.map((r) => `${r.prompt} ${r.answer}`)]);

  it("a quiz that asks what the references ask scores far higher recall than one about an unrelated topic (the metric discriminates)", async () => {
    const onTopic = refs.map((r) => mkq(r.prompt, r.answer));
    const offTopic = others.map((r) => mkq(r.prompt, r.answer));
    const a = await semanticScores({ questions: onTopic, references: refs, sourceText: doc, embedder, otherReferences: others });
    const b = await semanticScores({ questions: offTopic, references: refs, sourceText: doc, embedder, otherReferences: others });
    expect(a.ref_recall!).toBeGreaterThan(0.9);
    expect(b.ref_recall!).toBeLessThan(0.3);
    expect(a.ref_control!).toBeLessThan(a.ref_precision! - 0.5); // negative control sits well below the real similarity
  });

  it("emb_diversity falls when two questions are the same question", async () => {
    const one = mkq("How often is a snapshot written?", "every five minutes");
    const dup = mkq("How often is the snapshot written?", "every five minutes");
    const other = mkq("How many replicas can a primary stream to?", "up to three");
    const spread = await semanticScores({ questions: [one, other], references: refs, sourceText: doc, embedder });
    const dups = await semanticScores({ questions: [one, dup], references: refs, sourceText: doc, embedder });
    expect(dups.emb_diversity!).toBeLessThan(spread.emb_diversity!);
  });

  it("docChunks keeps readable passages and drops link-only noise", () => {
    const chunks = docChunks("# T\n\nA real paragraph that explains something useful about the system in plain words.\n\n[a](http://x) [b](http://y)\n");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("real paragraph");
  });
});

describe("variants", () => {
  it("3 structures x 3 prompts, unique ids, baseline prompt present, exactly one plan-first structure", () => {
    expect(STRUCTURES).toHaveLength(3);
    expect(PROMPTS).toHaveLength(3);
    expect(VARIANTS).toHaveLength(9);
    expect(new Set(VARIANTS.map((v) => v.id)).size).toBe(9);
    expect(PROMPTS.map((p) => p.id)).toContain("baseline");
    expect(STRUCTURES.filter((s) => s.input.planFirst)).toHaveLength(1);
  });
});

describe("report", () => {
  const cell = (variant: string, item: string, composite_: number, over: Record<string, unknown> = {}) => ({
    variant, structure: variant.split("/")[0]!, prompt: variant.split("/")[1]!, item, ok: true, composite: composite_, gated: false, failures: [], seconds: 10, trail: ["route:single-shot"], costUsd: 0.01, calls: 2,
    scores: { judge_overall: composite_, ref_recall: composite_, lint_pass: 1 }, questions: [{ prompt: "What <b>is</b> it?", options: ["a", "b", "c", "d"], correct: [0], difficulty: "easy" }], ...over,
  });
  const report: CompareReport = {
    generatedAt: "2026-10-08T12:00:00Z", offline: false, models: { generator: "g", judge: "j", embeddings: "e", judgeSamples: 3 }, weights: { ...COMPOSITE_WEIGHTS },
    items: ["a", "b", "c"].map((id) => ({ id, numQuestions: 5, references: 6, origin: "file" })),
    variants: [["one-shot/baseline", "One-shot"], ["plan-then-write/baseline", "Plan then write"]].map(([id, t]) => ({ id: id!, structure: id!.split("/")[0]!, structureTitle: t!, graph: "route → x", prompt: "baseline", promptTitle: "Baseline", langfuseRuns: [`${id}@t`] })),
    langfuse: { dataset: "quizforge-golden", experiment: "x", datasetId: "ds1", runs: { "one-shot/baseline@t": "run1", "plan-then-write/baseline@t": "run2" } },
    cells: ["a", "b", "c"].flatMap((i, k) => [cell("one-shot/baseline", i, 0.6 + k * 0.01), cell("plan-then-write/baseline", i, 0.8 + k * 0.01)]),
  };

  it("ranks by composite, names the winner, links Langfuse and escapes model-written text", () => {
    const html = renderReport(report);
    expect(html.indexOf("plan-then-write/baseline")).toBeLessThan(html.indexOf("one-shot/baseline")); // winner first in the ranking
    expect(html).toContain("Best average: <code>plan-then-write/baseline</code>");
    expect(html).toContain("/datasets");
    expect(html).toContain("/datasets/ds1/runs/run1"); // straight to the run, not just the dataset
    expect(html).toContain("/datasets/ds1/compare?runs=run1&amp;runs=run2");
    expect(html).not.toContain("<b>is</b>");
    expect(html).toContain("&lt;b&gt;is&lt;/b&gt;");
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });

  it("flags a lead that is within the noise as a tie and a clear lead as likely real", () => {
    expect(renderReport(report)).toContain("probably real");
    const noisy = { ...report, cells: report.cells.map((c, i) => ({ ...c, composite: c.variant.startsWith("plan") ? [0.9, 0.5, 0.7][i % 3]! : [0.5, 0.9, 0.7][i % 3]! })) };
    expect(renderReport(noisy)).toContain("within the noise");
  });

  it("a failed cell counts as 0 and is shown as a failure", () => {
    const failed = { ...report, cells: report.cells.map((c, i) => (i === 0 ? { ...c, ok: false, composite: 0, error: "QualityGateError: x", questions: [] } : c)) };
    const row = aggregate(failed).find((r) => r.v.id === "one-shot/baseline")!;
    expect(row.failed).toBe(1);
    expect(renderReport(failed)).toContain("failed");
  });

  it("measures run-to-run noise from repetitions and refuses to call a lead within that noise real", () => {
    expect(repNoise(report)).toBeNaN(); // a single repetition cannot measure noise
    const twice: CompareReport = { ...report, cells: report.cells.flatMap((c) => [{ ...c, rep: 1 }, { ...c, rep: 2, composite: c.composite + (c.variant.startsWith("plan") ? 0.15 : -0.15) * (c.item === "b" ? -1 : 1) }]) };
    expect(repNoise(twice)).toBeGreaterThan(0.05);
    expect(renderReport(twice)).toContain("Measured run-to-run noise");
    const quiet: CompareReport = { ...report, cells: report.cells.flatMap((c) => [{ ...c, rep: 1 }, { ...c, rep: 2, composite: c.composite + 0.001 }]) };
    expect(repNoise(quiet)).toBeLessThan(0.002);
    expect(renderReport(quiet)).toContain("probably real");
  });

  it("pearson handles perfect, inverse and degenerate input", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 9);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 9);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNaN();
  });
});
