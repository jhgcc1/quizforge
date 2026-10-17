import type { GeneratedQuestion } from "@quizforge/core";

// The quiz is written in the language of the document (en, pt or es), so every rule that reads the prompt has to be
// written in all three. An English-only pattern does not merely miss a defect: it REPORTS one, because a Spanish
// "Seleccione todas las que correspondan" looks to it like a multi-answer question that forgot to say so. The reviser
// is then told to fix a question that was already correct.
const SELECT_ALL =
  /select all|choose all|all that apply|which of the following (?:are|statements are)|mark all|pick all|seleccione? todas|selecciona todas|marque todas|marca todas|elija todas|elige todas|todas las que correspondan|todas las correctas|cu[áa]les de (?:los|las) siguientes|assinale todas|marque todas as|selecione todas|quais (?:dos|das) seguintes|todas as corretas|todas as que se aplicam/i;
/** "more than one answer" said in any of the three languages, as a looser fallback to SELECT_ALL. */
const SAYS_SEVERAL = /more than one|multiple|several|m[áa]s de una|varias opciones|varias respuestas|m[úu]ltiples|mais de uma|v[áa]rias op[çc][õo]es|v[áa]rias respostas|m[úu]ltiplas/i;
const ALL_NONE =
  /\b(?:all|none) of the above\b|\b(?:todas|ninguna)\s+(?:de\s+)?las\s+(?:opciones\s+|respuestas\s+)?anteriores\b|\b(?:todas|nenhuma)\s+(?:d?[ae]s\s+)?(?:alternativas\s+|op[çc][õo]es\s+)?(?:anteriores|acima)\b/i;
const LETTER_PREFIX = /^\s*(?:[A-Da-d]|[1-4])[).:]\s+/;

/** Question-level defects that are cheap to detect deterministically. Messages are fed to the reviser. */
export function lintQuestion(q: GeneratedQuestion): string[] {
  const issues: string[] = [];
  if (SELECT_ALL.test(q.prompt) && q.correct.length < 2) {
    issues.push('the prompt asks to select several answers ("select all that apply") but only one option is marked correct; mark every correct option or rephrase as a single-answer question');
  }
  if (q.correct.length > 1 && !SELECT_ALL.test(q.prompt) && !SAYS_SEVERAL.test(q.prompt)) {
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
