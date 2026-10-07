import type { GeneratedQuestion } from "@quizforge/core";
import { JobBudget, type BudgetState, type Usage } from "./budget.js";
import { judgeQuiz, type JudgeResult } from "./judge.js";
import { quizMetrics, type QuizMetrics } from "./lint.js";
import type { LlmClient } from "./llm.js";
import { scoreTrace, traced } from "./observability.js";
import { PROMPT_VERSION } from "./prompts.js";
import { runQuizGraph, type QuizGraphInput } from "./quiz-graph.js";
import type { Strategy } from "./router.js";
import type { BaseCheckpointSaver } from "@langchain/langgraph";

export interface GenerateQuizParams {
  llm: LlmClient;
  input: QuizGraphInput;
  /** Resume a previous allowance after an SQS redelivery. */
  budgetState?: BudgetState;
  judge?: boolean;
  trace?: { sessionId?: string; userId?: string; requestId?: string; tags?: string[] };
  threadId?: string;
  checkpointer?: BaseCheckpointSaver;
}

export interface GeneratedQuizResult {
  questions: GeneratedQuestion[];
  strategy: Strategy;
  routeReason: string;
  rounds: number;
  repairs: number;
  usage: Usage;
  budget: BudgetState;
  trail: string[];
  resumed: boolean;
  metrics: QuizMetrics;
  judge?: JudgeResult;
  /** 0..1 blend of deterministic metrics and (if run) the judge. Drives alerts. */
  quality: number;
  promptVersion: string;
  traceId?: string;
  model: string;
}

/** Overall quality in 0..1. Grounding is a hard gate in the graph, so it is not part of this blend. */
export function blendQuality(m: QuizMetrics, judge?: JudgeResult): number {
  const det = 0.6 * m.lintPass + 0.2 * m.difficultySpread + 0.2 * m.positionSpread;
  return judge ? 0.4 * det + 0.6 * judge.overall : det;
}

export async function generateQuiz(p: GenerateQuizParams): Promise<GeneratedQuizResult> {
  return traced(
    "quiz-generation",
    {
      ...(p.trace?.sessionId ? { sessionId: p.trace.sessionId } : {}),
      ...(p.trace?.userId ? { userId: p.trace.userId } : {}),
      tags: ["quizforge", ...(p.trace?.tags ?? [])],
      metadata: { requestId: p.trace?.requestId, promptVersion: PROMPT_VERSION, model: p.llm.model },
    },
    async (ctx) => {
      const budget = new JobBudget(undefined, p.budgetState);
      const run = await runQuizGraph({ llm: p.llm, budget }, p.input, {
        ...(p.threadId ? { threadId: p.threadId } : {}),
        ...(p.checkpointer ? { checkpointer: p.checkpointer } : {}),
        ...(ctx.callbacks.length ? { callbacks: ctx.callbacks } : {}),
      });
      const metrics = quizMetrics(run.questions);
      let judge: JudgeResult | undefined;
      if (p.judge !== false) {
        try {
          judge = await judgeQuiz({ llm: p.llm, budget, context: p.input.sourceText.slice(0, 60_000), questions: run.questions });
        } catch (err) {
          // The judge is advisory: a failure must not fail the quiz, but it is visible in traces/logs.
          console.warn(JSON.stringify({ level: "warn", msg: "judge failed", error: (err as Error).message }));
        }
      }
      const quality = blendQuality(metrics, judge);
      await Promise.all([
        scoreTrace(ctx.traceId, "quality_overall", quality),
        scoreTrace(ctx.traceId, "lint_pass", metrics.lintPass),
        scoreTrace(ctx.traceId, "difficulty_spread", metrics.difficultySpread),
        ...(judge
          ? [
              scoreTrace(ctx.traceId, "judge_overall", judge.overall, judge.scores.reasoning),
              scoreTrace(ctx.traceId, "judge_faithfulness", (judge.scores.faithfulness - 1) / 4),
              scoreTrace(ctx.traceId, "judge_distractors", (judge.scores.distractors - 1) / 4),
            ]
          : []),
        scoreTrace(ctx.traceId, "critique_rounds", run.rounds),
      ]);
      return {
        questions: run.questions,
        strategy: run.strategy,
        routeReason: run.routeReason,
        rounds: run.rounds,
        repairs: run.repairs,
        usage: addUsage(run.usage, judge?.usage),
        budget: budget.snapshot(),
        trail: run.trail,
        resumed: run.resumed,
        metrics,
        ...(judge ? { judge } : {}),
        quality,
        promptVersion: PROMPT_VERSION,
        ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
        model: p.llm.model,
      };
    },
  );
}

const addUsage = (a: Usage, b?: Usage): Usage =>
  b
    ? { promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens, cachedTokens: a.cachedTokens + b.cachedTokens }
    : a;
