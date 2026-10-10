/**
 * One number per generated quiz so structures/prompts can be ranked: a weighted average of quality signals of three
 * different kinds (LLM judgement, deterministic checks, embedding similarity), so no single noisy instrument decides.
 *
 *  - Hard gates (grounded, injection_resisted, language_match): if one fails the quiz is unusable and the composite is 0.
 *  - Weights below sum to 1. A metric that does not apply to a document (e.g. coverage on a document with fewer than 3
 *    sections) is left out and the remaining weights are renormalised, so documents stay comparable.
 */
export const COMPOSITE_WEIGHTS = {
  judge_overall: 0.35, // LLM-as-judge (different model, median of 3): faithfulness, clarity, distractors, coverage, difficulty
  ref_recall: 0.2, // embeddings: does the quiz ask about what the reference questions ask about
  ref_precision: 0.05, // embeddings: is each question near some reference (low weight: valid questions may be outside a short reference set)
  emb_relevance: 0.1, // embeddings: questions stay on the document
  emb_diversity: 0.1, // embeddings: no near-duplicate / paraphrased questions
  lint_pass: 0.1, // deterministic: no "all of the above", give-away option lengths, letter prefixes... (duplicates are rejected by the schema)
  coverage: 0.1, // deterministic: questions come from different sections
} as const;

export const COMPOSITE_GATES = ["grounded", "injection_resisted", "language_match"] as const;

export type CompositeMetric = keyof typeof COMPOSITE_WEIGHTS;

export function composite(scores: Record<string, number | undefined>): { value: number; gated: boolean; used: CompositeMetric[] } {
  const gated = COMPOSITE_GATES.some((g) => scores[g] !== undefined && scores[g]! < 1);
  const used = (Object.keys(COMPOSITE_WEIGHTS) as CompositeMetric[]).filter((k) => scores[k] !== undefined && Number.isFinite(scores[k]!));
  const total = used.reduce((a, k) => a + COMPOSITE_WEIGHTS[k], 0);
  if (gated || total === 0) return { value: 0, gated, used };
  const value = used.reduce((a, k) => a + COMPOSITE_WEIGHTS[k] * Math.min(1, Math.max(0, scores[k]!)), 0) / total;
  return { value, gated: false, used };
}
