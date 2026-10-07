import { createDb } from "@quizforge/db";
import { buildApp } from "./app.js";
import { createVerifier } from "./auth.js";
import { loadConfig } from "./config.js";
import { MemoryQuizQueue, SqsQuizQueue } from "./queue.js";

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL, { max: 10 });
const queue = config.QUEUE_MODE === "sqs" ? new SqsQuizQueue(config.SQS_QUEUE_URL!) : new MemoryQuizQueue();

const app = await buildApp({ config, db, queue, verifier: createVerifier(config) });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  try {
    await app.close(); // stops accepting, lets in-flight requests finish
    await pool.end();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "error during shutdown");
    process.exit(1);
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: "0.0.0.0", port: config.PORT });
