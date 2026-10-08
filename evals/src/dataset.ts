import type { LangfuseClient } from "@langfuse/client";
import type { GoldenItem } from "./golden.js";
import { THRESHOLDS } from "./metrics.js";
import { loadReferences } from "./references.js";

export const DATASET = "quizforge-golden";

/** Mirror the golden set into the Langfuse Dataset (idempotent: items are upserted by id), reference questions included. */
export async function syncDataset(lf: LangfuseClient, items: GoldenItem[]): Promise<void> {
  await lf.api.datasets.create({ name: DATASET, description: "QuizForge golden set: documents the quiz generator must handle well, with reference questions", metadata: { thresholds: THRESHOLDS } });
  for (const g of items) {
    await lf.api.datasetItems.create({
      datasetName: DATASET,
      id: `golden-${g.id}`,
      input: { id: g.id, source: g.source, numQuestions: g.numQuestions, strategy: g.strategy, critique: g.critique },
      expectedOutput: { thresholds: THRESHOLDS, expect: g.expect ?? null, referenceQuestions: loadReferences(g.id).questions },
      metadata: { modelOnly: g.modelOnly ?? false, origin: g.origin ?? null },
    });
  }
}
