import { resolveDatabaseUrl } from "@quizforge/db";
import { z } from "zod";

const Schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
    DATABASE_URL: z.string().optional(),
    DB_HOST: z.string().optional(),
    DB_USER: z.string().optional(),
    DB_PASSWORD: z.string().optional(),
    DB_NAME: z.string().optional(),

    SQS_QUEUE_URL: z.string().min(1),
    /** Must match the queue's redrive policy (maxReceiveCount). On the last receive a failure marks the quiz failed. */
    SQS_MAX_RECEIVE: z.coerce.number().int().min(1).default(3),
    /** Longer than a job can run; the heartbeat keeps extending it while a job is in flight. */
    SQS_VISIBILITY_TIMEOUT: z.coerce.number().int().min(30).default(360),

    LLM_MODE: z.enum(["minimax", "fake"]).default("minimax"),
    MINIMAX_API_KEY: z.string().optional(),
    MINIMAX_BASE_URL: z.string().url().default("https://api.minimax.io/v1"),
    MINIMAX_MODEL: z.string().default("MiniMax-M2.7"),
    /** Judge model. Set it to a different model than MINIMAX_MODEL to avoid self-preference bias (empty = same model). */
    MINIMAX_JUDGE_MODEL: z.string().optional(),
    /** Judge runs per quiz, median taken. Keep equal to the CI evaluation (3) so production and CI scores mean the same. */
    JUDGE_SAMPLES: z.coerce.number().int().min(1).max(5).default(3),
    /** USD per 1M tokens, for the cost metric. */
    LLM_PRICE_IN_PER_M: z.coerce.number().min(0).default(0.3),
    LLM_PRICE_OUT_PER_M: z.coerce.number().min(0).default(1.2),

    SOURCE_ALLOWED_HOSTS: z.string().default("github.com,raw.githubusercontent.com"),
    /** Jobs processed at once by this task (the fleet cap is this x max tasks). */
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
    HEALTH_PORT: z.coerce.number().int().default(8081),
    SHUTDOWN_GRACE_MS: z.coerce.number().int().default(100_000),
  })
  .superRefine((c, ctx) => {
    if (c.LLM_MODE === "minimax" && !c.MINIMAX_API_KEY) ctx.addIssue({ code: "custom", message: "MINIMAX_API_KEY is required for LLM_MODE=minimax" });
    if (c.LLM_MODE === "fake" && c.NODE_ENV === "production") ctx.addIssue({ code: "custom", message: "LLM_MODE=fake is not allowed in production" });
  });

export type Config = z.output<typeof Schema> & { allowedHosts: string[]; databaseUrl: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`);
  }
  return { ...parsed.data, databaseUrl: resolveDatabaseUrl(env), allowedHosts: parsed.data.SOURCE_ALLOWED_HOSTS.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean) };
}
