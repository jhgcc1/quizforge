/**
 * Splitting a document by its headings. Not about fetching at all -- it is read by the router (to choose
 * single-shot or section map-reduce), by the graph (to feed one section per call) and by the quality score (to
 * measure coverage). It lives under source/ because a "section" is a property of the document that was fetched.
 */

export interface Section {
  heading: string;
  level: number;
  text: string;
  tokens: number;
}

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/** Split by markdown headings (ignoring '#' lines inside fenced code). Preamble becomes its own section. */
export function splitSections(md: string): Section[] {
  const sections: Section[] = [];
  let heading = "(intro)";
  let level = 0;
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) sections.push({ heading, level, text, tokens: estimateTokens(text) });
    buf = [];
  };
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence ? /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (m) {
      flush();
      heading = m[2]!;
      level = m[1]!.length;
    }
    buf.push(line);
  }
  flush();
  return sections;
}
