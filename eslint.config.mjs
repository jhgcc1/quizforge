import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "site/**", ".local/**", "docs/**", "**/*.mjs", "promptfoo/assertions.js", "evals/reports/**", "infra/**", "e2e/test-results/**", "**/drizzle/**", "**/migrations/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "no-control-regex": "off",
      "no-misleading-character-class": "off",
    },
  },
);
