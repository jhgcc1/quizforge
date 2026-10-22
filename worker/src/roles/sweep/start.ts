/**
 * Entrypoint of the SWEEP role: one pass over the stuck work, then exit. Unlike `generate` and `score` this is
 * not a service — EventBridge starts it as an ECS task every few minutes and it is expected to finish.
 *
 * It is wiring only: open a pool, build the two SQS publishers, call `sweepOnce`, report, close the pool.
 * `sweepOnce` itself takes its database and its publishers as arguments and is tested without AWS.
 *
 * Why the wiring lives apart from `sweep.ts`: the file that RUNS on import cannot be the file a test imports.
 * Before this split the two were one module and the difference was `if (process.argv[1]?.endsWith("sweeper.ts"))`,
 * which decided whether the scheduled task did anything at all by inspecting the name of the file on disk — so
 * renaming, moving or bundling it would have left the schedule firing a task that silently swept nothing.
 */
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { ScoreJobMessage } from "@quizforge/core";
import { createDb, resolveDatabaseUrl } from "@quizforge/db";
import { createLogger, emitMetrics } from "../../shared/log.js";
import { sweepOnce } from "./sweep.js";

/**
 * Runs one sweep. Throws when the queue is not configured or the sweep fails, so the task exits non-zero and
 * the schedule's failure alarm fires; the pool is closed either way.
 *
 * It reads `process.env` directly rather than `loadConfig()` because the scheduled task is given only the few
 * variables it needs: demanding the full worker schema (a model key, a visibility timeout, a detector mode)
 * would make the sweep refuse to start over settings it never uses.
 */
export async function runSweep(): Promise<void> {
  const log = createLogger((process.env.LOG_LEVEL as "info") ?? "info");
  const queueUrl = process.env.SQS_QUEUE_URL;
  if (!queueUrl) throw new Error("SQS_QUEUE_URL is required");
  // A small pool: this task makes a handful of queries and exits. The error handler is not optional — pg emits
  // `error` on an idle client that dies, and with no listener that is an uncaught exception that ends the task.
  const { db, pool } = createDb(resolveDatabaseUrl(), {
    max: 2,
    onPoolError: (err) => log.error({ err }, "idle database client failed; the pool will open a new one"),
  });
  const sqs = new SQSClient({});
  try {
    const scoringUrl = process.env.SCORING_QUEUE_URL;
    const res = await sweepOnce({
      db,
      log,
      ...(scoringUrl
        ? {
            publishScore: async (msg: ScoreJobMessage) =>
              void (await sqs.send(new SendMessageCommand({ QueueUrl: scoringUrl, MessageBody: JSON.stringify(msg) }))),
          }
        : {}),
      // `requestId: "sweeper"` marks the replay in the logs and traces, so a quiz re-queued by the safety net is
      // never mistaken for one the user asked for twice.
      publish: async (quizId) =>
        void (await sqs.send(
          new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ v: 1, quizId, requestId: "sweeper" }) }),
        )),
    });
    log.info(res, "sweep finished");
    emitMetrics({
      SweeperRequeued: { value: res.requeued, unit: "Count" },
      SweeperFailed: { value: res.failed, unit: "Count" },
      SweeperRescored: { value: res.rescored, unit: "Count" },
      CheckpointsDeleted: { value: res.checkpointsDeleted, unit: "Count" },
    });
  } finally {
    await pool.end();
  }
}
