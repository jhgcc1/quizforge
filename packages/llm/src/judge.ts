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
export async function judgeQuiz(p: {
  llm: LlmClient;
  budget: JobBudget;
  context: string;
  questions: GeneratedQuestion[];
}): Promise<JudgeResult> {
  const quiz = p.questions.map((q, i) => ({
    n: i + 1,
    prompt: q.prompt,
    options: q.options,
    correct: q.correct,
    explanation: q.explanation,
    difficulty: q.difficulty,
  }));
  const r = await generateStructured({
    llm: p.llm,
    budget: p.budget,
    schema: JudgeSchema,
    system: JUDGE_SYSTEM,
    user: `<document>\n${neutralize(p.context)}\n</document>\n\nQuiz to evaluate (JSON):\n${JSON.stringify(quiz, null, 1)}`,
    maxRepairs: 1,
    options: { name: "judge", temperature: 0 },
  });
  return { scores: r.value, overall: overallFromJudge(r.value), usage: r.usage };
}
