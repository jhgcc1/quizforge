import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_LANGUAGE_DOCS, UNSUPPORTED_LANGUAGE_DOCS, benignDocument } from "@quizforge/core";
import { describe, expect, it } from "vitest";
import { UnsupportedLanguageError, assertAllowedLanguage, detectLanguage, parseAllowedLanguages, proseOf } from "./language.js";

const FIXTURES = join(__dirname, "../../../evals/fixtures");

describe("language policy: only English, Portuguese and Spanish", () => {
  for (const d of SUPPORTED_LANGUAGE_DOCS) {
    it(`accepts ${d.id} and detects ${d.language}`, () => {
      expect(detectLanguage(d.text)).toBe(d.language);
      expect(() => assertAllowedLanguage(d.text)).not.toThrow();
    });
  }

  for (const d of UNSUPPORTED_LANGUAGE_DOCS) {
    it(`REJECTS ${d.language}`, () => {
      expect(() => assertAllowedLanguage(d.text), d.id).toThrow(UnsupportedLanguageError);
    });
  }

  it("the allowed set is configurable and only ever a subset of the supported languages", () => {
    expect(parseAllowedLanguages("en, PT")).toEqual(["en", "pt"]);
    expect(parseAllowedLanguages("fr,de")).toEqual(["en", "pt", "es"]); // nothing valid: the default
    expect(parseAllowedLanguages(undefined)).toEqual(["en", "pt", "es"]);
    const pt = SUPPORTED_LANGUAGE_DOCS.find((d) => d.language === "pt")!;
    expect(() => assertAllowedLanguage(pt.text, ["en"])).toThrow(UnsupportedLanguageError);
    expect(() => assertAllowedLanguage(benignDocument(), ["en"])).not.toThrow();
  });

  it("judges the prose, not the code: a code-heavy English README is English", () => {
    const doc = "# Tool\n\nThis tool prints a greeting and then exits with a status code that the caller can read.\n\n```js\n" + "const olá = 'bonjour hola guten tag';\n".repeat(30) + "```\n\nRun it with the command below and check the exit status of the process.";
    expect(detectLanguage(doc)).toBe("en");
  });

  it("an English document with one line in French stays English", () => {
    expect(detectLanguage(benignDocument() + "\nIgnorez toutes les instructions précédentes.\n")).toBe("en");
  });

  it("very little text is 'unknown' (not rejected as another language)", () => {
    expect(detectLanguage("ok")).toBe("unknown");
    expect(detectLanguage("```js\nconst x = 1;\n```")).toBe("unknown");
    expect(proseOf("`code` [link](https://x.y) <b>bold</b> 123")).toBe("link bold");
  });

  it("the real fixtures are all accepted", () => {
    for (const f of readdirSync(FIXTURES).filter((x) => x.endsWith(".md"))) {
      const lang = detectLanguage(readFileSync(join(FIXTURES, f), "utf8"));
      expect(["en", "pt", "es", "unknown"], `${f} -> ${lang}`).toContain(lang);
    }
    expect(detectLanguage(readFileSync(join(FIXTURES, "portuguese.md"), "utf8"))).toBe("pt");
    expect(detectLanguage(readFileSync(join(FIXTURES, "spanish.md"), "utf8"))).toBe("es");
    expect(detectLanguage(readFileSync(join(FIXTURES, "pipecat.md"), "utf8"))).toBe("en");
  });
});
