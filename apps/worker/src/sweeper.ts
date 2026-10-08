import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { createDb, failQuiz, findStaleQuizzes, findUnscoredJobs, resolveDatabaseUrl, type Db } from "@quizforge/db";
import type { ScoreJobMessage } from "@quizforge/core";
import { createLogger, emitMetrics, type Logger } from "./log.js";

/**
 * Safety net for the three ways a quiz can get stuck, run on a schedule (EventBridge -> ECS task):
 *  - `queued` for a while: the API wrote the row but the SQS publish was lost -> publish again
 *    (safe: the worker is idempotent per quiz).
 *  - `generating` for far longer than any job can run: the worker died without finishing -> mark failed,
 *    so the user sees an error instead of a spinner.
 *  - `ready` but never scored (the scoring message was lost, or the scorer died): send the scoring job again. Bounded by the
 *    job's scoring_attempts, so a quiz that cannot be judged is not re-queued forever.
 */
export interface SweepDeps {
  db: Db;
  publish: (quizId: string) => Promise<void>;
  /** Omit when there is no scoring queue. */
  publishScore?: ((msg: ScoreJobMessage) => Promise<void>) | undefined;
  log: Logger;
  now?: () => number;
  requeueAfterMs?: number;
  failAfterMs?: number;
  /** A finished quiz with no score after this long is queued for scoring again. */
  rescoreAfterMs?: number;
  maxScoringAttempts?: number;
}

export async function sweepOnce(d: SweepDeps): Promise<{ requeued: number; failed: number; rescored: number }> {
  const now = d.now?.() ?? Date.now();
  const requeueAfter = d.requeueAfterMs ?? 3 * 60_000;
  const failAfter = d.failAfterMs ?? 20 * 60_000;
  let requeued = 0;
  let failed = 0;
  let rescored = 0;

  for (const q of await findStaleQuizzes(d.db, new Date(now - requeueAfter))) {
    const ageMs = now - q.updatedAt.getTime();
    try {
      if (q.status === "queued") {
        await d.publish(q.id);
        requeued++;
        d.log.warn({ quizId: q.id, ageMs }, "re-queued a quiz that never reached the worker");
      } else if (q.status === "generating" && ageMs >= failAfter) {
        await failQuiz(d.db, { quizId: q.id, error: "Generation timed out; please create the quiz again." });
        failed++;
        d.log.error({ quizId: q.id, ageMs }, "marked a stuck quiz as failed");
      }
    } catch (err) {
      d.log.error({ err, quizId: q.id }, "sweep step failed");
    }
  }

  if (d.publishScore) {
    for (const j of await findUnscoredJobs(d.db, new Date(now - (d.rescoreAfterMs ?? 5 * 60_000)), d.maxScoringAttempts ?? 6)) {
      try {
        await d.publishScore({ v: 1, quizId: j.quizId, jobId: j.jobId, requestId: "sweeper" });
        rescored++;
        d.log.warn({ quizId: j.quizId, jobId: j.jobId }, "queued a finished quiz that was never scored");
      } catch (err) {
        d.log.error({ err, quizId: j.quizId }, "scoring re-queue failed");
      }
    }
  }
  return { requeued, failed, rescored };
}

/** Entry point for the scheduled ECS task: one sweep, then exit. */
export async function main(): Promise<void> {
  const log = createLogger((process.env.LOG_LEVEL as "info") ?? "info");
  const queueUrl = process.env.SQS_QUEUE_URL;
  if (!queueUrl) throw new Error("SQS_QUEUE_URL is required");
  const { db, pool } = createDb(resolveDatabaseUrl(), { max: 2 });
  const sqs = new SQSClient({});
  try {
    const scoringUrl = process.env.SCORING_QUEUE_URL;
    const res = await sweepOnce({
      db,
      log,
      ...(scoringUrl ? { publishScore: async (msg: ScoreJobMessage) => void (await sqs.send(new SendMessageCommand({ QueueUrl: scoringUrl, MessageBody: JSON.stringify(msg) }))) } : {}),
      publish: async (quizId) => void (await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ v: 1, quizId, requestId: "sweeper" }) }))),
    });
    log.info(res, "sweep finished");
    emitMetrics({ SweeperRequeued: { value: res.requeued, unit: "Count" }, SweeperFailed: { value: res.failed, unit: "Count" }, SweeperRescored: { value: res.rescored, unit: "Count" } });
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("sweeper.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
