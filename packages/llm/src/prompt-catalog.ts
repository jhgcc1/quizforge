import { createHash } from "node:crypto";
import { CRITIQUE_SYSTEM, JUDGE_SYSTEM, PLAN_SYSTEM, PROMPT_VERSION, REVISE_SYSTEM, generationSystem } from "./prompts.js";

/**
 * The system prompts of the agent, by name: the unit that is versioned, locked in Git (prompts/prompts.lock.json) and published to
 * Langfuse Prompt Management by the pipeline. Git is the source of truth; Langfuse only receives what the pipeline has approved.
 */
export interface CatalogPrompt {
  /** Name in Langfuse. */
  name: string;
  text: string;
}

export const PROMPT_CATALOG: readonly CatalogPrompt[] = [
  { name: "quizforge/generation", text: generationSystem("baseline") },
  { name: "quizforge/generation-conceptual", text: generationSystem("conceptual") },
  { name: "quizforge/generation-fewshot", text: generationSystem("fewshot") },
  { name: "quizforge/critique", text: CRITIQUE_SYSTEM },
  { name: "quizforge/revise", text: REVISE_SYSTEM },
  { name: "quizforge/plan", text: PLAN_SYSTEM },
  { name: "quizforge/judge", text: JUDGE_SYSTEM },
];

export const hashPrompt = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface PromptLock {
  promptVersion: string;
  prompts: Record<string, string>;
}

/** What prompts/prompts.lock.json must contain for the current code. */
export const currentLock = (): PromptLock => ({
  promptVersion: PROMPT_VERSION,
  prompts: Object.fromEntries(PROMPT_CATALOG.map((p) => [p.name, hashPrompt(p.text)])),
});
