import { visibleText, type GeneratedQuestion } from "@quizforge/core";
import { splitSections } from "@quizforge/llm";
import { cosine, maxPairwise, type Embedder } from "./similarity.js";

/** A hand-written "expected" question for a document: what a good quiz on it should be asking about. */
export interface Reference {
  prompt: string;
  answer: string;
  sourceQuote: string;
}

export const questionText = (q: GeneratedQuestion): string => `${q.prompt} ${q.correct.map((i) => q.options[i]).join("; ")}`;
export const referenceText = (r: Reference): string => `${r.prompt} ${r.answer}`;

/** Paragraph-sized passages of the document in readable form (links/URLs/tables of links reduced to their words). */
export function docChunks(sourceText: string): string[] {
  const sections = splitSections(sourceText).filter((s) => s.tokens >= 20);
  const raw = (sections.length ? sections.map((s) => s.text) : [sourceText]).flatMap((t) => t.split(/\n\s*\n/));
  return raw.map((c) => visibleText(c)).filter((c) => c.split(" ").length >= 6).map((c) => c.split(" ").slice(0, 120).join(" "));
}

const bestMatch = (v: number[], pool: number[][]): number => (pool.length ? Math.max(...pool.map((p) => cosine(v, p))) : 0);
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Embedding-based quality signals (all 0..1 for sensible text, higher = better):
 *  - ref_recall     does the quiz ask about what the reference questions ask about? (reference -> best generated question)
 *  - ref_precision  is each generated question close to SOME reference question? (generated -> best reference)
 *  - emb_relevance  is each question close to some passage of the document?
 *  - emb_diversity  1 - highest cosine between two different questions (catches paraphrased duplicates TF-IDF misses)
 *  - ref_control    NEGATIVE CONTROL, not scored: best-match against references of OTHER documents. It must sit well below ref_precision.
 */
export async function semanticScores(p: {
  questions: GeneratedQuestion[];
  references: Reference[];
  sourceText: string;
  embedder: Embedder;
  /** references of other documents, used only for the negative control */
  otherReferences?: Reference[];
}): Promise<Record<string, number>> {
  const chunks = docChunks(p.sourceText);
  const texts = [...p.questions.map(questionText), ...p.references.map(referenceText), ...(p.otherReferences ?? []).map(referenceText), ...chunks];
  const v = await p.embedder.embed(texts);
  let at = 0;
  const take = (n: number) => v.slice(at, (at += n));
  const qv = take(p.questions.length);
  const rv = take(p.references.length);
  const ov = take(p.otherReferences?.length ?? 0);
  const cv = take(chunks.length);
  const out: Record<string, number> = {
    emb_diversity: 1 - maxPairwise(qv),
    emb_relevance: mean(qv.map((x) => bestMatch(x, cv))),
  };
  if (rv.length) {
    out.ref_recall = mean(rv.map((r) => bestMatch(r, qv)));
    out.ref_precision = mean(qv.map((q) => bestMatch(q, rv)));
  }
  if (ov.length) out.ref_control = mean(qv.map((q) => bestMatch(q, ov)));
  return out;
}
