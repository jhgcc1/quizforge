import { createServer } from "node:http";
import { SQSClient } from "@aws-sdk/client-sqs";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createDb } from "@quizforge/db";
import { createFakeLlm, createMiniMaxClient, flushTracing, initTracing } from "@quizforge/llm";
import { loadConfig } from "./config.js";
import { Consumer, SqsTransport } from "./consumer.js";
import { createLogger } from "./log.js";
import { processQuizJob } from "./processor.js";

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
initTracing();

const { db, pool } = createDb(config.databaseUrl, { max: config.WORKER_CONCURRENCY + 2 });
const checkpointer = PostgresSaver.fromConnString(config.databaseUrl, { schema: "langgraph" });
await checkpointer.setup();

const llm =
  config.LLM_MODE === "fake"
    ? createFakeLlm()
    : createMiniMaxClient({ apiKey: config.MINIMAX_API_KEY!, baseUrl: config.MINIMAX_BASE_URL, model: config.MINIMAX_MODEL });

const consumer = new Consumer({
  transport: new SqsTransport(new SQSClient({}), config.SQS_QUEUE_URL),
  concurrency: config.WORKER_CONCURRENCY,
  visibilityTimeout: config.SQS_VISIBILITY_TIMEOUT,
  log,
  handler: (msg, receive) =>
    processQuizJob(
      { db, llm, checkpointer, log, allowedHosts: config.allowedHosts, pricing: { inPerM: config.LLM_PRICE_IN_PER_M, outPerM: config.LLM_PRICE_OUT_PER_M } },
      { v: 1, ...msg },
      { count: receive.count, max: config.SQS_MAX_RECEIVE },
    ),
});

/** Liveness for the ECS health check: healthy while the poll loop keeps turning (long poll = 20s). */
const health = createServer((req, res) => {
  const alive = Date.now() - consumer.lastActivity < 120_000;
  res.writeHead(req.url === "/healthz" && alive ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: alive ? "ok" : "stalled" }));
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
  await checkpointer.end();
  await pool.end();
  log.info({}, "worker stopped");
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

log.info({ model: llm.model, concurrency: config.WORKER_CONCURRENCY, mode: config.LLM_MODE }, "worker started");
consumer.start();
