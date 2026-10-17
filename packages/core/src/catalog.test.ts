import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SAMPLE_CATALOG, titleForDocument } from "./catalog.js";
import { CatalogEntrySchema, CatalogResponseSchema, CreateQuizBodySchema } from "@quizforge/contract";

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

describe("titleForDocument", () => {
  it("takes the first heading, stripping badges and links", () => {
    expect(titleForDocument("# [![build](a.svg)](b) Supabase\n\ntext", "u")).toBe("Supabase");
    expect(titleForDocument("# `ripgrep`\n", "u")).toBe("ripgrep");
    expect(titleForDocument("Some intro\n\n## Getting started\n", "u")).toBe("Getting started");
  });
  it("falls back to owner/repo, then to the url", () => {
    expect(titleForDocument("no heading here", "https://raw.githubusercontent.com/elastic/elasticsearch/main/README.md")).toBe("elastic/elasticsearch");
    expect(titleForDocument("no heading here", "https://example.com/x")).toBe("https://example.com/x");
  });
  it("ignores a heading that is empty once stripped, and caps the length", () => {
    expect(titleForDocument("# [](x)\n# Real Title\n", "u")).toBe("Real Title");
    expect(titleForDocument(`# ${"a".repeat(200)}\n`, "u")).toHaveLength(80);
  });
  it("only looks at the top of the document", () => {
    expect(titleForDocument(`${"filler\n".repeat(60)}# Late Heading\n`, "https://github.com/o/r/blob/main/R.md")).toBe("o/r");
  });
});
