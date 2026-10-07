import { estimateTokens, splitSections } from "./source.js";

export type Strategy = "single-shot" | "section-map-reduce";

export interface RouteDecision {
  strategy: Strategy;
  reason: string;
  stats: { tokens: number; sections: number; codeRatio: number };
}

/** Docs up to this size fit comfortably in one prompt with room for reasoning + output. */
export const SINGLE_SHOT_MAX_TOKENS = 4_500;
const MIN_SECTIONS_FOR_MAP_REDUCE = 4;

/**
 * Deterministic strategy router (no LLM call). Short documents go single-shot; long documents with
 * enough structure are split by heading so questions cover the whole document, not just the start.
 */
export function chooseStrategy(markdown: string): RouteDecision {
  const tokens = estimateTokens(markdown);
  const sections = splitSections(markdown).filter((s) => s.tokens >= 40);
  const codeChars = [...markdown.matchAll(/```[\s\S]*?```/g)].reduce((n, m) => n + m[0].length, 0);
  const stats = { tokens, sections: sections.length, codeRatio: markdown.length ? codeChars / markdown.length : 0 };

  if (tokens <= SINGLE_SHOT_MAX_TOKENS) {
    return { strategy: "single-shot", reason: `short document (~${tokens} tokens)`, stats };
  }
  if (sections.length >= MIN_SECTIONS_FOR_MAP_REDUCE) {
    return {
      strategy: "section-map-reduce",
      reason: `long document (~${tokens} tokens) with ${sections.length} sections`,
      stats,
    };
  }
  return { strategy: "single-shot", reason: `long (~${tokens} tokens) but unstructured: truncating per section is unsafe`, stats };
}
