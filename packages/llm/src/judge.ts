import { z } from "zod";
import type { GeneratedQuestion } from "@quizforge/core";
import type { JobBudget, Usage } from "./budget.js";
import type { LlmClient } from "./llm.js";
import { JUDGE_SYSTEM, neutralize } from "./prompts.js";
import { generateStructured } from "./structured.js";

const Score = z.number().min(1).max(5);
export const JudgeSchema = z.object({
  faithfulness: Score,
  clarity: Score,
  distractors: Score,
  coverage: Score,
  difficulty_mix: Score,
  reasoning: z.string().max(1500).default(""),
});
export type JudgeScores = z.output<typeof JudgeSchema>;

export interface JudgeResult {
  scores: JudgeScores;
  /** Highest minus lowest `overall` among the samples: a direct measure of how noisy this judgement was. */
  spread: number;
  samples: number;
  /** Weighted mean normalized to 0..1 (faithfulness counts double: a wrong quiz is the worst failure). */
  overall: number;
  usage: Usage;
}

const WEIGHTS = { faithfulness: 2, clarity: 1, distractors: 1, coverage: 1, difficulty_mix: 0.5 } as const;

export function overallFromJudge(s: JudgeScores): number {
  let sum = 0;
  let total = 0;
  for (const [k, w] of Object.entries(WEIGHTS) as [keyof typeof WEIGHTS, number][]) {
    sum += ((s[k] - 1) / 4) * w;
    total += w;
  }
  return sum / total;
}

/**
 * LLM-as-judge for generation quality. It uses a different system prompt and temperature 0 from the
 * generator to limit self-preference bias; correctness of SCORING never goes through an LLM.
 */
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * LLM judges are noisy: the same quiz was scored 0.86, 0.86, 0.93, 0.86 and 0.45 by one model in five calls.
 * With `samples > 1` the judge runs several times and every criterion takes the MEDIAN, which a single outlier cannot move.
 */
export async function judgeQuiz(p: {
  llm: LlmClient;
  budget: JobBudget;
  context: string;
  questions: GeneratedQuestion[];
  samples?: number;
}): Promise<JudgeResult> {
  const quiz = p.questions.map((q, i) => ({
    n: i + 1,
    prompt: q.prompt,
    options: q.options,
    correct: q.correct,
    explanation: q.explanation,
    difficulty: q.difficulty,
  }));
  const user = `<document>\n${neutralize(p.context)}\n</document>\n\nQuiz to evaluate (JSON):\n${JSON.stringify(quiz, null, 1)}`;
  const n = Math.max(1, p.samples ?? 1);
  // The samples are independent, so they run in parallel: 3 samples cost the latency of 1.
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      generateStructured({ llm: p.llm, budget: p.budget, schema: JudgeSchema, system: JUDGE_SYSTEM, user, maxRepairs: 1, options: { name: n > 1 ? `judge:${i + 1}/${n}` : "judge", temperature: 0 } }),
    ),
  );
  const runs: JudgeScores[] = results.map((r) => r.value);
  const usage = results.reduce((u, r) => ({ promptTokens: u.promptTokens + r.usage.promptTokens, completionTokens: u.completionTokens + r.usage.completionTokens, cachedTokens: u.cachedTokens + r.usage.cachedTokens }), { promptTokens: 0, completionTokens: 0, cachedTokens: 0 });
  const pick = (k: "faithfulness" | "clarity" | "distractors" | "coverage" | "difficulty_mix") => median(runs.map((r) => r[k]));
  const overalls = runs.map(overallFromJudge);
  const nearest = runs[overalls.indexOf(overalls.slice().sort((a, b) => Math.abs(a - median(overalls)) - Math.abs(b - median(overalls)))[0]!)]!;
  const scores: JudgeScores = { faithfulness: pick("faithfulness"), clarity: pick("clarity"), distractors: pick("distractors"), coverage: pick("coverage"), difficulty_mix: pick("difficulty_mix"), reasoning: nearest.reasoning };
  return { scores, overall: overallFromJudge(scores), spread: Math.max(...overalls) - Math.min(...overalls), samples: n, usage };
}
