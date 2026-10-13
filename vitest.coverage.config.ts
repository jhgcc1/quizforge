import { defineConfig } from "vitest/config";

// Combined run: unit + integration tests together (integration needs Postgres, see vitest.integration.config.ts).
export default defineConfig({
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
      exclude: ["**/*.test.ts", "**/*.d.ts"],
      thresholds: {},
    },
  },
});
