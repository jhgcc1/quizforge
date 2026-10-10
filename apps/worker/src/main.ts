import { createServer } from "node:http";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { ScoreJobMessageSchema, QuizJobMessageSchema, type ScoreJobMessage } from "@quizforge/core";
import { createDb } from "@quizforge/db";
import { createFakeLlm, createMiniMaxClient, flushTracing, initTracing, parseAllowedLanguages, type LlmClient } from "@quizforge/llm";
import { loadConfig } from "./config.js";
import { Consumer, SqsTransport } from "./consumer.js";
import { createLogger } from "./log.js";
import { processQuizJob } from "./processor.js";
import { processScoreJob } from "./scorer.js";

/**
 * One image, two roles (WORKER_ROLE):
 *   generate  consumes the generation queue: builds the quiz, saves it as `ready`, then queues a scoring job
 *   score     consumes the scoring queue: judges a saved quiz and stores the scores (no checkpoints, no document fetching)
 * They never call each other: they only share Postgres and the two queues.
 */
const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
initTracing();

const { db, pool } = createDb(config.databaseUrl, { max: config.WORKER_CONCURRENCY + 2 });
const sqs = new SQSClient({});
const pricing = { inPerM: config.LLM_PRICE_IN_PER_M, outPerM: config.LLM_PRICE_OUT_PER_M };
const mk = (model: string): LlmClient => createMiniMaxClient({ apiKey: config.MINIMAX_API_KEY!, baseUrl: config.MINIMAX_BASE_URL, model });
const transport = new SqsTransport(sqs, config.SQS_QUEUE_URL);
const common = { concurrency: config.WORKER_CONCURRENCY, visibilityTimeout: config.SQS_VISIBILITY_TIMEOUT, log };

let checkpointer: PostgresSaver | undefined;
let modelName: string;
let consumer: { lastActivity: number; start(): void; stop(graceMs: number): Promise<void> };

if (config.WORKER_ROLE === "score") {
  const judgeLlm = config.LLM_MODE === "fake" ? createFakeLlm() : mk(config.MINIMAX_JUDGE_MODEL || config.MINIMAX_MODEL);
  modelName = judgeLlm.model;
  consumer = new Consumer<ScoreJobMessage>({
    ...common,
    transport,
    parse: (raw) => ScoreJobMessageSchema.parse(raw),
    handler: (msg, receive) => processScoreJob({ db, judgeLlm, judgeSamples: config.JUDGE_SAMPLES, pricing, log }, msg, { count: receive.count, max: config.SQS_MAX_RECEIVE }),
  });
} else {
  checkpointer = PostgresSaver.fromConnString(config.databaseUrl, { schema: "langgraph" });
  await checkpointer.setup();
  const llm = config.LLM_MODE === "fake" ? createFakeLlm() : mk(config.MINIMAX_MODEL);
  modelName = llm.model;
  const publishScore = config.SCORING_QUEUE_URL
    ? async (msg: ScoreJobMessage) => {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: config.SCORING_QUEUE_URL!,
            MessageBody: JSON.stringify(msg),
            ...(msg.requestId ? { MessageAttributes: { requestId: { DataType: "String", StringValue: msg.requestId } } } : {}),
          }),
        );
      }
    : undefined;
  if (!publishScore) log.warn({}, "SCORING_QUEUE_URL is not set: quizzes will be generated but not scored");
  consumer = new Consumer({
    ...common,
    transport,
    parse: (raw) => QuizJobMessageSchema.parse(raw),
    handler: (msg, receive) => processQuizJob({ db, llm, publishScore, checkpointer, log, allowedHosts: config.allowedHosts, allowedLanguages: parseAllowedLanguages(config.ALLOWED_LANGUAGES), pricing }, msg, { count: receive.count, max: config.SQS_MAX_RECEIVE }),
  });
}

/** Liveness for the ECS health check: healthy while the poll loop keeps turning (long poll = 20s). */
const health = createServer((req, res) => {
  const alive = Date.now() - consumer.lastActivity < 120_000;
  res.writeHead(req.url === "/healthz" && alive ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: alive ? "ok" : "stalled", role: config.WORKER_ROLE }));
});
health.listen(config.HEALTH_PORT, "0.0.0.0");

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "draining in-flight jobs");
  await consumer.stop(config.SHUTDOWN_GRACE_MS);
  health.close();
  await flushTracing();
  await checkpointer?.end();
  await pool.end();
  log.info({}, `${config.WORKER_ROLE} stopped`);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

log.info({ role: config.WORKER_ROLE, model: modelName, concurrency: config.WORKER_CONCURRENCY, mode: config.LLM_MODE }, `${config.WORKER_ROLE} started`);
consumer.start();
