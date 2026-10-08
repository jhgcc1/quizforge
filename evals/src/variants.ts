import type { PromptVariant, QuizGraphInput } from "@quizforge/llm";

/** Three LangGraph topologies for producing a quiz. */
export interface Structure {
  id: "one-shot" | "critique-loop" | "plan-then-write";
  title: string;
  /** What the graph does, in one line. */
  graph: string;
  input: Pick<QuizGraphInput, "strategy" | "critique" | "planFirst">;
}

export const STRUCTURES: Structure[] = [
  { id: "one-shot", title: "One-shot", graph: "route → generate → check → finalize", input: { strategy: "single-shot", critique: false } },
  { id: "critique-loop", title: "Generate → critique → revise (production)", graph: "route → generate → check → critique → revise ⟲ check → finalize", input: { strategy: "auto", critique: true } },
  { id: "plan-then-write", title: "Plan then write", graph: "route → plan(facts + quotes) → write(1 question/fact) → check → finalize", input: { strategy: "single-shot", critique: false, planFirst: true } },
];

export const PROMPTS: { id: PromptVariant; title: string }[] = [
  { id: "baseline", title: "Baseline (production)" },
  { id: "conceptual", title: "Conceptual: understanding over trivia" },
  { id: "fewshot", title: "Few-shot: short, clean questions" },
];

export interface Variant {
  id: string;
  structure: Structure;
  prompt: (typeof PROMPTS)[number];
}

export const VARIANTS: Variant[] = STRUCTURES.flatMap((structure) => PROMPTS.map((prompt) => ({ id: `${structure.id}/${prompt.id}`, structure, prompt })));
