/**
 * The 500-sample seeded stratified sample of `packages/detector/src/benchmark.ts`, re-implemented IDENTICALLY (same PRNG, same shuffle,
 * same stratification), because benchmark.ts runs at import time and cannot be imported. A test pins the numbers (97 / 68).
 */
import { inspectText } from "@quizforge/core";
import { detectLanguage } from "@quizforge/llm";

export interface DatasetRow { split?: string; text: string; label: number }
export interface SampleRow extends DatasetRow { id: number }

/** Small seeded PRNG (mulberry32), the same as the benchmark. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}

/** The benchmark sample: injections first, then benign. `id` is the row index in the dataset array. */
export function benchmarkSample(rows: DatasetRow[], n = 500, seed = 1): SampleRow[] {
  const all = rows.map((r, i) => ({ ...r, id: i }));
  const rand = rng(seed);
  const inj = shuffle(all.filter((r) => r.label === 1), rand);
  const ben = shuffle(all.filter((r) => r.label === 0), rand);
  const nInj = Math.round((n * inj.length) / all.length);
  return [...inj.slice(0, nInj), ...ben.slice(0, n - nInj)];
}

/** English injections of the sample (by `detectLanguage`) that the keyword rules do NOT flag or block. */
export function missedByGuard(sample: SampleRow[]): { english: SampleRow[]; missed: SampleRow[] } {
  const english = sample.filter((s) => s.label === 1 && detectLanguage(s.text) === "en");
  const missed = english.filter((s) => !inspectText(s.text).findings.some((f) => f.severity !== "sanitize"));
  return { english, missed };
}
