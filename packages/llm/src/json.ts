/**
 * Reasoning models (MiniMax M2.x/M3) wrap answers in <think>…</think> and often fence JSON in
 * ```json blocks, even when asked for JSON only. These helpers turn raw completions into a value.
 */

export class JsonExtractionError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "JsonExtractionError";
  }
}

/** Remove <think> blocks. An unterminated <think> (truncated output) drops everything after it. */
export function stripThink(text: string): string {
  const closed = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const openIdx = closed.search(/<think>/i);
  return (openIdx === -1 ? closed : closed.slice(0, openIdx)).trim();
}

/** Return the first balanced top-level {...} or [...] in `text`, honoring string literals. */
export function firstBalancedJson(text: string): string | null {
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    // unbalanced from this start (e.g. truncated); try later starts
  }
  return null;
}

/** Strip <think>, unwrap ``` fences, and parse the first balanced JSON value. */
export function extractJson(raw: string): unknown {
  const noThink = stripThink(raw);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(noThink);
  const candidate = firstBalancedJson(fenced?.[1] ?? noThink) ?? firstBalancedJson(noThink);
  if (!candidate) {
    throw new JsonExtractionError("no JSON object found in model output", raw);
  }
  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new JsonExtractionError(`invalid JSON: ${(err as Error).message}`, raw);
  }
}
