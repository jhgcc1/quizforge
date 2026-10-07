/** Points awarded for a fully correct answer. */
export const MAX_QUESTION_SCORE = 4;
/** Each question weighs 10% more than the previous one (geometric sequence, first = 1.0). */
export const WEIGHT_GROWTH = 1.1;
/** Bump when the formula changes; stored on each attempt so old results stay explainable. */
export const SCORING_VERSION = 1;

/** Weights w_i = 1.1^(i-1) for i = 1..n. */
export function questionWeights(n: number): number[] {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`question count must be a positive integer, got ${n}`);
  }
  return Array.from({ length: n }, (_, i) => WEIGHT_GROWTH ** i);
}

/**
 * Score a single question, in [0, 4].
 *
 *   score = 4 * max(0, (hits - misses) / K)
 *
 * K = number of correct options, hits = selected correct options, misses = selected
 * options that are not correct. Single-answer questions (K = 1) are therefore 4 or 0,
 * and selecting every option can never beat selecting exactly the right ones.
 */
export function scoreQuestion(
  correctOptionIds: readonly string[],
  selectedOptionIds: readonly string[],
): number {
  const correct = new Set(correctOptionIds);
  if (correct.size === 0) {
    throw new RangeError("a question must have at least one correct option");
  }
  const selected = new Set(selectedOptionIds);
  let hits = 0;
  let misses = 0;
  for (const id of selected) {
    if (correct.has(id)) hits++;
    else misses++;
  }
  return MAX_QUESTION_SCORE * Math.max(0, (hits - misses) / correct.size);
}

export interface FinalScore {
  /** Weighted average in [0, 4]. */
  score: number;
  /** Same value as a percentage of the maximum, in [0, 100]. */
  percent: number;
  /** Weight applied to each question, in question order. */
  weights: number[];
}

/** Weighted average of per-question scores (ordered by question position). */
export function computeFinalScore(questionScores: readonly number[]): FinalScore {
  if (questionScores.length === 0) {
    throw new RangeError("at least one question score is required");
  }
  for (const s of questionScores) {
    if (!Number.isFinite(s) || s < 0 || s > MAX_QUESTION_SCORE) {
      throw new RangeError(`question score out of range [0, ${MAX_QUESTION_SCORE}]: ${s}`);
    }
  }
  const weights = questionWeights(questionScores.length);
  let weighted = 0;
  let total = 0;
  questionScores.forEach((s, i) => {
    weighted += s * weights[i]!;
    total += weights[i]!;
  });
  const score = weighted / total;
  return { score, percent: (score / MAX_QUESTION_SCORE) * 100, weights };
}
