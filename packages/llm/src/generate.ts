import type { GeneratedQuestion } from "@quizforge/core";
import { JobBudget, type BudgetState, type Usage } from "./budget.js";
import type { JudgeResult } from "./judge.js";
import { quizMetrics, type QuizMetrics } from "./lint.js";
import { QUALITY_VERSION, scoreQuiz } from "./quality.js";
import { judgeNote, judgeWithRetry } from "./scoring.js";
import { guardLlm, parseQuizInput } from "./llm-input.js";
import type { LlmClient } from "./llm.js";
import { scoreTrace, traced } from "./observability.js";
import { PROMPT_VERSION } from "./prompts.js";
import { runQuizGraph, type QuizGraphInput } from "./quiz-graph.js";
import type { Strategy } from "./router.js";
import type { BaseCheckpointSaver } from "@langchain/langgraph";

export interface GenerateQuizParams {
  llm: LlmClient;
  input: QuizGraphInput;
  /**
   * Model used as the LLM judge. Using a DIFFERENT model from the generator avoids self-preference bias (a model
   * tends to rate its own style highly). Defaults to `llm` when not given.
   */
  judgeLlm?: LlmClient;
  /** Judge runs per quiz (median of N, run in parallel). Production and the CI evaluation use the same value, so their scores are comparable. */
  judgeSamples?: number;
  /** Resume a previous allowance after an SQS redelivery. */
  budgetState?: BudgetState;
  judge?: boolean;
  /**
   * Compute and send the quality scores (default true). The production worker passes false: it only generates and saves the quiz;
   * the scorer service computes every score afterwards with the same method (see scoring.ts). Implies no judge.
   */
  score?: boolean;
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
  /** True when the judge failed twice: the quiz is still delivered, but it has no `quality` (never a different formula). */
  judgeFailed: boolean;
  /** Every metric of the shared quality method (same names in Langfuse, Postgres and CloudWatch). */
  scores: Record<string, number>;
  /** `quality_overall`, 0..1 (see quality.ts). Drives the alarms. Undefined when the judge failed. */
  quality: number | undefined;
  qualityVersion: string;
  promptVersion: string;
  traceId?: string;
  model: string;
  judgeModel: string;
}

export async function generateQuiz(params: GenerateQuizParams): Promise<GeneratedQuizResult> {
  // The two doors to the model (see llm-input.ts): a validated, sanitized input, and clients that re-validate every call.
  const p: GenerateQuizParams = { ...params, llm: guardLlm(params.llm), ...(params.judgeLlm ? { judgeLlm: guardLlm(params.judgeLlm) } : {}), input: parseQuizInput(params.input) };
  return traced(
    "quiz-generation",
    {
      ...(p.trace?.sessionId ? { sessionId: p.trace.sessionId } : {}),
      ...(p.trace?.userId ? { userId: p.trace.userId } : {}),
      tags: ["quizforge", ...(p.trace?.tags ?? [])],
      metadata: { requestId: p.trace?.requestId, promptVersion: PROMPT_VERSION, qualityVersion: QUALITY_VERSION, model: p.llm.model, ...(p.judge !== false && p.score !== false ? { judgeModel: (p.judgeLlm ?? p.llm).model } : {}), structure: p.input.planFirst ? "plan-then-write" : p.input.critique ? "critique-loop" : "one-shot", promptVariant: p.input.promptVariant ?? "baseline" },
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
      let judgeFailed = false;
      const scoring = p.score !== false;
      if (scoring && p.judge !== false) {
        const r = await judgeWithRetry({ llm: p.judgeLlm ?? p.llm, samples: p.judgeSamples, budget, sourceText: p.input.sourceText, questions: run.questions });
        judge = r.judge;
        judgeFailed = r.failed;
      }
      const q = scoring ? await scoreQuiz({ questions: run.questions, sourceText: p.input.sourceText, judge }) : { scores: {} as Record<string, number>, quality: undefined };
      const note = judge ? judgeNote((p.judgeLlm ?? p.llm).model, judge) : undefined;
      await Promise.all([
        ...Object.entries(q.scores).map(([name, value]) => scoreTrace(ctx.traceId, name, value, name === "judge_overall" ? `${note} | ${judge?.scores.reasoning ?? ""}`.slice(0, 1500) : undefined)),
        ...(q.quality !== undefined ? [scoreTrace(ctx.traceId, "quality_overall", q.quality, note)] : []),
        ...(judgeFailed ? [scoreTrace(ctx.traceId, "judge_failed", 1)] : []),
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
        judgeFailed,
        scores: q.scores,
        quality: q.quality,
        qualityVersion: QUALITY_VERSION,
        promptVersion: PROMPT_VERSION,
        ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
        model: p.llm.model,
        judgeModel: (p.judgeLlm ?? p.llm).model,
      };
    },
  );
}

const addUsage = (a: Usage, b?: Usage): Usage =>
  b
    ? { promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens, cachedTokens: a.cachedTokens + b.cachedTokens }
    : a;
