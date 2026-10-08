import { describe, expect, it } from "vitest";
import { userFacingError } from "./user-errors.js";

describe("userFacingError", () => {
  it.each([
    ["QualityGateError: questions 2 are not grounded in the document after 2 revision round(s)", /could not produce a reliable quiz/],
    ["QualityGateError: only 3 grounded question(s) after 2 revision round(s); not found in the document: #1 \"x\"", /could not produce a reliable quiz/],
    ["StructuredOutputError: model output still invalid after 3 attempts: ...", /could not produce a reliable quiz/],
    ["BudgetExceededError: LLM call budget exceeded (16)", /too large or complex/],
    ["SourceError: document exceeds 524288 bytes", /too large \(limit 512 KB\)/],
    ["SourceError: source returned HTTP 404", /not found \(HTTP 404\)/],
    ["SourceError: not a valid URL: nope", /not a valid https/],
    ["Error: Generation timed out; please create the quiz again.", /took too long/],
    ["TypeError: Cannot read properties of undefined (reading 'x')\n    at foo (/app/src/x.ts:1:1)", /^Quiz generation failed\. Please try again\.$/],
  ])("%s", (raw, expected) => {
    expect(userFacingError(raw)).toMatch(expected);
  });
  it("never leaks exception names, stack frames or file paths", () => {
    for (const raw of ["TypeError: boom\n    at x (/app/node_modules/foo/index.js:10:5)", "QualityGateError: x", "BudgetExceededError: y", "PostgresError: relation \"quizzes\" does not exist"]) {
      expect(userFacingError(raw)).not.toMatch(/Error:|at .*\(|\/app\/|node_modules|relation/);
    }
  });
  it("null in, null out", () => expect(userFacingError(null)).toBeNull());
  it("tells the user which hosts are allowed when the host is rejected", () => {
    const m = userFacingError("SourceError: host not allowed: evil.example.com")!;
    expect(m).toMatch(/not allowed/i);
    expect(m).toMatch(/github\.com/);
  });
});
