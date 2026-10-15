import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { visibleText } from "@quizforge/core";
import { describe, expect, it } from "vitest";
import { GOLDEN } from "./golden.js";
import { detectLanguage } from "./metrics.js";
import { loadReferences } from "./references.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (item: (typeof GOLDEN)[number]): string => readFileSync(`${root}${(item.source as { file: string }).file}`, "utf8");
/** The same readable form the quality checks use (links, bold and HTML reduced to their words), whitespace and case aside. */
const norm = (s: string): string => visibleText(s).replace(/\s+/g, " ").toLowerCase();

describe("the golden set", () => {
  it("has unique ids, a pinned file for every item, and a reference set whose id matches", () => {
    expect(new Set(GOLDEN.map((g) => g.id)).size).toBe(GOLDEN.length);
    for (const g of GOLDEN) {
      expect("file" in g.source, g.id).toBe(true);
      expect(existsSync(`${root}${(g.source as { file: string }).file}`), g.id).toBe(true);
      expect(loadReferences(g.id).id, g.id).toBe(g.id);
      expect(loadReferences(g.id).questions.length, g.id).toBeGreaterThanOrEqual(6);
    }
  });

  it("every reference question quotes the pinned document (verbatim, whitespace aside)", () => {
    for (const g of GOLDEN) {
      const doc = norm(read(g));
      for (const q of loadReferences(g.id).questions) expect(doc.includes(norm(q.sourceQuote)), `${g.id}: ${q.sourceQuote}`).toBe(true);
    }
  });

  it("covers the three supported languages alike: 2 real READMEs (with origin), a short document and a prompt-injection document each", () => {
    for (const lang of ["en", "pt", "es"] as const) {
      const items = GOLDEN.filter((g) => g.expect?.language === lang);
      const readmes = items.filter((g) => g.origin);
      const injections = items.filter((g) => g.expect?.forbidden?.length);
      expect(readmes.length, `${lang} READMEs`).toBe(2);
      expect(injections.length, `${lang} injection`).toBe(1);
      expect(items.length - readmes.length - injections.length, `${lang} short documents`).toBe(1);
      for (const g of readmes) expect(g.origin, g.id).toMatch(/^https:\/\/github\.com\/.+\(.*(snapshot|MIT|Apache)/);
    }
  });

  it("the language each item expects is the language the pinned document is really written in", () => {
    for (const g of GOLDEN) expect(detectLanguage(read(g)), g.id).toBe(g.expect?.language);
  });

  it("an injection document carries its canary: the forbidden strings come from the attack, and the real topic never uses them", () => {
    for (const g of GOLDEN.filter((x) => x.expect?.forbidden?.length)) {
      const doc = norm(read(g));
      expect(g.modelOnly, g.id).toBe(true);
      expect(doc, g.id).toContain("pwned");
      for (const f of g.expect!.forbidden!) expect(doc.includes(f.toLowerCase()), `${g.id}: ${f}`).toBe(true);
      // the legitimate questions must stay answerable without the canary
      for (const q of loadReferences(g.id).questions) expect(norm(`${q.prompt} ${q.answer}`).includes("pwned"), g.id).toBe(false);
    }
  });
});
