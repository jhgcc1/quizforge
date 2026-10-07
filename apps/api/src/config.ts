import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const Schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().default(8080),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    DATABASE_URL: z.string().min(1),

    /** `cognito` verifies real Cognito access tokens. `local` accepts HS256 tokens and is refused in production. */
    AUTH_MODE: z.enum(["cognito", "local"]).default("cognito"),
    COGNITO_USER_POOL_ID: z.string().optional(),
    COGNITO_CLIENT_IDS: z.string().optional(),
    LOCAL_JWT_SECRET: z.string().min(16).optional(),

    QUEUE_MODE: z.enum(["sqs", "memory"]).default("sqs"),
    SQS_QUEUE_URL: z.string().optional(),

    DEFAULT_SOURCE_URL: z.string().url().default("https://github.com/pipecat-ai/pipecat/blob/main/README.md"),
    SOURCE_ALLOWED_HOSTS: z.string().default("github.com,raw.githubusercontent.com"),
    DAILY_QUIZ_QUOTA: z.coerce.number().int().min(1).default(10),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
    CREATE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
    TRUST_PROXY: bool.default("true"),
  })
  .superRefine((c, ctx) => {
    if (c.AUTH_MODE === "local" && c.NODE_ENV === "production") {
      ctx.addIssue({ code: "custom", message: "AUTH_MODE=local is not allowed in production" });
    }
    if (c.AUTH_MODE === "local" && !c.LOCAL_JWT_SECRET) ctx.addIssue({ code: "custom", message: "LOCAL_JWT_SECRET is required for AUTH_MODE=local" });
    if (c.AUTH_MODE === "cognito" && (!c.COGNITO_USER_POOL_ID || !c.COGNITO_CLIENT_IDS)) {
      ctx.addIssue({ code: "custom", message: "COGNITO_USER_POOL_ID and COGNITO_CLIENT_IDS are required for AUTH_MODE=cognito" });
    }
    if (c.QUEUE_MODE === "sqs" && !c.SQS_QUEUE_URL) ctx.addIssue({ code: "custom", message: "SQS_QUEUE_URL is required for QUEUE_MODE=sqs" });
    if (c.QUEUE_MODE === "memory" && c.NODE_ENV === "production") ctx.addIssue({ code: "custom", message: "QUEUE_MODE=memory is not allowed in production" });
  });

export type Config = z.output<typeof Schema> & { allowedHosts: string[]; clientIds: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`);
  }
  const c = parsed.data;
  return {
    ...c,
    allowedHosts: c.SOURCE_ALLOWED_HOSTS.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    clientIds: (c.COGNITO_CLIENT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}
