import type { GeneratedQuestion } from "@quizforge/core";

const SELECT_ALL = /select all|choose all|all that apply|which of the following (?:are|statements are)|mark all|pick all/i;
const ALL_NONE = /\b(all|none) of the above\b/i;
const LETTER_PREFIX = /^\s*(?:[A-Da-d]|[1-4])[).:]\s+/;

/** Question-level defects that are cheap to detect deterministically. Messages are fed to the reviser. */
export function lintQuestion(q: GeneratedQuestion): string[] {
  const issues: string[] = [];
  if (SELECT_ALL.test(q.prompt) && q.correct.length < 2) {
    issues.push('the prompt asks to select several answers ("select all that apply") but only one option is marked correct; mark every correct option or rephrase as a single-answer question');
  }
  if (q.correct.length > 1 && !SELECT_ALL.test(q.prompt) && !/more than one|multiple|several/i.test(q.prompt)) {
    issues.push('several options are correct, so the prompt must say so (e.g. "Select all that apply")');
  }
  if (q.options.some((o) => ALL_NONE.test(o))) issues.push('options must not use "all/none of the above"');
  if (q.options.some((o) => LETTER_PREFIX.test(o))) issues.push('options must not start with letters or numbers like "A)" or "1."');
  if (q.correct.length === 1) {
    const lens = q.options.map((o) => o.length);
    const correctLen = lens[q.correct[0]!]!;
    const others = lens.filter((_, i) => i !== q.correct[0]);
    if (correctLen > 2 * Math.max(...others) && correctLen > 60) issues.push("the correct option is far longer than the others, which gives it away; balance the option lengths");
  }
  return issues;
}

export interface QuizMetrics {
  /** 0..1: share of questions with no lint issues. */
  lintPass: number;
  /** 0..1: how varied difficulty is (1 = all three levels used). */
  difficultySpread: number;
  /** 0..1: correct answers are not stuck in one position. */
  positionSpread: number;
  singleShare: number;
}

export function quizMetrics(questions: GeneratedQuestion[]): QuizMetrics {
  const n = questions.length || 1;
  const lintPass = questions.filter((q) => lintQuestion(q).length === 0).length / n;
  const levels = new Set(questions.map((q) => q.difficulty)).size;
  const positions = new Set(questions.flatMap((q) => q.correct)).size;
  return {
    lintPass,
    difficultySpread: Math.min(1, (levels - 1) / 2),
    positionSpread: Math.min(1, (positions - 1) / 3),
    singleShare: questions.filter((q) => q.type === "single").length / n,
  };
}
