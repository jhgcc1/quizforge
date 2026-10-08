import { defineConfig, devices } from "@playwright/test";

/** Full stack on non-default ports so it never collides with other things running locally. */
const DB = "postgres://quizforge:quizforge@localhost:5433/quizforge_e2e";
const SECRET = "e2e-local-secret-e2e-local-secret";
const API = "http://localhost:18080";
const WEB = "http://localhost:13000";
const sqs = { AWS_ENDPOINT_URL_SQS: "http://localhost:9324", AWS_REGION: "us-east-2", AWS_ACCESS_KEY_ID: "local", AWS_SECRET_ACCESS_KEY: "local", SQS_QUEUE_URL: "http://localhost:9324/000000000000/quizforge-jobs", SCORING_QUEUE_URL: "http://localhost:9324/000000000000/quizforge-scoring" };
const common = { NODE_ENV: "development", DATABASE_URL: DB, LOG_LEVEL: "warn", LANGFUSE_PUBLIC_KEY: "", LANGFUSE_SECRET_KEY: "" };

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "../playwright-report" }]],
  outputDir: "../test-results",
  use: { baseURL: WEB, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    { command: "pnpm --filter @quizforge/api start", url: `${API}/healthz`, reuseExistingServer: !process.env.CI, timeout: 60_000, env: { ...common, ...sqs, PORT: "18080", AUTH_MODE: "local", LOCAL_JWT_SECRET: SECRET, QUEUE_MODE: "sqs", DAILY_QUIZ_QUOTA: "1000", CREATE_RATE_LIMIT_PER_MINUTE: "1000" } },
    { command: "pnpm --filter @quizforge/worker start", url: "http://localhost:18081/healthz", reuseExistingServer: !process.env.CI, timeout: 60_000, env: { ...common, ...sqs, LLM_MODE: "fake", SQS_VISIBILITY_TIMEOUT: "60", HEALTH_PORT: "18081" } },
    { command: "pnpm --filter @quizforge/worker start", url: "http://localhost:18082/healthz", reuseExistingServer: !process.env.CI, timeout: 60_000, env: { ...common, ...sqs, WORKER_ROLE: "score", SQS_QUEUE_URL: "http://localhost:9324/000000000000/quizforge-scoring", LLM_MODE: "fake", SQS_VISIBILITY_TIMEOUT: "60", HEALTH_PORT: "18082" } },
    { command: "pnpm --filter @quizforge/web start", url: `${WEB}/`, reuseExistingServer: !process.env.CI, timeout: 90_000, env: { PORT: "13000", AUTH_MODE: "local", LOCAL_JWT_SECRET: SECRET, APP_URL: WEB, API_URL: API } },
  ],
});
