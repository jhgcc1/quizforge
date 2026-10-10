import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { benignDocument } from "./attacks.js";
import { inspectText } from "./guard.js";
import { INJECTION_RULES } from "./injection-rules.js";

const FIXTURES = join(__dirname, "../../../evals/fixtures");

describe("keyword rules for instructions aimed at a model", () => {
  it("rule ids are unique and every rule has at least one example", () => {
    const ids = INJECTION_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of INJECTION_RULES) expect(r.examples.length, r.id).toBeGreaterThan(0);
  });

  for (const rule of INJECTION_RULES) {
    for (const ex of rule.examples) {
      it(`${rule.id} matches: ${ex}`, () => {
        expect(rule.re.test(ex.toLowerCase()), ex).toBe(true);
        // and the guard reports it (as a flag, never a block, for plain text)
        const r = inspectText(`Some normal text before.\n${ex}\nSome normal text after.`);
        expect(r.blocked, JSON.stringify(r.findings)).toBe(false);
        expect(r.findings.map((f) => f.kind)).toContain("injection_phrase");
      });
    }
  }

  it("covers every category", () => {
    expect(new Set(INJECTION_RULES.map((r) => r.category))).toEqual(new Set(["override", "role_hijack", "prompt_leak", "mode_switch", "output_hijack", "task_swap", "delimiter"]));
  });

  it("covers at least English, Portuguese and Spanish in full (every category but the delimiter-only ones may be missing elsewhere)", () => {
    for (const lang of ["en", "pt", "es"] as const) {
      const cats = new Set(INJECTION_RULES.filter((r) => r.lang === lang).map((r) => r.category));
      for (const c of ["override", "prompt_leak", "mode_switch", "output_hijack", "task_swap"]) expect(cats.has(c as never), `${lang} ${c}`).toBe(true);
    }
  });

  it("ordinary documents are NOT flagged (false-positive check on hand-written fixtures)", () => {
    expect(inspectText(benignDocument()).findings).toEqual([]);
    for (const f of readdirSync(FIXTURES).filter((x) => x.endsWith(".md") && !["injection.md", "pipecat.md", "mastra.md"].includes(x))) {
      const r = inspectText(readFileSync(join(FIXTURES, f), "utf8"));
      expect(r.findings.filter((x) => x.kind === "injection_phrase"), f).toEqual([]);
    }
  });

  it("ordinary sentences that share words with the rules are not flagged", () => {
    const fine = [
      "You can override the default rules in the config file.",
      "Skip the optional steps if you already have Node installed.",
      "Instead, create a config file named app.json.",
      "Imagine that you are building a chat application.",
      "There are no limits on the number of jobs.",
      "The system prompt is the first message sent to the model.", // a tutorial about LLMs: flagged is acceptable, see below
    ];
    for (const s of fine.slice(0, 5)) expect(inspectText(s).findings, s).toEqual([]);
    // a sentence that only MENTIONS the term is flagged (a flag is harmless: the text stays delimited data)
    expect(inspectText(fine[5]!).blocked).toBe(false);
  });
});
