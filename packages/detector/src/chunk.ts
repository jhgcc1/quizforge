/**
 * The classifier reads at most 512 tokens (about 1,800 English characters). A README is longer, so the text is cut into
 * paragraph-aligned windows. Markdown syntax is removed and the markup noise that fools the classifier is dropped (see
 * `prepareForDetector`), but NOTHING that reads like a sentence is: an attack hides in code comments, string literals, link titles
 * and image alt text. The keyword rules and the output rails never see this cleaned text, they always read the raw document.
 */

export interface ChunkOptions {
  maxChars?: number;
  maxChunks?: number;
  /** Document-level cleaner that runs before the text is cut into paragraphs. Default: `prepareForDetector`. Only the measurement scripts pass another one. */
  prepare?: (markdown: string) => string;
  /** Paragraph-level Markdown stripper. Default: `plainText`. Only the measurement script passes another one (the "before" baseline). */
  plain?: (paragraph: string) => string;
}

/** Markdown without its syntax: link and image text and titles stay, URLs and bare symbols go; code stays. */
export function plainText(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!?\[([^\]]*)\]\(\s*[^)\s]*(?:\s+["']([^"']*)["'])?\s*\)/g, "$1 $2")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/!\[|\]\((?=\s|$)/g, " ") // what is left of an image or a link whose address was cut (a badge row): noise for the classifier
    .replace(/<[^>]+>/g, " ")
    .replace(/```[a-z]*/gi, " ")
    .replace(/[#>*_|~`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** How the classifier input is prepared. Only the measurement script uses anything but the defaults. */
export interface PrepareOptions {
  /** Status badges (an image whose address is a badge service, alone or wrapped in a link): drop them. Other images keep their alt text. Default true. */
  images?: boolean;
  /** Fenced and inline code. "keep" (default) leaves code as it is: an attack hides in code blocks and dropping them cost all of that recall. "prose" keeps only comments, string literals and prose-like lines, "drop" removes code. The last two are measured and rejected (docs/security/detector-prep.md). */
  code?: "prose" | "keep" | "drop";
}

/** The address of a status badge (build, coverage, licence, contributors...). Only these images are dropped: the alt text of any other image can carry an instruction and stays. */
export const BADGE_URL = /shields\.io|badge|badgen|codecov|coveralls|travis-ci|circleci|codacy|sonarcloud|snyk\.io|bestpractices|contrib\.rocks|opencollective\.com\/[^\s)]*\/(?:contributors|backers|sponsors)/i;

const MIN_PROSE_WORDS = 4;

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;
/** Reads like a phrase: a few words and almost no code punctuation. */
const isProse = (s: string): boolean => wordCount(s) >= MIN_PROSE_WORDS && (s.match(/[{}[\]();=<>$\\|&]/g) ?? []).length / s.length < 0.04;

/** The lines of a code block that are language, not code: comment text, quoted strings of a few words, and sentences without code punctuation. */
export function proseOfCode(block: string): string {
  const keep: string[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const comment = /^(?:\/\/+|#+|--|\*+|\/\*+)\s*(.*?)\s*(?:\*\/)?$/.exec(line)?.[1] ?? /\s(?:\/\/|#)\s+(.+)$/.exec(line)?.[1];
    if (comment !== undefined) {
      if (wordCount(comment) >= MIN_PROSE_WORDS) keep.push(comment);
      continue;
    }
    for (const m of line.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.){12,})\1/g)) if (wordCount(m[2]!) >= MIN_PROSE_WORDS) keep.push(m[2]!);
    if (isProse(line)) keep.push(line);
  }
  return keep.join("\n");
}

/**
 * Prepare a document for the CLASSIFIER ONLY. A model that scores "does this look like an injection" is fooled by markup noise: the
 * leftovers of a badge row ("![License MIT ](") and code full of imperative words made it flag real READMEs
 * (docs/security/detector-prep.md has the measurement). So:
 *   - status badges go, with the link around them (their alt text is a label, and the leftovers of a badge row were the trigger);
 *     every other image keeps its alt text, which can carry an instruction.
 * Code stays by default: dropping it removed the last false positive but lost every attack hidden in a code block (50.8% to 0% of
 * the 640 nightly attacks, measured), and keeping only its comments and prose lines did not help (4 false positives instead of 1).
 * The `code` option exists for the measurement script only.
 */
export function prepareForDetector(md: string, opts: PrepareOptions = {}): string {
  const { images = true, code = "keep" } = opts;
  let t = md;
  if (images) {
    t = t
      .replace(/\[\s*(!\[[^\]]*\]\(([^)]*)\))\s*\]\([^)]*\)/g, (m, image: string, url: string) => (BADGE_URL.test(url) ? " " : m.replace(image, image))) // [![badge](image)](link)
      .replace(/!\[[^\]]*\]\(([^)]*)\)/g, (m, url: string) => (BADGE_URL.test(url) ? " " : m))
      .replace(/<img\b[^>]*>/gi, (m) => (BADGE_URL.test(m) ? " " : m));
  }
  if (code !== "keep") {
    const fence = (m: string): string => (code === "drop" ? " " : proseOfCode(m.replace(/^(?:```|~~~)[^\n]*\n?/, "").replace(/(?:```|~~~)$/, "")));
    t = t.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, fence).replace(/`([^`\n]*)`/g, (_m, c: string) => (isProse(c) ? c : " "));
  }
  return t;
}

export function chunkProse(text: string, opts: ChunkOptions = {}): { chunks: string[]; total: number } {
  const maxChars = opts.maxChars ?? 1600;
  const maxChunks = opts.maxChunks ?? 48;
  // paragraphs first (keeps sentences together), prose-cleaned
  const paragraphs = (opts.prepare ?? prepareForDetector)(text)
    .split(/\n{2,}/)
    .map((p) => (opts.plain ?? plainText)(p))
    .filter((p) => p.length >= 8);
  const all: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) all.push(cur.trim());
    cur = "";
  };
  for (const p of paragraphs) {
    if (p.length > maxChars) {
      push();
      for (let i = 0; i < p.length; i += maxChars) all.push(p.slice(i, i + maxChars));
    } else if (cur.length + p.length + 1 > maxChars) {
      push();
      cur = p;
    } else cur = cur ? `${cur} ${p}` : p;
  }
  push();
  if (all.length <= maxChunks) return { chunks: all, total: all.length };
  // too many windows: keep an even spread (an attack can be anywhere in a document), always the first and the last
  const step = (all.length - 1) / (maxChunks - 1);
  const picked = Array.from({ length: maxChunks }, (_, i) => all[Math.round(i * step)]!);
  return { chunks: [...new Set(picked)], total: all.length };
}
