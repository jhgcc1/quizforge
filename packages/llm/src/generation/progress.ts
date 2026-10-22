/**
 * Generation progress: which phase of the graph a job is in, as DISCRETE steps (never a fake percentage).
 *
 * The phases come from the real graph (quiz-graph.ts), in order:
 *   reading_document   fetch and sanitize the document (done by the worker, before the graph)
 *   planning           only when the plan-then-write structure is used (an LLM call that picks the facts to test)
 *   writing_questions  the generator (single-shot, or one call per section in map-reduce: detail "section i of n")
 *   checking           the deterministic gate (schema, duplicates, quote found verbatim in the document)
 *   reviewing          the critique and revise loop (detail "round k of N"); present when critique is on, or when the
 *                      deterministic gate found something to revise
 *   saving             the quiz is written to the database (done by the worker, after the graph)
 *
 * `totalSteps` is what is known NOW and can change while the job runs: it grows by one when a `reviewing` step turns out to
 * be needed although critique was off. A client must therefore draw step/totalSteps from the latest response and may see the
 * bar re-scale; `step` itself never goes down within one run.
 */
export const GENERATION_PHASES = ["reading_document", "planning", "writing_questions", "checking", "reviewing", "saving"] as const;
export type GenerationPhase = (typeof GENERATION_PHASES)[number];

export interface GenerationProgress {
  phase: GenerationPhase;
  /** 1-based position of the current phase in the plan below. */
  step: number;
  /** Number of steps in the plan as known now (see the note about re-scaling above). */
  totalSteps: number;
  /** Sub-progress inside a step, in plain English ("section 2 of 5", "round 1 of 2"). */
  detail?: string;
}

export interface ProgressPlan {
  /** Critique stage requested. */
  critique: boolean;
  /** plan-then-write structure (an extra `planning` step). */
  planFirst: boolean;
  /** A revise round has happened or is about to: the `reviewing` step exists even if critique was off. */
  revised: boolean;
}

/** The ordered steps of a run, for what is known now. */
export function planPhases(plan: ProgressPlan): GenerationPhase[] {
  return GENERATION_PHASES.filter((p) => (p === "planning" ? plan.planFirst : p === "reviewing" ? plan.critique || plan.revised : true));
}

export function progressFor(phase: GenerationPhase, plan: ProgressPlan, detail?: string): GenerationProgress {
  const steps = planPhases(plan);
  return { phase, step: steps.indexOf(phase) + 1, totalSteps: steps.length, ...(detail ? { detail } : {}) };
}

export type ProgressListener = (p: GenerationProgress) => void;
