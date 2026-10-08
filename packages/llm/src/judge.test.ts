import { describe, expect, it } from "vitest";
import { GeneratedQuestionSchema } from "@quizforge/core";
import { JobBudget } from "./budget.js";
import { judgeQuiz } from "./judge.js";
import type { LlmClient } from "./llm.js";

const q = GeneratedQuestionSchema.parse({
  prompt: "Which component carries the audio between client and bot?",
  options: ["Transport", "Pipeline", "Frame", "Processor"], correct: [0],
  explanation: "The transport carries the audio.", sourceQuote: "transport carries the audio in real time", difficulty: "easy",
});
const score = (f: number, c = 5, d = 4, cov = 4, m = 3) => JSON.stringify({ faithfulness: f, clarity: c, distractors: d, coverage: cov, difficulty_mix: m, reasoning: `f=${f}` });
const llmReturning = (replies: string[]): LlmClient => {
  let i = 0;
  return { model: "judge", complete: async () => ({ text: replies[i++ % replies.length]!, usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 0 } }) };
};

describe("judgeQuiz with several samples", () => {
  it("the MEDIAN absorbs one noisy outlier (the 0.86,0.86,0.45 pattern measured on MiniMax-M3)", async () => {
    const noisy = llmReturning([score(5), score(2, 4, 4, 2), score(5)]); // middle judgement is the outlier
    const single = await judgeQuiz({ llm: llmReturning([score(2, 4, 4, 2)]), budget: new JobBudget(), context: "doc", questions: [q] });
    const median = await judgeQuiz({ llm: noisy, budget: new JobBudget(), context: "doc", questions: [q], samples: 3 });
    expect(single.overall).toBeLessThan(0.55); // one bad judgement would fail an item
    expect(median.overall).toBeGreaterThan(0.8); // the median ignores it
    expect(median.scores.faithfulness).toBe(5);
    expect(median.samples).toBe(3);
    expect(median.spread).toBeGreaterThan(0.3); // ...but the disagreement stays visible
  });
  it("consumes one budget call and its tokens per sample", async () => {
    const budget = new JobBudget();
    const r = await judgeQuiz({ llm: llmReturning([score(4)]), budget, context: "doc", questions: [q], samples: 3 });
    expect(budget.snapshot().calls).toBe(3);
    expect(r.usage.promptTokens).toBe(30);
    expect(r.spread).toBe(0);
  });
  it("defaults to one sample (production cost)", async () => {
    const budget = new JobBudget();
    await judgeQuiz({ llm: llmReturning([score(4)]), budget, context: "doc", questions: [q] });
    expect(budget.snapshot().calls).toBe(1);
  });
});
