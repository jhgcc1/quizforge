import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { JsonExtractionError, extractJson, firstBalancedJson, stripThink } from "./json.js";

// Shapes observed from the real MiniMax API (see smoke test).
const M27 = `<think> The user asks: "Create one multiple-choice question". We need JSON. </think>

{
  "question": "Which HTTP status code indicates a permanent redirect?",
  "options": ["301 Moved Permanently", "302 Found", "303 See Other", "307 Temporary Redirect"],
  "answer": 0
}`;

const M3 = `<think>The user wants a question. Options: - status codes - methods { not json }</think>
\`\`\`json
{ "question": "What does 404 mean?", "options": ["A) Error", "B) Not Found", "C) Forbidden", "D) Bad"], "correct_answer": "B" }
\`\`\``;

describe("stripThink", () => {
  it("removes closed blocks, including multiline and case variants", () => {
    expect(stripThink("<think>a\nb</think>hello")).toBe("hello");
    expect(stripThink("<THINK>x</THINK> ok <think>y</think>")).toBe("ok");
  });
  it("drops everything after an unterminated <think> (truncated output)", () => {
    expect(stripThink('{"a":1}<think>I was cut off {"b"')).toBe('{"a":1}');
  });
});

describe("firstBalancedJson", () => {
  it("ignores braces inside strings and escaped quotes", () => {
    const s = 'noise {"a":"}{ \\" }","b":[1,{"c":2}]} trailing';
    expect(JSON.parse(firstBalancedJson(s)!)).toEqual({ a: '}{ " }', b: [1, { c: 2 }] });
  });
  it("returns null when nothing is balanced", () => {
    expect(firstBalancedJson('{"a": 1')).toBeNull();
    expect(firstBalancedJson("no json here")).toBeNull();
  });
});

describe("extractJson", () => {
  it("handles <think> followed by bare JSON (M2.7 shape)", () => {
    expect(extractJson(M27)).toMatchObject({ answer: 0, options: expect.any(Array) });
  });
  it("handles <think> containing braces followed by a fenced block (M3 shape)", () => {
    expect(extractJson(M3)).toMatchObject({ correct_answer: "B" });
  });
  it("handles a plain fenced block with prose around it", () => {
    expect(extractJson('Sure!\n```\n{"x":1}\n```\nHope that helps')).toEqual({ x: 1 });
  });
  it("throws JsonExtractionError with the raw text for truncated or empty output", () => {
    for (const bad of ['<think>never closes', '{"a": [1, 2', "", "just words"]) {
      expect(() => extractJson(bad)).toThrow(JsonExtractionError);
    }
  });
  it("throws on syntactically invalid JSON (trailing comma)", () => {
    expect(() => extractJson('{"a": 1,}')).toThrow(/invalid JSON/);
  });
  it("property: any JSON value survives think + fence wrapping", () => {
    fc.assert(
      fc.property(fc.record({ n: fc.integer(), s: fc.string(), l: fc.array(fc.boolean()) }), (obj) => {
        const wrapped = `<think>some {reasoning} here</think>\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
        expect(extractJson(wrapped)).toEqual(obj);
      }),
    );
  });
});
