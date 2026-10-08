import type { GeneratedQuestion } from "@quizforge/core";
import type { Section } from "./source.js";

const DIFFICULTY_RANK = { easy: 0, medium: 1, hard: 2 } as const;
const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

const words = (s: string) => norm(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);

/**
 * Choose up to `k` sections to generate from, returned in document order. Without a topic the
 * choice is spread evenly across the document (coverage); with a topic, sections are ranked by
 * keyword overlap first.
 */
export function pickSections(sections: Section[], k: number, topic?: string): Section[] {
  const usable = sections.filter((s) => s.tokens >= 40);
  if (usable.length <= k) return usable;
  if (topic) {
    const wanted = new Set(words(topic));
    const scored = usable
      .map((s, i) => ({ s, i, score: words(`${s.heading} ${s.text}`).filter((w) => wanted.has(w)).length }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, k)
      .sort((a, b) => a.i - b.i);
    if (scored.some((x) => x.score > 0)) return scored.map((x) => x.s);
  }
  const picked: Section[] = [];
  for (let j = 0; j < k; j++) picked.push(usable[Math.floor(((j + 0.5) * usable.length) / k)]!);
  return [...new Set(picked)];
}

/**
 * Deterministic "reduce": take candidates round-robin across sections (so one section cannot
 * dominate), skip duplicate prompts, then order easy -> hard so the growing weights reward the
 * harder, later questions.
 */
export function selectQuestions(candidatesBySection: GeneratedQuestion[][], n: number): GeneratedQuestion[] {
  const queues = candidatesBySection.map((q) => [...q]);
  const chosen: GeneratedQuestion[] = [];
  const seen = new Set<string>();
  while (chosen.length < n && queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      while (q.length > 0) {
        const c = q.shift()!;
        const key = norm(c.prompt);
        if (seen.has(key)) continue;
        seen.add(key);
        chosen.push(c);
        break;
      }
      if (chosen.length >= n) break;
    }
  }
  return sortByDifficulty(chosen);
}

/** Stable easy -> hard ordering: later questions weigh more, so harder ones should come later. */
export function sortByDifficulty(questions: GeneratedQuestion[]): GeneratedQuestion[] {
  return questions
    .map((q, i) => ({ q, i }))
    .sort((a, b) => DIFFICULTY_RANK[a.q.difficulty] - DIFFICULTY_RANK[b.q.difficulty] || a.i - b.i)
    .map((x) => x.q);
}
