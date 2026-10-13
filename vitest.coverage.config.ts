import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Combined run: unit + integration tests together (integration needs Postgres, see vitest.integration.config.ts).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./apps/web", import.meta.url)) } }, // Next.js "@/..." imports in apps/web
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/web/lib/**/*.test.ts",
      "apps/web/app/**/*.test.ts",
      "scripts/**/*.test.ts",
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
        "apps/api/src/**/*.ts",
        "apps/worker/src/**/*.ts",
        "evals/src/**/*.ts",
        "apps/web/lib/**/*.ts",
        "apps/web/app/**/route.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.d.ts",
        "**/node_modules/**",
        // Process entry points: they only wire dependencies and start a long-running process.
        "apps/api/src/server.ts",
        "apps/worker/src/main.ts",
        "packages/db/src/migrate.ts", // CLI entry; its behaviour is covered end to end by migrate.int.test.ts in a child process (not visible to V8 coverage)
        // Scripts that run at import time and need a real model download, the network or real LLM calls.
        "packages/detector/src/try.ts",
        "packages/detector/src/corpus.ts",
        "packages/detector/src/benchmark.ts",
        "packages/llm/src/scripts/**",
        "evals/src/run.ts",
        "evals/src/compare.ts",
        "evals/src/render-report.ts",
        // Barrels (re-exports only).
        "packages/core/src/index.ts",
        "packages/llm/src/index.ts",
      ],
      // Ratchet: a little below what is achieved today, so any drop fails the run. Raise when coverage rises.
      thresholds: {
        statements: 98, lines: 98, functions: 97, branches: 94,
        "packages/core/src/**": { statements: 100, lines: 100, functions: 100, branches: 90 },
        "packages/db/src/**": { statements: 100, lines: 100, functions: 85, branches: 94 },
        "packages/llm/src/**": { statements: 100, lines: 100, functions: 100, branches: 94 },
        "packages/detector/src/**": { statements: 100, lines: 100, functions: 100, branches: 99 },
        "apps/api/src/**": { statements: 100, lines: 100, functions: 95, branches: 97 },
        "apps/worker/src/**": { statements: 98, lines: 98, functions: 100, branches: 94 },
        "evals/src/**": { statements: 97, lines: 97, functions: 97, branches: 91 },
        "apps/web/lib/**": { statements: 99, lines: 99, functions: 100, branches: 98 },
        "apps/web/app/**": { statements: 55, lines: 55, functions: 70, branches: 75 },
      },
    },
  },
});
