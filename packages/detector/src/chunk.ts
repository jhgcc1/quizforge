/**
 * The classifier reads at most 512 tokens (about 1,800 English characters). A README is longer, so the text is cut into
 * paragraph-aligned windows. Markdown syntax is removed but NOTHING is dropped: an attack hides in code blocks, link titles and
 * image alt text (a first version that kept only "prose" missed exactly those, see the corpus run in the architecture report).
 */

export interface ChunkOptions {
  maxChars?: number;
  maxChunks?: number;
}

/** Markdown without its syntax: link and image text and titles stay, URLs and bare symbols go; code stays. */
export function plainText(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!?\[([^\]]*)\]\(\s*[^)\s]*(?:\s+["']([^"']*)["'])?\s*\)/g, "$1 $2")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/```[a-z]*/gi, " ")
    .replace(/[#>*_|~`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function chunkProse(text: string, opts: ChunkOptions = {}): { chunks: string[]; total: number } {
  const maxChars = opts.maxChars ?? 1600;
  const maxChunks = opts.maxChunks ?? 48;
  // paragraphs first (keeps sentences together), prose-cleaned
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => plainText(p))
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
