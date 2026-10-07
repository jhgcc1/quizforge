import { describe, expect, it } from "vitest";
import { GeneratedQuizSchema, checkGrounding } from "./quiz-schema.js";

const q = (over: Record<string, unknown> = {}) => ({
  prompt: "Which transport does Pipecat use for real-time audio?",
  options: ["WebRTC", "FTP", "SMTP", "SNMP"],
  correct: [0],
  explanation: "Pipecat supports WebRTC transports.",
  sourceQuote: "It supports WebRTC and websockets",
  difficulty: "easy",
  ...over,
});

const quiz = (n = 5) => ({
  questions: Array.from({ length: n }, (_, i) => q({ prompt: `Question ${i + 1}?` })),
});

describe("GeneratedQuizSchema", () => {
  it("accepts 5..8 questions with 4 options each", () => {
    for (const n of [5, 6, 7, 8]) expect(GeneratedQuizSchema.safeParse(quiz(n)).success).toBe(true);
  });

  it("rejects fewer than 5 or more than 8 questions", () => {
    expect(GeneratedQuizSchema.safeParse(quiz(4)).success).toBe(false);
    expect(GeneratedQuizSchema.safeParse(quiz(9)).success).toBe(false);
  });

  it("requires exactly 4 distinct options", () => {
    const bad = quiz();
    bad.questions[0] = q({ options: ["a", "b", "c"] });
    expect(GeneratedQuizSchema.safeParse(bad).success).toBe(false);
    const dup = quiz();
    dup.questions[0] = q({ options: ["a", "A ", "c", "d"] });
    expect(GeneratedQuizSchema.safeParse(dup).success).toBe(false);
  });

  it("requires at least one correct index, in range and unique", () => {
    for (const correct of [[], [4], [-1], [1, 1]]) {
      const bad = quiz();
      bad.questions[0] = q({ correct });
      expect(GeneratedQuizSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects duplicated questions", () => {
    const bad = quiz();
    bad.questions[1] = q({ prompt: "question 1?" });
    expect(GeneratedQuizSchema.safeParse(bad).success).toBe(false);
  });

  it("derives type from the number of correct answers", () => {
    const parsed = GeneratedQuizSchema.parse({
      questions: [
        q({ prompt: "Single-answer question here?" }),
        q({ prompt: "Multi-answer question here?", correct: [0, 1] }),
        ...quiz(3).questions,
      ],
    });
    expect(parsed.questions[0]!.type).toBe("single");
    expect(parsed.questions[1]!.type).toBe("multiple");
  });
});

describe("checkGrounding", () => {
  const source = "Pipecat is a framework. It supports WebRTC and websockets.\n\nMore text.";
  it("passes when every sourceQuote appears in the document (whitespace/case tolerant)", () => {
    const parsed = GeneratedQuizSchema.parse(quiz());
    expect(checkGrounding(parsed, source)).toEqual({ ok: true, ungrounded: [] });
    const spaced = GeneratedQuizSchema.parse({
      questions: quiz().questions.map((x) => ({ ...x, sourceQuote: "IT SUPPORTS   webrtc and WebSockets" })),
    });
    expect(checkGrounding(spaced, source).ok).toBe(true);
  });

  it("compares visible text: markdown links, emphasis and urls in the source do not break a quote", () => {
    const md = "- [**Agents**](https://mastra.ai/docs/agents): Build autonomous agents that use LLMs and tools.\n- **Workflows**: use `graph-based` engines.";
    const mk = (sourceQuote: string) => GeneratedQuizSchema.parse({ questions: quiz().questions.map((x) => ({ ...x, sourceQuote })) });
    expect(checkGrounding(mk("Agents: Build autonomous agents that use LLMs"), md).ok).toBe(true);
    expect(checkGrounding(mk("Workflows: use graph-based engines"), md).ok).toBe(true);
    expect(checkGrounding(mk("Agents build manual agents that ignore tools"), md).ok).toBe(false); // words/order matter
  });

  it("rejects quotes too short to verify (< 3 words)", () => {
    const parsed = GeneratedQuizSchema.parse({ questions: quiz().questions.map((x) => ({ ...x, sourceQuote: "WebRTC ok" })) });
    expect(checkGrounding(parsed, "WebRTC ok and more words").ok).toBe(false);
  });

  it("flags hallucinated quotes by question position", () => {
    const parsed = GeneratedQuizSchema.parse({
      questions: quiz().questions.map((x, i) =>
        i === 2 ? { ...x, sourceQuote: "uses quantum teleportation" } : x,
      ),
    });
    expect(checkGrounding(parsed, source)).toEqual({ ok: false, ungrounded: [3] });
  });
});
