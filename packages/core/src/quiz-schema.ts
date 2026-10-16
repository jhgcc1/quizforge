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

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", copy: "\u00a9", reg: "\u00ae", hellip: "\u2026",
  mdash: "\u2014", ndash: "\u2013", laquo: "\u00ab", raquo: "\u00bb", ntilde: "\u00f1", Ntilde: "\u00d1",
  szlig: "\u00df", ccedil: "\u00e7", Ccedil: "\u00c7", aelig: "\u00e6", oslash: "\u00f8", iexcl: "\u00a1", iquest: "\u00bf",
};
const ACCENTS: Record<string, string> = { acute: "\u0301", grave: "\u0300", circ: "\u0302", tilde: "\u0303", uml: "\u0308", cedil: "\u0327", ring: "\u030a" };

/** Decodes the HTML entities a reader would see rendered (&amp;, &nbsp;, &eacute;, &#233;, &#xE9;); unknown ones are left alone. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d{1,7});/g, (m, d: string) => (Number(d) <= 0x10ffff ? String.fromCodePoint(Number(d)) : m))
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h: string) => (parseInt(h, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(h, 16)) : m))
    .replace(/&([a-zA-Z])(acute|grave|circ|tilde|uml|cedil|ring);/g, (_m, l: string, a: string) => l + ACCENTS[a]!)
    .replace(/&([a-zA-Z]+);/g, (m, n: string) => NAMED_ENTITIES[n] ?? m)
    .normalize("NFKC");
}

/** Inline tags glue their text to the neighbours ("<b>Super</b>base" reads "Superbase"); every other tag (td, tr, p, li, br, div...) separates. */
const INLINE_TAG = /<\/?(?:a|b|i|u|s|em|strong|code|kbd|span|small|big|mark|sub|sup|abbr|cite|q|font|tt|ins|del)(?:\s[^<>]*)?\/?>/gi;
/** A real tag starts with a letter right after "<" or "</": "a <3 b > c", "x < y" and "<user@host.com>" are text, not tags. */
const ANY_TAG = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g;

/**
 * Visible text of a markdown/HTML document, as a reader sees it rendered: link/image syntax collapses to its label,
 * URLs, HTML comments, code-fence info strings ("```bash") and HTML tags disappear (inline tags glue, block tags,
 * table cells and rows separate), entities are decoded, task-list markers ("[x]", "[ ]") are dropped, and only
 * letters/digits survive (lowercased, single-spaced; so list bullets, emphasis, heading markers, table pipes, quote
 * styles, dashes and line breaks never matter). Models quote what a reader sees ("Agents: Build autonomous agents"),
 * not raw markdown ("[**Agents**](https://...): Build ..."), so grounding is compared on this form while still
 * requiring the same words in the same order.
 */
export function visibleText(markdown: string): string {
  return decodeEntities(
    markdown
      .normalize("NFKC")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/^[ \t]*(?:`{3,}|~{3,})[^\n]*$/gm, " ")
      .replace(/^ {0,3}\[[^\]]+\]:[ \t]+\S.*$/gm, " ")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/!?\[([^\]]+)\]\[[^\]]*\]/g, "$1")
      .replace(/\[[ xX]\](?=\s)/g, " ")
      .replace(INLINE_TAG, "")
      .replace(ANY_TAG, " "),
  )
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

/** Image alt text is not visible in a rendered page, so a quote that skips "![badge](...)" still reads as one passage. */
const withoutImages = (md: string): string => md.replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/g, " ");
/** Same for link labels ("Docs" in "[Docs](...)"): a quote may skip them. */
const withoutLinks = (md: string): string => md.replace(/(?<!!)\[[^\]]*\]\([^)]*\)/g, " ");
/** Same for inline code spans ("Node.js `^20.19.0`, Bun" read as "Node.js, Bun"). */
const withoutInlineCode = (md: string): string => md.replace(/`[^`\n]*`/g, " ");
/** Same for ordered-list numerals ("3. ", "4) "): a quote that joins two list items does not carry their numbers. */
const withoutListNumbers = (md: string): string => md.replace(/^([ \t]*)\d{1,3}[.)][ \t]+/gm, "$1");

interface Variant {
  readonly haystack: string;
  /** The quote is normalised the same way as the document (only matters for list numerals, which a quote may start with). */
  readonly listNumbers: boolean;
}
let lastVariants: { source: string; variants: Variant[] } | undefined;
/**
 * Normalised variants of the document: every combination of "skip images / link labels / inline code / list numerals".
 * Each variant only removes things a reader may skip while reading a passage; it never adds or reorders words.
 * (One-entry cache: a quiz checks every quote, then every revision, against the same text.)
 */
function documentVariants(markdown: string): Variant[] {
  if (lastVariants?.source === markdown) return lastVariants.variants;
  const steps = [withoutImages, withoutLinks, withoutInlineCode, withoutListNumbers];
  const variants: Variant[] = [];
  for (let mask = 0; mask < 1 << steps.length; mask++) {
    const text = steps.reduce((md, step, i) => (mask & (1 << i) ? step(md) : md), markdown);
    variants.push({ haystack: ` ${visibleText(text)} `, listNumbers: (mask & 8) !== 0 });
  }
  lastVariants = { source: markdown, variants };
  return variants;
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
function quoteGrounded(rawQuote: string, variants: readonly Variant[]): boolean {
  const words = (listNumbers: boolean) => visibleText(listNumbers ? withoutListNumbers(rawQuote) : rawQuote).split(" ").filter(Boolean);
  const plain = words(false);
  const stripped = words(true);
  const wordsOf = (v: Variant) => (v.listNumbers ? stripped : plain);
  if (variants.some((v) => wordsOf(v).length >= MIN_QUOTE_WORDS && contiguous(v.haystack, wordsOf(v)))) return true;
  if (!TRUNCATED.test(rawQuote.trim())) return false;
  return variants.some((v) => {
    const w = wordsOf(v);
    for (let k = w.length - 1; k >= MIN_TRUNCATED_PREFIX_WORDS; k--) {
      if (w.length - k > MAX_TRUNCATED_TAIL_WORDS) break;
      if (contiguous(v.haystack, w.slice(0, k))) return true;
    }
    return false;
  });
}

/**
 * Deterministic groundedness check: each question's `sourceQuote` must appear in the document's
 * visible text (>= 3 words, same order; see quoteGrounded for the truncation rule). Positions in `ungrounded` are 1-based.
 */
export function checkGrounding(
  quiz: { questions: readonly { sourceQuote: string }[] },
  sourceText: string,
): { ok: boolean; ungrounded: number[] } {
  const variants = documentVariants(sourceText);
  const ungrounded: number[] = [];
  quiz.questions.forEach((q, i) => {
    if (!quoteGrounded(q.sourceQuote, variants)) ungrounded.push(i + 1);
  });
  return { ok: ungrounded.length === 0, ungrounded };
}
