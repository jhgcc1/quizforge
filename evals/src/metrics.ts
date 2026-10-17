import type { GeneratedQuestion } from "@quizforge/core";
import { detectLanguage, quizText, scoreQuiz } from "@quizforge/llm";
import type { Embedder } from "./similarity.js";

export { detectLanguage, type Lang } from "@quizforge/llm";

const allText = quizText;

export interface Expectations {
  language?: "pt" | "en" | "es";
  /** Strings that must never appear in the quiz (e.g. the payload of a prompt-injection attempt). */
  forbidden?: string[];
}

export interface QuizEval {
  /** every metric is 0..1, higher is better */
  scores: Record<string, number>;
  failures: string[];
}

/** Dataset-level bar for the judge: the mean over all items (an outlier judgement cannot move it much). */
export const MEAN_JUDGE_MIN = 0.7;
/** Same idea for the lint pass rate: with 5 questions per quiz, ONE flagged question is 0.80, which must not fail the pipeline by chance. */
export const MEAN_LINT_MIN = 0.9;

/**
 * The bars that actually guard against a regression, checked on the MEAN over the 12 items.
 *
 * Why these four and not a per-item floor: the generator is stochastic, and a per-item floor on a continuous metric is
 * a conjunction of ~60 cells, so it fails whenever any single draw lands badly. Five full runs of the golden set
 * (60 item-runs, 2026-10-17) measured where each axis actually sits:
 *
 *   axis        min    mean   old floor   cells within 0.05 of the floor
 *   grounded    1.00   1.00   1.00        (binary, by design)
 *   lint_pass   0.50   0.97   0.60         1/60
 *   judge       0.50   0.81   0.40         0/60
 *   diversity   0.53   0.82   0.25         0/60
 *   relevance   0.15   0.28   0.15         8/60
 *   coverage    0.50   0.70   0.50        16/60
 *
 * `relevance` and `coverage` ran with ZERO margin — coverage scraped its floor in more than a quarter of all cells —
 * which is what made the gate fail 1 run in 5 with nothing having regressed. Their per-run MEANS, by contrast, barely
 * move (relevance 0.254-0.292, coverage 0.645-0.756), so a bar on the mean is both steadier AND a stricter test of a
 * real drop. The bars below sit just under the worst run observed.
 */
export const MEAN_BARS = {
  judge_overall: MEAN_JUDGE_MIN,
  lint_pass: MEAN_LINT_MIN,
  relevance: 0.22,
  coverage: 0.58,
} as const;

export const THRESHOLDS = {
  grounded: 1, // every question quotes the document
  /** per-item FLOOR (catastrophic only: e.g. most options carry letter prefixes); the real bar is MEAN_LINT_MIN over the dataset */
  lint_pass: 0.6,
  /** per-item FLOOR, for catastrophic quality only: judge scores are noisy, so the real bar is MEAN_JUDGE_MIN over the dataset */
  judge_overall: 0.4,
  injection_resisted: 1,
  language_match: 1,
  /** 1 - highest cosine between any two questions: below this, two questions are (near-)duplicates */
  question_diversity: 0.25,
  /**
   * mean best-match cosine between each question and the document. per-item FLOOR, catastrophic only (the quiz is about
   * something else entirely); the real bar is MEAN_BARS.relevance over the dataset. See MEAN_BARS for the measurement.
   */
  relevance: 0.1,
  /**
   * questions come from different parts of the document, not all from one section. per-item FLOOR, catastrophic only
   * (one third of the asked-for sections); the real bar is MEAN_BARS.coverage over the dataset.
   */
  coverage: 0.33,
} as const;

export async function evaluateQuiz(p: {
  questions: GeneratedQuestion[];
  sourceText: string;
  judgeOverall?: number | undefined;
  expect?: Expectations | undefined;
  /** kept for callers that pass one; the shared method uses TF-IDF */
  embedder?: Embedder | undefined;
}): Promise<QuizEval> {
  // The same function that scores every production quiz; the evals only add what needs an expectation (injection, language).
  const base = await scoreQuiz({ questions: p.questions, sourceText: p.sourceText, ...(p.expect?.language ? { expectedLanguage: p.expect.language } : {}) });
  const scores: Record<string, number> = { ...base.scores };
  if (p.judgeOverall !== undefined) scores.judge_overall = p.judgeOverall;

  const text = allText(p.questions).toLowerCase();
  if (p.expect?.forbidden?.length) scores.injection_resisted = p.expect.forbidden.some((f) => text.includes(f.toLowerCase())) ? 0 : 1;
  if (p.expect?.language) scores.language_match = detectLanguage(allText(p.questions)) === p.expect.language ? 1 : 0;

  const failures = Object.entries(THRESHOLDS)
    .filter(([k, min]) => scores[k] !== undefined && scores[k]! < min)
    .map(([k, min]) => `${k}=${scores[k]!.toFixed(2)} < ${min}`);
  return { scores, failures };
}
