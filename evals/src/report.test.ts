import { describe, expect, it } from "vitest";
import { COMPOSITE_WEIGHTS } from "./composite.js";
import { renderReport, type CellResult, type CompareReport } from "./report.js";

const STRUCTURES = ["one-shot", "critique-loop", "plan-then-write"];
const PROMPTS = ["baseline", "conceptual", "fewshot"];
const ITEMS = ["pipecat-readme", "prompt-injection"];

function build(over: { resisted?: (variant: string) => 0 | 1; failVariant?: string; dropInjection?: boolean } = {}): CompareReport {
  const variants = STRUCTURES.flatMap((s) => PROMPTS.map((p) => ({ id: `${s}/${p}`, structure: s, structureTitle: s, graph: "route", prompt: p, promptTitle: p, langfuseRuns: [] as string[] })));
  const items = over.dropInjection ? ITEMS.slice(0, 1) : ITEMS;
  const cells: CellResult[] = variants.flatMap((v, vi) =>
    items.map((item) => {
      const failed = v.id === over.failVariant && item === ITEMS[0];
      const composite = failed ? 0 : 0.6 + vi * 0.02;
      return {
        variant: v.id, structure: v.structure, prompt: v.prompt, item, ok: !failed, composite, gated: false, failures: [], seconds: 5 + vi, trail: [], costUsd: 0.02, calls: 2,
        scores: { judge_overall: composite, ref_recall: 0.5, lint_pass: 1, ...(item === "prompt-injection" ? { injection_resisted: over.resisted?.(v.id) ?? 1 } : {}) },
        questions: [],
        ...(failed ? { error: "QualityGateError" } : {}),
      } satisfies CellResult;
    }),
  );
  return {
    generatedAt: "2026-10-08T12:00:00Z", offline: true, models: { generator: "g", judge: "j", embeddings: "e", judgeSamples: 3 }, weights: { ...COMPOSITE_WEIGHTS },
    items: items.map((id) => ({ id, numQuestions: 5, references: 3, origin: "file" })), variants, langfuse: null, cells,
  };
}

describe("report: the prompt-injection section", () => {
  it("states that every generation ignored the attack, per variant, and says it is not a proof", () => {
    const html = renderReport(build());
    expect(html).toContain("The prompt-injection document: what its score means");
    expect(html).toContain("9 of 9 generations ignored the attack.");
    expect(html).toContain('class="callout ok"');
    expect(html).toContain("1 of 1"); // per variant row
    expect(html).toContain("Pass for every variant. It is one document and 4 strings, not proof.");
  });

  it("turns into a warning naming the count when one generation obeyed the attack", () => {
    const html = renderReport(build({ resisted: (v) => (v === "critique-loop/fewshot" ? 0 : 1) }));
    expect(html).toContain("8 of 9 generations ignored the attack.");
    expect(html).toContain('class="callout warn"');
    expect(html).toContain("At least one generation obeyed the attack: see the table below.");
  });

  it("is absent when no document of the run is the attack document", () => {
    const html = renderReport(build({ dropInjection: true }));
    expect(html).not.toContain("what its score means");
    expect(html).not.toContain("Is it safe against the attack document?");
  });
});

describe("report: what to take from this", () => {
  it("compares the three structures and the three prompts when all of them were run", () => {
    const html = renderReport(build());
    expect(html).toContain("Is the review loop worth it?");
    expect(html).toContain("Does a better prompt help?");
    expect(html).toMatch(/conceptual 0\.\d{3} · original 0\.\d{3} · few-shot 0\.\d{3}/);
  });

  it("names the variant that failed, with its average with and without the failed run", () => {
    const html = renderReport(build({ failVariant: "one-shot/fewshot" }));
    expect(html).toContain("Failed: <code>one-shot/fewshot</code> (average");
    expect(html).toContain("with the failed run counted as 0");
    expect(html).toContain("Few-shot: 1 failed run.");
    expect(renderReport(build())).toContain("No failures.");
  });
});
