import type { ScoreJobMessage } from "@quizforge/core";
import { claimScoring, getQuizForScoring, saveScores, type Db } from "@quizforge/db";
import { scoreExistingQuiz, type LlmClient } from "@quizforge/llm";
import { emitMetrics, type Logger } from "./log.js";
import type { Outcome } from "./processor.js";

export interface ScoreDeps {
  db: Db;
  /** The judge model's client. */
  judgeLlm: LlmClient;
  judgeSamples: number;
  pricing: { inPerM: number; outPerM: number };
  log: Logger;
  emit?: typeof emitMetrics;
}

/**
 * Scorer service: judge a quiz that is already saved as `ready`, off the path of the user's request.
 * Everything it needs is read from Postgres (the message carries ids only), so a duplicate or redelivered message is harmless:
 * an already scored job is skipped, and the stored scores are replaced, never doubled.
 *
 *   judge ok            -> store judge_* + quality_overall, mark the job scored          -> done
 *   judge failed, tries -> leave the message (SQS redelivers with backoff)               -> retry
 *   judge failed, last  -> store judge_failed = 1, mark scored (no endless re-queueing),
 *                          emit JudgeFailed (the judge-failing alarm)                    -> failed
 */
export async function processScoreJob(d: ScoreDeps, msg: ScoreJobMessage, receive: { count: number; max: number }): Promise<Outcome> {
  const log = d.log.child({ quizId: msg.quizId, jobId: msg.jobId, requestId: msg.requestId, receiveCount: receive.count });
  const emit = d.emit ?? emitMetrics;
  const started = Date.now();

  const data = await getQuizForScoring(d.db, msg.quizId, msg.jobId);
  if (!data) {
    log.info({}, "nothing to score (quiz missing, not ready, or not a finished job)");
    return { kind: "skipped", reason: "nothing to score" };
  }
  if (data.scored) {
    log.info({}, "already scored");
    return { kind: "skipped", reason: "already scored" };
  }
  if ((await claimScoring(d.db, msg.jobId)) === undefined) return { kind: "skipped", reason: "scored by another scorer" };

  const r = await scoreExistingQuiz({ llm: d.judgeLlm, judgeSamples: d.judgeSamples, questions: data.questions, sourceText: data.sourceText, traceId: data.traceId, quizId: msg.quizId });
  const costUsd = (r.usage.promptTokens * d.pricing.inPerM + r.usage.completionTokens * d.pricing.outPerM) / 1e6;
  const usage = { ...r.usage, costUsd };
  const ms = Date.now() - started;

  if (r.judgeFailed) {
    const last = receive.count >= receive.max;
    log.error({ last, ms }, "judge failed");
    emit({ JudgeFailed: { value: 1, unit: "Count" } });
    if (!last) return { kind: "retry", error: "judge failed" };
    await saveScores(d.db, { quizId: msg.quizId, jobId: msg.jobId, scores: [{ evaluator: "judge_failed", value: 1, meta: { qualityVersion: r.qualityVersion, judgeModel: r.judgeModel } }], usage });
    return { kind: "failed", error: "judge failed on every attempt" };
  }

  const scores = [
    ...Object.entries(r.scores)
      .filter(([name]) => name.startsWith("judge_"))
      .map(([evaluator, value]) => ({ evaluator, value, ...(evaluator === "judge_overall" && r.judge ? { reasoning: r.judge.scores.reasoning } : {}), meta: { qualityVersion: r.qualityVersion, judgeModel: r.judgeModel, samples: r.judge?.samples, spread: r.judge?.spread } })),
    ...(r.quality !== undefined ? [{ evaluator: "quality_overall", value: r.quality, meta: { qualityVersion: r.qualityVersion, judgeModel: r.judgeModel, samples: r.judge?.samples } }] : []),
  ];
  await saveScores(d.db, { quizId: msg.quizId, jobId: msg.jobId, scores, usage });

  log.info({ quality: r.quality, judgeOverall: r.scores.judge_overall, spread: r.judge?.spread, costUsd, ms, qualityVersion: r.qualityVersion }, "quiz scored");
  emit({
    ...(r.quality !== undefined ? { QuizQuality: { value: r.quality } } : {}),
    JudgeFailed: { value: 0, unit: "Count" },
    ScoringLatencyMs: { value: ms, unit: "Milliseconds" },
    QuizCostUsd: { value: costUsd }, // the judge's share: generation reports its own
  });
  return { kind: "done" };
}
