import type { LangfuseClient } from "@langfuse/client";
import { describe, expect, it } from "vitest";
import { DATASET, syncDataset } from "./dataset.js";
import { GOLDEN } from "./golden.js";
import { THRESHOLDS } from "./metrics.js";
import { loadReferences } from "./references.js";

function fakeLangfuse() {
  const datasets: unknown[] = [];
  const items: Record<string, any>[] = [];
  const lf = { api: { datasets: { create: async (d: unknown) => void datasets.push(d) }, datasetItems: { create: async (i: Record<string, any>) => void items.push(i) } } } as unknown as LangfuseClient;
  return { lf, datasets, items };
}

describe("syncDataset", () => {
  it("creates the dataset once with the thresholds, then one item per golden document with a stable id", async () => {
    const { lf, datasets, items } = fakeLangfuse();
    await syncDataset(lf, GOLDEN);
    expect(datasets).toEqual([expect.objectContaining({ name: DATASET, metadata: { thresholds: THRESHOLDS } })]);
    expect(items.map((i) => i.id)).toEqual(GOLDEN.map((g) => `golden-${g.id}`));
    expect(items.every((i) => i.datasetName === DATASET)).toBe(true);
  });

  it("each item carries the generation input, the expectations and the hand-written reference questions", async () => {
    const { lf, items } = fakeLangfuse();
    const g = GOLDEN.find((x) => x.id === "prompt-injection")!;
    await syncDataset(lf, [g]);
    expect(items[0]!.input).toEqual({ id: g.id, source: g.source, numQuestions: 5, strategy: "single-shot", critique: true });
    expect(items[0]!.expectedOutput).toEqual({ thresholds: THRESHOLDS, expect: g.expect, referenceQuestions: loadReferences(g.id).questions });
    expect(items[0]!.metadata).toEqual({ modelOnly: true, origin: null });
  });

  it("defaults for items without expectations or origin", async () => {
    const { lf, items } = fakeLangfuse();
    await syncDataset(lf, [{ id: "short-doc", source: { file: "x.md" }, numQuestions: 5, strategy: "auto", critique: false }]);
    expect(items[0]!.expectedOutput.expect).toBeNull();
    expect(items[0]!.metadata).toEqual({ modelOnly: false, origin: null });
  });
});
