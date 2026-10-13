import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./apps/web", import.meta.url)) } }, // Next.js "@/..." imports in apps/web
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/web/lib/**/*.test.ts", "apps/web/app/**/*.test.ts", "scripts/**/*.test.ts", "evals/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.int.test.ts"],
    environment: "node",
  },
});
