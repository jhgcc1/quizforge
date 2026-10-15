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
 * disappear, task-list markers ("[x]", "[ ]") are dropped, and only letters/digits survive (lowercased,
 * single-spaced; so list bullets, emphasis, headings, table pipes, quote styles, dashes and line breaks never
 * matter). Models quote what a reader sees ("Agents: Build autonomous agents"), not raw markdown
 * ("[**Agents**](https://...): Build ..."), so grounding is compared on this form while still requiring the same
 * words in the same order.
 */
export function visibleText(markdown: string): string {
  return markdown
    .normalize("NFKC")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[[ xX]\](?=\s)/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

/** Same as {@link visibleText} but link labels are dropped too (a quote that skips "[Docs](...)" still reads as one passage). */
function visibleTextWithoutLinks(markdown: string): string {
  return visibleText(markdown.replace(/(?<!!)\[[^\]]*\]\([^)]*\)/g, " "));
}

const MIN_QUOTE_WORDS = 3;
/** A quote the model cut short (ends with "..." or "…") is accepted on its leading words only if they are at least this many... */
export const MIN_TRUNCATED_PREFIX_WORDS = 6;
/** ...and the cut-off tail (the words after the last contiguous one, including a half-written word) is at most this long. */
export const MAX_TRUNCATED_TAIL_WORDS = 4;

const TRUNCATED = /(\.\.\.|\u2026)\s*$/;

/** True when `words` appear in `haystack` (normalised and padded with spaces) as one contiguous run. */
const contiguous = (haystack: string, words: readonly string[]): boolean => haystack.includes(` ${words.join(" ")} `);

/**
 * Grounding rule for ONE quote against the normalised variants of the document (see checkGrounding):
 *  1. the whole quote is a contiguous run of words of the document (two adjacent sentences or a line break inside
 *     the quote are fine, because punctuation and whitespace are not compared), or
 *  2. the quote is explicitly truncated (ends with an ellipsis) and its leading words are a contiguous run of at
 *     least MIN_TRUNCATED_PREFIX_WORDS words, with at most MAX_TRUNCATED_TAIL_WORDS words left unverified.
 * Words that are not in the document, in another order, or spliced from places that are not adjacent are NOT
 * grounded (a splice only gets through rule 2, and then the verified prefix alone must carry the quote).
 */
function quoteGrounded(rawQuote: string, haystacks: readonly string[]): boolean {
  const words = visibleText(rawQuote).split(" ").filter(Boolean);
  if (words.length < MIN_QUOTE_WORDS) return false;
  if (haystacks.some((h) => contiguous(h, words))) return true;
  if (!TRUNCATED.test(rawQuote.trim())) return false;
  for (let k = words.length - 1; k >= MIN_TRUNCATED_PREFIX_WORDS; k--) {
    if (words.length - k > MAX_TRUNCATED_TAIL_WORDS) break;
    if (haystacks.some((h) => contiguous(h, words.slice(0, k)))) return true;
  }
  return false;
}

/**
 * Deterministic groundedness check: each question's `sourceQuote` must appear in the document's
 * visible text (>= 3 words, same order; see quoteGrounded for the truncation rule). Positions in `ungrounded` are 1-based.
 */
export function checkGrounding(
  quiz: { questions: readonly { sourceQuote: string }[] },
  sourceText: string,
): { ok: boolean; ungrounded: number[] } {
  const haystacks = [` ${visibleText(sourceText)} `, ` ${visibleTextWithoutLinks(sourceText)} `];
  const ungrounded: number[] = [];
  quiz.questions.forEach((q, i) => {
    if (!quoteGrounded(q.sourceQuote, haystacks)) ungrounded.push(i + 1);
  });
  return { ok: ungrounded.length === 0, ungrounded };
}
