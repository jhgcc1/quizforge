/**
 * The part of a long-running worker role that is the SAME whatever the role is: the database pool, the SQS
 * client, the queue transport, the health endpoint ECS polls, and an orderly shutdown on SIGTERM.
 *
 * Why it is its own module: `generate` and `score` are two ECS services built from one image, and before this
 * existed the difference between them was an `if` in the middle of the startup code. A role now describes only
 * what is ITS own (which schema it parses, which handler it calls, what it has to close) and `runService` owns
 * everything else, so neither role can forget to drain in-flight jobs or to close the pool.
 */
import { createServer, type Server } from "node:http";
import { SQSClient } from "@aws-sdk/client-sqs";
import { createDb, type Db } from "@quizforge/db";
import { createFakeLlm, createMiniMaxClient, flushTracing, initTracing, type LlmClient } from "@quizforge/llm";
import type { Config } from "./config.js";
import { SqsTransport } from "./consumer.js";
import { createLogger, type Logger } from "./log.js";

/** The poll loop a role hands back to `runService`; `Consumer` satisfies it, and a test can pass a fake. */
export interface RoleConsumer {
  /** Last time the loop made progress. The health endpoint reads it to spot a wedged task. */
  readonly lastActivity: number;
  start(): void;
  stop(graceMs: number): Promise<void>;
}

/** Everything a role needs to build its consumer, already wired and shared with the other roles. */
export interface ServiceContext {
  config: Config;
  log: Logger;
  db: Db;
  sqs: SQSClient;
  /** Reads the queue named by `SQS_QUEUE_URL` — that is, the queue of THIS role. */
  transport: SqsTransport;
  /** `concurrency`, `visibilityTimeout` and `log`: the consumer options every role passes unchanged. */
  consumerDefaults: { concurrency: number; visibilityTimeout: number; log: Logger };
  /** USD per 1M tokens, for the cost metric. */
  pricing: { inPerM: number; outPerM: number };
  /** A model client, or the fake one when `LLM_MODE=fake` (local and tests only; refused in production). */
  llm(model: string): LlmClient;
}

/** What a role gives back: its loop, what to call it in the logs, and anything of its own to close. */
export interface RoleService {
  consumer: RoleConsumer;
  /** Named in the "started" log line, so a trace can be tied to the model that produced it. */
  modelName: string;
  /** Release what the role opened beyond the shared pool (the generate role's LangGraph checkpointer). */
  close?(): Promise<void>;
}

/** Builds the role-specific half of the service. Async because a role may have to set up state first. */
export type BuildRole = (ctx: ServiceContext) => Promise<RoleService>;

/**
 * Starts a role and keeps it running until SIGTERM/SIGINT. Resolves only when the process is about to exit.
 *
 * Shutdown order matters and is the reason this is shared: stop accepting and let in-flight jobs finish
 * (`SHUTDOWN_GRACE_MS`, which ECS `stopTimeout` must exceed), close the health server, flush the traces that
 * are still buffered, then close the role's own resources, then the pool. A job killed between "quiz written"
 * and "message deleted" is replayed by SQS, which is safe; a trace lost is lost for good.
 */
export async function runService(config: Config, build: BuildRole): Promise<void> {
  const log = createLogger(config.LOG_LEVEL);
  initTracing();

  // +2 over the job concurrency: the health check and the shutdown path must never wait for a free client.
  const { db, pool } = createDb(config.databaseUrl, {
    max: config.WORKER_CONCURRENCY + 2,
    onPoolError: (err) => log.error({ err }, "idle database client failed; the pool will open a new one"),
  });
  const sqs = new SQSClient({});

  const role = await build({
    config,
    log,
    db,
    sqs,
    transport: new SqsTransport(sqs, config.SQS_QUEUE_URL),
    consumerDefaults: { concurrency: config.WORKER_CONCURRENCY, visibilityTimeout: config.SQS_VISIBILITY_TIMEOUT, log },
    pricing: { inPerM: config.LLM_PRICE_IN_PER_M, outPerM: config.LLM_PRICE_OUT_PER_M },
    llm: (model) =>
      config.LLM_MODE === "fake"
        ? createFakeLlm()
        : createMiniMaxClient({ apiKey: config.MINIMAX_API_KEY!, baseUrl: config.MINIMAX_BASE_URL, model }),
  });

  const health = healthServer(config, role.consumer);
  health.listen(config.HEALTH_PORT, "0.0.0.0");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "draining in-flight jobs");
    await role.consumer.stop(config.SHUTDOWN_GRACE_MS);
    health.close();
    await flushTracing();
    await role.close?.();
    await pool.end();
    log.info({}, `${config.WORKER_ROLE} stopped`);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  log.info(
    { role: config.WORKER_ROLE, model: role.modelName, concurrency: config.WORKER_CONCURRENCY, mode: config.LLM_MODE },
    `${config.WORKER_ROLE} started`,
  );
  role.consumer.start();
}

/**
 * Liveness for the ECS health check. "Alive" is not "the process exists": it is "the poll loop turned in the
 * last two minutes". A long poll takes 20 s, so a task that has gone quiet for 120 s is wedged and ECS should
 * replace it rather than leave it holding messages it will never process.
 */
function healthServer(config: Config, consumer: RoleConsumer): Server {
  return createServer((req, res) => {
    const alive = Date.now() - consumer.lastActivity < 120_000;
    res.writeHead(req.url === "/healthz" && alive ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: alive ? "ok" : "stalled", role: config.WORKER_ROLE }));
  });
}
