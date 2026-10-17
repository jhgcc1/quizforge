import { describe, expect, it } from "vitest";
import { classifierFinding, userFacingError } from "./user-errors.js";

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
    ["SourceError: document is empty", /does not contain a readable Markdown/],
    ["SourceError: unexpected content-type: application/pdf", /does not contain a readable Markdown/],
    ["SourceError: has no usable sections", /does not contain a readable Markdown/],
    ["SourceError: only https URLs are allowed", /not a valid https/],
    ["SourceError: credentials in URL are not allowed", /not a valid https/],
    ["SourceError: custom ports are not allowed", /not a valid https/],
    ["SourceError: too_large", /too large \(limit 512 KB\)/],
    ["UnsafeDocumentError: unsafe_document: the classifier scored 0.97 for prompt injection (1/1 windows scanned)", /ask for it to be reviewed/],
    ["UnsafeDocumentError: unsafe_document: an instruction is hidden in base64", /hidden or encoded text/],
    ["UnsafeDocumentError: unsafe_document: hidden text", /hidden or encoded text/],
    ["unsupported_language: ru", /not in a supported language/],
    ["invalid_llm_input: topic", /could not be processed safely/],
    ["StructuredOutputError: x", /could not produce a reliable quiz/],
    ["UnsafeOutputError: x", /could not produce a reliable quiz/],
    ["something unsafe_output", /could not produce a reliable quiz/],
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

describe("classifierFinding", () => {
  it("reads the score and keeps the text it came from", () => {
    const found = classifierFinding("unsafe_document: the classifier scored 0.97 for prompt injection (1/1 windows scanned)");
    expect(found).toEqual({ score: 0.97, excerpt: "unsafe_document: the classifier scored 0.97 for prompt injection (1/1 windows scanned)" });
  });

  it("is undefined for a failure of any other kind, and for no failure at all", () => {
    expect(classifierFinding("QualityGateError: only 3 grounded question(s)")).toBeUndefined();
    expect(classifierFinding("unsafe_document: an instruction is hidden in base64")).toBeUndefined();
    expect(classifierFinding(null)).toBeUndefined();
  });

  it("truncates a very long failure, because it is shown to a reviewer", () => {
    const long = `the classifier scored 0.99 ${"x".repeat(900)}`;
    expect(classifierFinding(long)!.excerpt).toHaveLength(500);
  });
});
