import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const sources = readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

describe("@quizforge/contract stays small and browser-safe", () => {
  it("has source files to check", () => expect(sources.length).toBeGreaterThan(0));

  it("imports nothing but zod and its own files (no node built-ins, no core, no guard)", () => {
    for (const f of sources) {
      const code = readFileSync(new URL(f, import.meta.url), "utf8");
      const specs = [...code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const spec of specs) {
        expect(spec === "zod" || spec.startsWith("./"), `${f} imports "${spec}"`).toBe(true);
        expect(spec, f).not.toMatch(/^node:|guard|injection-rules|attacks|@quizforge\/core/);
      }
      expect(code, f).not.toMatch(/\bprocess\.|require\(/);
    }
  });

  it("depends on zod only", () => {
    const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).toEqual(["zod"]);
  });
});
