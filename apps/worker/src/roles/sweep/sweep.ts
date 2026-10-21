import { deleteOldCheckpointThreads, failQuiz, findStaleQuizzes, findUnscoredJobs, type Db } from "@quizforge/db";
import type { ScoreJobMessage } from "@quizforge/core";
import type { Logger } from "../../shared/log.js";

/**
 * Safety net for the three ways a quiz can get stuck, run on a schedule (EventBridge -> ECS task):
 *  - `queued` for a while: the API wrote the row but the SQS publish was lost -> publish again
 *    (safe: the worker is idempotent per quiz).
 *  - `generating` for far longer than any job can run: the worker died without finishing -> mark failed,
 *    so the user sees an error instead of a spinner.
 *  - `ready` but never scored (the scoring message was lost, or the scorer died): send the scoring job again. Bounded by the
 *    job's scoring_attempts, so a quiz that cannot be judged is not re-queued forever.
 * It also applies the retention of the LangGraph checkpoints: threads whose last checkpoint is older than `checkpointMaxAgeMs` are
 * deleted (the worker deletes its own thread when the quiz is saved; this catches the ones a dead worker or a failure left behind).
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
  /** Checkpoint threads older than this are deleted. Default 24 h. */
  checkpointMaxAgeMs?: number;
}

/**
 * One pass over the stuck work. Pure in the way that matters: it never opens a connection or an SQS client of
 * its own, it uses the `db` and the publishers it is given, so the whole safety net is tested without AWS.
 * Returns what it did, which `start.ts` turns into CloudWatch metrics (the alarm is on these counts rising).
 */
export async function sweepOnce(d: SweepDeps): Promise<{ requeued: number; failed: number; rescored: number; checkpointsDeleted: number }> {
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
  let checkpointsDeleted = 0;
  try {
    checkpointsDeleted = await deleteOldCheckpointThreads(d.db, new Date(now - (d.checkpointMaxAgeMs ?? 24 * 3_600_000)));
    if (checkpointsDeleted) d.log.info({ checkpointsDeleted }, "deleted expired checkpoint threads");
  } catch (err) {
    d.log.error({ err }, "checkpoint retention failed");
  }
  return { requeued, failed, rescored, checkpointsDeleted };
}
