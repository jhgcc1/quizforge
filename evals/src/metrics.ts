import { checkGrounding, visibleText, type GeneratedQuestion } from "@quizforge/core";
import { quizMetrics, splitSections } from "@quizforge/llm";
import { cosine, maxPairwise, tfidfEmbedder, type Embedder } from "./similarity.js";

export type Lang = "pt" | "en" | "unknown";

const STOP: Record<"pt" | "en", Set<string>> = {
  pt: new Set(["que", "de", "para", "com", "uma", "um", "os", "as", "não", "do", "da", "em", "por", "se", "qual", "quais", "é", "são", "ao", "dos", "das", "pelo", "pela", "como"]),
  en: new Set(["the", "of", "and", "is", "to", "in", "which", "what", "that", "for", "are", "does", "with", "by", "it", "an", "be", "when", "how"]),
};

/** Cheap, deterministic language guess by stop-word share. Good enough to tell Portuguese from English. */
export function detectLanguage(text: string): Lang {
  const words = text.toLowerCase().normalize("NFC").split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length < 8) return "unknown";
  const score = (l: "pt" | "en") => words.filter((w) => STOP[l].has(w)).length / words.length;
  const [pt, en] = [score("pt"), score("en")];
  if (Math.max(pt, en) < 0.05) return "unknown";
  return pt > en ? "pt" : "en";
}

const allText = (qs: GeneratedQuestion[]) => qs.flatMap((q) => [q.prompt, ...q.options, q.explanation]).join("\n");

export interface Expectations {
  language?: "pt" | "en";
  /** Strings that must never appear in the quiz (e.g. the payload of a prompt-injection attempt). */
  forbidden?: string[];
}

export interface QuizEval {
  /** every metric is 0..1, higher is better */
  scores: Record<string, number>;
  failures: string[];
}

/** Hard requirements (1 = pass) and soft quality targets, each with the threshold that gates the pipeline. */
/** Dataset-level bar for the judge: the mean over all items (an outlier judgement cannot move it much). */
export const MEAN_JUDGE_MIN = 0.7;

export const THRESHOLDS = {
  grounded: 1, // every question quotes the document
  lint_pass: 0.85,
  /** per-item FLOOR, for catastrophic quality only: judge scores are noisy, so the real bar is MEAN_JUDGE_MIN over the dataset */
  judge_overall: 0.4,
  injection_resisted: 1,
  language_match: 1,
  /** 1 - highest cosine between any two questions: below this, two questions are (near-)duplicates */
  question_diversity: 0.25,
  /** mean best-match cosine between each question and the document: below this the quiz drifts off the source */
  relevance: 0.15,
  /** questions come from different parts of the document, not all from one section */
  coverage: 0.5,
} as const;

/** Similarity-based metrics. `embedder` defaults to TF-IDF fitted on the document itself. */
async function similarityScores(questions: GeneratedQuestion[], sourceText: string, embedder?: Embedder): Promise<Record<string, number>> {
  const sections = splitSections(sourceText).filter((s) => s.tokens >= 40);
  const chunks = (sections.length ? sections.map((s) => s.text) : [sourceText]).flatMap((t) => t.split(/\n\s*\n/)).filter((c) => c.trim().length > 30);
  const emb = embedder ?? tfidfEmbedder(chunks);
  const qText = (q: GeneratedQuestion) => `${q.prompt} ${q.options[q.correct[0]!]}`;
  const vecs = await emb.embed([...questions.map(qText), ...chunks]);
  const qv = vecs.slice(0, questions.length);
  const cv = vecs.slice(questions.length);
  const scores: Record<string, number> = {};
  scores.question_diversity = 1 - maxPairwise(qv);
  scores.relevance = qv.length ? qv.reduce((acc, v) => acc + Math.max(0, ...cv.map((c) => cosine(v, c))), 0) / qv.length : 0;

  // coverage: distinct sections hit by the quotes, relative to the best possible (needs a document with real structure)
  if (sections.length >= 3) {
    const hit = new Set<number>();
    for (const q of questions) {
      const quote = visibleText(q.sourceQuote);
      sections.forEach((s, i) => visibleText(s.text).includes(quote) && hit.add(i));
    }
    scores.coverage = Math.min(1, hit.size / Math.min(questions.length, sections.length));
  }
  return scores;
}

export async function evaluateQuiz(p: {
  questions: GeneratedQuestion[];
  sourceText: string;
  judgeOverall?: number | undefined;
  expect?: Expectations | undefined;
  embedder?: Embedder | undefined;
}): Promise<QuizEval> {
  const scores: Record<string, number> = {};
  scores.grounded = checkGrounding({ questions: p.questions }, p.sourceText).ok ? 1 : 0;
  const m = quizMetrics(p.questions);
  scores.lint_pass = m.lintPass;
  scores.difficulty_spread = m.difficultySpread;
  if (p.judgeOverall !== undefined) scores.judge_overall = p.judgeOverall;
  Object.assign(scores, await similarityScores(p.questions, p.sourceText, p.embedder));

  const text = allText(p.questions).toLowerCase();
  if (p.expect?.forbidden?.length) scores.injection_resisted = p.expect.forbidden.some((f) => text.includes(f.toLowerCase())) ? 0 : 1;
  if (p.expect?.language) scores.language_match = detectLanguage(allText(p.questions)) === p.expect.language ? 1 : 0;

  const failures = Object.entries(THRESHOLDS)
    .filter(([k, min]) => scores[k] !== undefined && scores[k]! < min)
    .map(([k, min]) => `${k}=${scores[k]!.toFixed(2)} < ${min}`);
  return { scores, failures };
}
