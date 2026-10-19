/**
 * The worker stores the raw failure (class name + technical message) on the quiz for operators. Users get a sentence
 * they can act on, never an exception name or an internal detail.
 */
/**
 * The classifier's verdict read back from the failure stored on a quiz: the score and the text it came from, or undefined
 * when the quiz failed for another reason. One place decides what "refused by the classifier" means — the flag on the quiz
 * and the review request both ask this, and a client should never have to match on the wording of a message.
 */
/**
 * The score and, when the worker could supply it, the piece of the DOCUMENT the classifier reacted to.
 *
 * A reviewer is being asked to judge a document, so the evidence is what the classifier read — not the sentence
 * saying it scored 1.00, which is a verdict and tells nobody anything. The worker appends it after "excerpt:"; older
 * rows have no excerpt and fall back to the message, which is still better than nothing.
 */
export function classifierFinding(raw: string | null): { score: number; excerpt: string } | undefined {
  const text = raw ?? "";
  const m = /the classifier scored ([0-9.]+)/.exec(text);
  if (!m) return undefined;
  const found = /— excerpt: ([\s\S]+)$/.exec(text);
  return { score: Number(m[1]), excerpt: (found?.[1] ?? text).trim().slice(0, 500) };
}

export function userFacingError(raw: string | null): string | null {
  if (!raw) return null;
  // problems the user can fix themselves are shown (they come from our own validation, not from stack traces)
  const host = /host not allowed:\s*(\S+)/i.exec(raw)?.[1];
  if (host) return `The host "${host}" is not allowed. Use a Markdown file hosted on github.com or raw.githubusercontent.com.`;
  if (/exceeds \d+ bytes|too_large/i.test(raw)) return "That document is too large (limit 512 KB). Try a shorter one.";
  if (/not a valid URL|only https|credentials in URL|custom ports/i.test(raw)) return "That is not a valid https document URL.";
  if (/document is empty|has no usable sections|unexpected content-type/i.test(raw)) return "That URL does not contain a readable Markdown/text document.";
  if (/source returned HTTP 404/i.test(raw)) return "The document was not found (HTTP 404). Check the URL.";
  if (/not_text:/i.test(raw)) return "That link does not point to a text document (it looks like a binary file). Use a Markdown or text file.";
  // The classifier rejecting a document is not proof of an attack: it scores some real READMEs high (6 of 722 above 0.9),
  // so this message offers the way out instead of leaving the user at a dead end.
  if (/the classifier scored/i.test(raw)) return "Our prompt-injection classifier rejected this document. If it is a legitimate README, you can ask for it to be reviewed and added to the document list.";
  if (/unsafe_document/i.test(raw)) return "This document contains hidden or encoded text, so it was rejected for safety. Remove it and try again.";
  if (/unsupported_language/i.test(raw)) return "This document is not in a supported language. Supported: English, Portuguese and Spanish.";
  if (/invalid_llm_input/i.test(raw)) return "This request could not be processed safely. Check the topic and the document.";
  if (/QualityGateError|StructuredOutputError|UnsafeOutputError|unsafe_output|not grounded|grounded question/i.test(raw)) return "The AI could not produce a reliable quiz from this document. Please try again.";
  if (/budget exceeded/i.test(raw)) return "This document is too large or complex to process within our limits. Try a shorter one.";
  if (/timed out/i.test(raw)) return "Generation took too long. Please try again.";
  return "Quiz generation failed. Please try again.";
}
