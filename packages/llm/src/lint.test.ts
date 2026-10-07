import { describe, expect, it } from "vitest";
import { GeneratedQuestionSchema } from "@quizforge/core";
import { lintQuestion, quizMetrics } from "./lint.js";
import { blendQuality } from "./generate.js";
import { JudgeSchema, overallFromJudge } from "./judge.js";

const mk = (over: Record<string, unknown> = {}) =>
  GeneratedQuestionSchema.parse({
    prompt: "Which component carries audio between client and bot?",
    options: ["Transport", "Pipeline", "Frame", "Processor"],
    correct: [0],
    explanation: "Transports carry real time audio.",
    sourceQuote: "Transports carry audio",
    difficulty: "medium",
    ...over,
  });

describe("lintQuestion", () => {
  it("passes a clean question", () => expect(lintQuestion(mk())).toEqual([]));
  it("flags 'select all that apply' with a single correct option (the Pipecat Q6 defect)", () => {
    expect(lintQuestion(mk({ prompt: "Which are examples of Business Agents? Select all that apply." })).join()).toMatch(/select several/);
  });
  it("flags several correct options without saying so", () => {
    expect(lintQuestion(mk({ correct: [0, 1] })).join()).toMatch(/must say so/);
    expect(lintQuestion(mk({ correct: [0, 1], prompt: "Which of these are components? Select all that apply." }))).toEqual([]);
  });
  it("flags all-of-the-above, letter prefixes and give-away length", () => {
    expect(lintQuestion(mk({ options: ["All of the above", "b", "c", "d"] })).join()).toMatch(/all\/none/);
    expect(lintQuestion(mk({ options: ["A) one", "B) two", "C) three", "D) four"] })).join()).toMatch(/letters/);
    expect(lintQuestion(mk({ options: ["x".repeat(120), "short", "tiny", "mini"] })).join()).toMatch(/longer/);
  });
});

describe("quality scoring", () => {
  it("metrics reward varied difficulty and answer positions", () => {
    const flat = quizMetrics([mk(), mk({ prompt: "Another question about the transport layer?" })]);
    const varied = quizMetrics([mk({ difficulty: "easy", correct: [0] }), mk({ difficulty: "medium", correct: [1] }), mk({ difficulty: "hard", correct: [3] })]);
    expect(varied.difficultySpread).toBeGreaterThan(flat.difficultySpread);
    expect(varied.positionSpread).toBeGreaterThan(flat.positionSpread);
  });
  it("judge overall is normalized 0..1 and faithfulness dominates", () => {
    const best = JudgeSchema.parse({ faithfulness: 5, clarity: 5, distractors: 5, coverage: 5, difficulty_mix: 5 });
    const worst = JudgeSchema.parse({ faithfulness: 1, clarity: 1, distractors: 1, coverage: 1, difficulty_mix: 1 });
    expect(overallFromJudge(best)).toBe(1);
    expect(overallFromJudge(worst)).toBe(0);
    const unfaithful = { ...best, faithfulness: 1 };
    const unclear = { ...best, clarity: 1 };
    expect(overallFromJudge(unfaithful)).toBeLessThan(overallFromJudge(unclear));
  });
  it("blend stays within [0,1]", () => {
    const m = { lintPass: 1, difficultySpread: 1, positionSpread: 1, singleShare: 1 };
    expect(blendQuality(m)).toBeCloseTo(1);
    expect(blendQuality({ ...m, lintPass: 0, difficultySpread: 0, positionSpread: 0 })).toBe(0);
  });
});
