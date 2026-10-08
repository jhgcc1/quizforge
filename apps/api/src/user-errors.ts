/**
 * The worker stores the raw failure (class name + technical message) on the quiz for operators. Users get a sentence
 * they can act on, never an exception name or an internal detail.
 */
export function userFacingError(raw: string | null): string | null {
  if (!raw) return null;
  // problems the user can fix themselves are shown (they come from our own validation, not from stack traces)
  const host = /host not allowed:\s*(\S+)/i.exec(raw)?.[1];
  if (host) return `The host "${host}" is not allowed. Use a Markdown file hosted on github.com or raw.githubusercontent.com.`;
  if (/exceeds \d+ bytes|too_large/i.test(raw)) return "That document is too large (limit 512 KB). Try a shorter one.";
  if (/not a valid URL|only https|credentials in URL|custom ports/i.test(raw)) return "That is not a valid https document URL.";
  if (/document is empty|has no usable sections|unexpected content-type/i.test(raw)) return "That URL does not contain a readable Markdown/text document.";
  if (/source returned HTTP 404/i.test(raw)) return "The document was not found (HTTP 404). Check the URL.";
  if (/QualityGateError|StructuredOutputError|not grounded|grounded question/i.test(raw)) return "The AI could not produce a reliable quiz from this document. Please try again.";
  if (/budget exceeded/i.test(raw)) return "This document is too large or complex to process within our limits. Try a shorter one.";
  if (/timed out/i.test(raw)) return "Generation took too long. Please try again.";
  return "Quiz generation failed. Please try again.";
}
