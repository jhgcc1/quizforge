import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SAMPLE_CATALOG } from "./catalog.js";
import { CatalogEntrySchema, CatalogResponseSchema, CreateQuizBodySchema } from "./schemas.js";

const fixtures = fileURLToPath(new URL("../../../evals/fixtures/", import.meta.url));
const ALLOWED = ["github.com", "raw.githubusercontent.com"]; // the API default (apps/api config)

describe("sample catalog (the Document dropdown)", () => {
  it("is valid, has unique ids and offers both real READMEs and test documents", () => {
    expect(CatalogResponseSchema.safeParse({ items: SAMPLE_CATALOG }).success).toBe(true);
    expect(new Set(SAMPLE_CATALOG.map((e) => e.id)).size).toBe(SAMPLE_CATALOG.length);
    expect(SAMPLE_CATALOG.filter((e) => e.kind === "readme").length).toBeGreaterThanOrEqual(5);
    expect(SAMPLE_CATALOG.filter((e) => e.kind === "test").length).toBeGreaterThanOrEqual(5);
    expect(new Set(SAMPLE_CATALOG.map((e) => e.language))).toEqual(new Set(["en", "pt", "es"]));
  });

  it("every URL is https, on the allow-list, and is accepted by the create-quiz schema", () => {
    for (const e of SAMPLE_CATALOG) {
      const u = new URL(e.url);
      expect(u.protocol).toBe("https:");
      expect(ALLOWED).toContain(u.hostname);
      expect(CreateQuizBodySchema.safeParse({ sourceUrl: e.url }).success).toBe(true);
      expect(CatalogEntrySchema.safeParse(e).success).toBe(true);
    }
  });

  it("every test document is served from a file that exists in the repository", () => {
    for (const e of SAMPLE_CATALOG.filter((x) => x.kind === "test")) {
      const file = e.url.split("/evals/fixtures/")[1]!;
      expect(existsSync(`${fixtures}${file}`), file).toBe(true);
    }
  });
});
