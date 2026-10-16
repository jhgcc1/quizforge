/**
 * The classifier reads at most 512 tokens (about 1,800 English characters). A README is longer, so the text is cut into
 * paragraph-aligned windows. Markdown syntax is removed and the markup noise that fools the classifier is dropped (see
 * `prepareForDetector`), but NOTHING that reads like a sentence is: an attack hides in code, link titles and image alt text.
 * The keyword rules and the output rails never see this cleaned text, they always read the raw document.
 */

export interface ChunkOptions {
  maxChars?: number;
  maxChunks?: number;
  /** Document-level cleaner that runs before the text is cut into paragraphs. Default: `prepareForDetector`. Only tests and the measurement script pass another one. */
  prepare?: (markdown: string) => string;
  /** Paragraph-level Markdown stripper. Default: `plainText`. Only tests and the measurement script pass another one (the "before" baseline). */
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

/** The address of a status badge (build, coverage, licence, contributors...). Only these images are dropped: the alt text of any other image can carry an instruction and stays. */
export const BADGE_URL = /shields\.io|badge|badgen|codecov|coveralls|travis-ci|circleci|codacy|sonarcloud|snyk\.io|bestpractices|contrib\.rocks|opencollective\.com\/[^\s)]*\/(?:contributors|backers|sponsors)/i;

/**
 * Prepare a document for the CLASSIFIER ONLY. A model that scores "does this look like an injection" is fooled by markup noise: the
 * leftovers of a badge row ("![License MIT ](") made it flag real READMEs (docs/security/detector-prep.md has the measurement).
 * Status badges go, with the link around them (their alt text is a label); every other image keeps its alt text, which can carry
 * an instruction. Code stays: dropping it removed the last false positive but lost every attack hidden in a code block (50.8% to
 * 0% of the 640 nightly attacks, measured), and keeping only its comments and sentences did not help (5 flagged instead of 1).
 */
export function prepareForDetector(md: string): string {
  return md
    .replace(/\[\s*(!\[[^\]]*\]\(([^)]*)\))\s*\]\([^)]*\)/g, (m, _image: string, url: string) => (BADGE_URL.test(url) ? " " : m)) // [![badge](image)](link)
    .replace(/!\[[^\]]*\]\(([^)]*)\)/g, (m, url: string) => (BADGE_URL.test(url) ? " " : m))
    .replace(/<img\b[^>]*>/gi, (m) => (BADGE_URL.test(m) ? " " : m));
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
