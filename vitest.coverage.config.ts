import { defineConfig } from "vitest/config";

// Combined run: unit + integration tests together (integration needs Postgres, see vitest.integration.config.ts).
export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "api/src/**/*.test.ts",
      "worker/src/**/*.test.ts",
      "guardrails/*/src/**/*.test.ts",
      "guardrails/promptfoo/**/*.test.{ts,mjs}",
      "packages/db/policy/*.test.ts",
      "evals/src/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      all: true,
      include: [
        "packages/*/src/**/*.ts",
        "api/src/**/*.ts",
        "worker/src/**/*.ts",
        "evals/src/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.d.ts",
        "**/node_modules/**",
        // Process entry points: they only wire dependencies and start a long-running process.
        "api/src/server.ts",
        "worker/src/main.ts", // picks the role and hands over
        "worker/src/sweeper.ts", // runs roles/sweep/start.ts, whose runSweep() IS covered (sweep.test.ts)
        // The same wiring, one file per role: what used to be the body of main.ts, which was already excluded here.
        // Only the wiring is exempt — every handler they build (processor, scorer, sweepOnce) is covered.
        "worker/src/shared/service.ts",
        "worker/src/roles/generate/start.ts",
        "worker/src/roles/score/start.ts",
        "packages/db/src/migrate.ts", // CLI entry; its behaviour is covered end to end by migrate.int.test.ts in a child process (not visible to V8 coverage)
        // Scripts that run at import time and need the network or real LLM calls.
        "evals/src/run.ts",
        "evals/src/compare.ts",
        "evals/src/render-report.ts",
        // Barrels (re-exports only).
        "packages/core/src/index.ts",
        "packages/llm/src/index.ts",
      ],
      // Ratchet: a little below what is achieved today, so any drop fails the run. Raise when coverage rises.
      thresholds: {
        statements: 97, lines: 97, functions: 97, branches: 94,
        "packages/contract/src/**": { statements: 100, lines: 100, functions: 100, branches: 100 },
        "packages/core/src/**": { statements: 100, lines: 100, functions: 100, branches: 90 },
        "packages/db/src/**": { statements: 100, lines: 100, functions: 85, branches: 94 },
        "packages/llm/src/**": { statements: 100, lines: 100, functions: 100, branches: 94 },
        "guardrails/detector/src/**": { statements: 100, lines: 100, functions: 100, branches: 99 },
        "api/src/**": { statements: 100, lines: 100, functions: 95, branches: 97 },
        "worker/src/**": { statements: 98, lines: 98, functions: 100, branches: 94 },
        "evals/src/**": { statements: 97, lines: 97, functions: 97, branches: 91 },
      },
    },
  },
});
