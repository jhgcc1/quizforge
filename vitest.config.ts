import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "scripts/**/*.test.ts", "evals/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.int.test.ts"],
    environment: "node",
  },
});
