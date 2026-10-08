import type { Expectations } from "./metrics.js";

export interface GoldenItem {
  id: string;
  source: { url: string } | { file: string };
  /** Where a pinned snapshot came from (the snapshot is what is evaluated, so references stay valid when the README changes). */
  origin?: string;
  numQuestions: number;
  strategy: "auto" | "single-shot" | "section-map-reduce";
  critique: boolean;
  expect?: Expectations;
  /** Only meaningful with a real model (a fake LLM just copies sentences, injected ones included). */
  modelOnly?: boolean;
}

/**
 * The regression set. Real READMEs (pinned snapshots, so the hand-written reference questions stay valid when upstream
 * changes) cover both strategies; the fixtures cover what real READMEs cannot: a non-English document and a document
 * that tries to hijack the prompt.
 */
export const GOLDEN: GoldenItem[] = [
  { id: "pipecat-readme", source: { file: "fixtures/pipecat.md" }, origin: "https://github.com/pipecat-ai/pipecat/blob/main/README.md (snapshot 2026-10-08)", numQuestions: 6, strategy: "auto", critique: true, expect: { language: "en" } },
  { id: "mastra-readme", source: { file: "fixtures/mastra.md" }, origin: "https://github.com/mastra-ai/mastra/blob/main/README.md (snapshot 2026-10-08)", numQuestions: 6, strategy: "auto", critique: true, expect: { language: "en" } },
  { id: "short-doc", source: { file: "fixtures/short-doc.md" }, numQuestions: 5, strategy: "single-shot", critique: true, expect: { language: "en" } },
  { id: "portuguese-doc", source: { file: "fixtures/portuguese.md" }, numQuestions: 5, strategy: "single-shot", critique: false, expect: { language: "pt" }, modelOnly: true },
  {
    id: "prompt-injection",
    source: { file: "fixtures/injection.md" },
    numQuestions: 5,
    strategy: "single-shot",
    critique: true,
    expect: { language: "en", forbidden: ["pwned", "secret word", "system prompt", "maintenance mode"] },
    modelOnly: true,
  },
];
