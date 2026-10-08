import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { createDb, failQuiz, findStaleQuizzes, resolveDatabaseUrl, type Db } from "@quizforge/db";
import { createLogger, emitMetrics, type Logger } from "./log.js";

/**
 * Safety net for the two ways a quiz can get stuck, run on a schedule (EventBridge -> ECS task):
 *  - `queued` for a while: the API wrote the row but the SQS publish was lost -> publish again
 *    (safe: the worker is idempotent per quiz).
 *  - `generating` for far longer than any job can run: the worker died without finishing -> mark failed,
 *    so the user sees an error instead of a spinner.
 */
export interface SweepDeps {
  db: Db;
  publish: (quizId: string) => Promise<void>;
  log: Logger;
  now?: () => number;
  requeueAfterMs?: number;
  failAfterMs?: number;
}

export async function sweepOnce(d: SweepDeps): Promise<{ requeued: number; failed: number }> {
  const now = d.now?.() ?? Date.now();
  const requeueAfter = d.requeueAfterMs ?? 3 * 60_000;
  const failAfter = d.failAfterMs ?? 20 * 60_000;
  let requeued = 0;
  let failed = 0;

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
  return { requeued, failed };
}

/** Entry point for the scheduled ECS task: one sweep, then exit. */
export async function main(): Promise<void> {
  const log = createLogger((process.env.LOG_LEVEL as "info") ?? "info");
  const queueUrl = process.env.SQS_QUEUE_URL;
  if (!queueUrl) throw new Error("SQS_QUEUE_URL is required");
  const { db, pool } = createDb(resolveDatabaseUrl(), { max: 2 });
  const sqs = new SQSClient({});
  try {
    const res = await sweepOnce({
      db,
      log,
      publish: async (quizId) => void (await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ v: 1, quizId, requestId: "sweeper" }) }))),
    });
    log.info(res, "sweep finished");
    emitMetrics({ SweeperRequeued: { value: res.requeued, unit: "Count" }, SweeperFailed: { value: res.failed, unit: "Count" } });
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
