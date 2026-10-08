import type { GeneratedQuestion } from "@quizforge/core";
import { JobBudget, type Usage } from "./budget.js";
import { BudgetExceededError } from "./errors.js";
import { judgeQuiz, type JudgeResult } from "./judge.js";
import type { LlmClient } from "./llm.js";
import { scoreTrace, traced, withGenerationTracing } from "./observability.js";
import { QUALITY_VERSION, scoreQuiz } from "./quality.js";

/**
 * The judge is advisory (a failure never fails the quiz) but is tried twice, because a missing score is a hole in the
 * monitoring. A budget overrun is final: retrying cannot help.
 */
export async function judgeWithRetry(p: {
  llm: LlmClient;
  samples?: number | undefined;
  budget: JobBudget;
  sourceText: string;
  questions: GeneratedQuestion[];
}): Promise<{ judge?: JudgeResult; failed: boolean }> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const judge = await judgeQuiz({ llm: p.llm, ...(p.samples ? { samples: p.samples } : {}), budget: p.budget, context: p.sourceText.slice(0, 60_000), questions: p.questions });
      return { judge, failed: false };
    } catch (err) {
      console.warn(JSON.stringify({ level: "warn", msg: "judge failed", attempt, error: (err as Error).message }));
      if (err instanceof BudgetExceededError) break;
    }
  }
  return { failed: true };
}

export const judgeNote = (model: string, judge: JudgeResult): string => `judge=${model} samples=${judge.samples} spread=${judge.spread.toFixed(2)} v=${QUALITY_VERSION}`;

export interface ScoreExistingParams {
  /** The judge model's client. */
  llm: LlmClient;
  judgeSamples?: number | undefined;
  questions: GeneratedQuestion[];
  sourceText: string;
  /** Langfuse trace of the GENERATION: the judge scores are attached to it, next to the fast scores that are already there. */
  traceId?: string | null | undefined;
  quizId?: string | undefined;
}

export interface ScoreExistingResult {
  scores: Record<string, number>;
  /** `quality_overall`; undefined when the judge failed (never a different formula under the same name). */
  quality: number | undefined;
  judge?: JudgeResult;
  judgeFailed: boolean;
  usage: Usage;
  qualityVersion: string;
  judgeModel: string;
}

/**
 * Score a quiz that is ALREADY saved: run the judge, compute every metric with the one shared method (quality.ts) and send
 * the judge-dependent scores to Langfuse. This is what the scorer service runs, off the path of the user's request.
 * The judge calls are traced as generations (time, tokens, cost) in a "quiz-scoring" trace of the same session.
 */
export async function scoreExistingQuiz(p: ScoreExistingParams): Promise<ScoreExistingResult> {
  return traced(
    "quiz-scoring",
    { ...(p.quizId ? { sessionId: p.quizId } : {}), tags: ["quizforge", "scoring"], metadata: { qualityVersion: QUALITY_VERSION, judgeModel: p.llm.model, generationTrace: p.traceId ?? undefined } },
    async () => {
      const budget = new JobBudget();
      const { judge, failed } = await judgeWithRetry({ llm: withGenerationTracing(p.llm), samples: p.judgeSamples, budget, sourceText: p.sourceText, questions: p.questions });
      const q = await scoreQuiz({ questions: p.questions, sourceText: p.sourceText, judge });
      const note = judge ? judgeNote(p.llm.model, judge) : undefined;
      const traceId = p.traceId ?? undefined;
      await Promise.all([
        ...Object.entries(q.scores)
          .filter(([name]) => name.startsWith("judge_"))
          .map(([name, value]) => scoreTrace(traceId, name, value, name === "judge_overall" ? `${note} | ${judge?.scores.reasoning ?? ""}`.slice(0, 1500) : undefined)),
        ...(q.quality !== undefined ? [scoreTrace(traceId, "quality_overall", q.quality, note)] : []),
        ...(failed ? [scoreTrace(traceId, "judge_failed", 1)] : []),
      ]);
      return { scores: q.scores, quality: q.quality, ...(judge ? { judge } : {}), judgeFailed: failed, usage: judge?.usage ?? { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, qualityVersion: QUALITY_VERSION, judgeModel: p.llm.model };
    },
  );
}
