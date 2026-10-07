import { defineConfig, devices } from "@playwright/test";

/** Runs against a DEPLOYED stack (real CloudFront, Cognito Hosted UI, MiniMax). Usage:
 *    AWS_URL=https://dxxxx.cloudfront.net E2E_USER=… E2E_PASSWORD=… pnpm exec playwright test -c e2e/playwright.aws.config.ts */
export default defineConfig({
  testDir: ".",
  testMatch: "aws.spec.ts",
  timeout: 360_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [["list"]],
  outputDir: "../test-results-aws",
  use: { baseURL: process.env.AWS_URL, trace: "retain-on-failure", screenshot: "on", ignoreHTTPSErrors: false },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
