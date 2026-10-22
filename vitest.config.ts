import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "api/src/**/*.test.ts", "worker/src/**/*.test.ts", "guardrails/*/src/**/*.test.ts", "guardrails/promptfoo/**/*.test.{ts,mjs}", "packages/db/policy/*.test.ts", "evals/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.int.test.ts"],
    environment: "node",
  },
});
