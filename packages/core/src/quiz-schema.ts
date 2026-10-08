import { z } from "zod";

export const MIN_QUESTIONS = 5;
export const MAX_QUESTIONS = 8;
export const OPTIONS_PER_QUESTION = 4;

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Contract for what the LLM must produce. Everything the model returns is validated against
 * this before it can reach the database. `type` is derived (never trusted from the model).
 */
export const GeneratedQuestionSchema = z
  .object({
    prompt: z.string().trim().min(10).max(400),
    options: z.array(z.string().trim().min(1).max(300)).length(OPTIONS_PER_QUESTION),
    /** Zero-based indexes into `options`. */
    correct: z.array(z.number().int().min(0).max(OPTIONS_PER_QUESTION - 1)).min(1).max(3),
    explanation: z.string().trim().min(5).max(600),
    /** Verbatim excerpt of the source document that supports the answer. */
    sourceQuote: z.string().trim().min(5).max(500),
    difficulty: z.enum(["easy", "medium", "hard"]).default("medium"),
  })
  .superRefine((q, ctx) => {
    if (new Set(q.options.map(norm)).size !== q.options.length) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "options must be distinct" });
    }
    if (new Set(q.correct).size !== q.correct.length) {
      ctx.addIssue({ code: "custom", path: ["correct"], message: "correct indexes must be unique" });
    }
  })
  .transform((q) => ({ ...q, type: q.correct.length > 1 ? ("multiple" as const) : ("single" as const) }));

export const GeneratedQuizSchema = z
  .object({
    questions: z.array(GeneratedQuestionSchema).min(MIN_QUESTIONS).max(MAX_QUESTIONS),
  })
  .superRefine((quiz, ctx) => {
    const seen = new Set<string>();
    quiz.questions.forEach((q, i) => {
      const key = norm(q.prompt);
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path: ["questions", i, "prompt"], message: "duplicate question" });
      }
      seen.add(key);
    });
  });

export type GeneratedQuestion = z.output<typeof GeneratedQuestionSchema>;
export type GeneratedQuiz = z.output<typeof GeneratedQuizSchema>;

/**
 * Visible text of a markdown document: link/image syntax collapses to its label, URLs and HTML tags
 * disappear, and only letters/digits survive (lowercased, single-spaced). Models quote what a reader
 * sees ("Agents: Build autonomous agents"), not raw markdown ("[**Agents**](https://...): Build ..."),
 * so grounding is compared on this form while still requiring the same words in the same order.
 */
export function visibleText(markdown: string): string {
  return markdown
    .normalize("NFKC")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

const MIN_QUOTE_WORDS = 3;

/**
 * Deterministic groundedness check: each question's `sourceQuote` must appear in the document's
 * visible text (>= 3 words, same order). Positions in `ungrounded` are 1-based.
 */
export function checkGrounding(
  quiz: { questions: readonly { sourceQuote: string }[] },
  sourceText: string,
): { ok: boolean; ungrounded: number[] } {
  const haystack = ` ${visibleText(sourceText)} `;
  const ungrounded: number[] = [];
  quiz.questions.forEach((q, i) => {
    const quote = visibleText(q.sourceQuote);
    const words = quote ? quote.split(" ").length : 0;
    if (words < MIN_QUOTE_WORDS || !haystack.includes(` ${quote} `)) ungrounded.push(i + 1);
  });
  return { ok: ungrounded.length === 0, ungrounded };
}
