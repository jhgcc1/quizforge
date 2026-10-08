import { describe, expect, it } from "vitest";
import type { GeneratedQuestion } from "@quizforge/core";
import { createFakeLlm } from "./fake.js";
import type { LlmClient } from "./llm.js";
import { scoreExistingQuiz } from "./scoring.js";

const DOC = `# Zephyr Cache

Zephyr Cache is an in-memory key-value store written for edge servers with very little RAM.

## Eviction

When the arena is ninety percent full, Zephyr Cache starts evicting the least recently used entries first.
Entries marked pinned are never evicted, even when the arena is completely full.

## Persistence

Zephyr Cache writes a snapshot to disk every five minutes by default.
After a crash, the server loads the newest complete snapshot and ignores any partially written file.

## Replication

A primary node streams every write to up to three replicas over a single TCP connection.
Replicas serve read requests but reject writes with an error that names the current primary.
`;
const q = (prompt: string, quote: string): GeneratedQuestion => ({
  type: "single", prompt, options: ["right answer here", "wrong answer one", "wrong answer two", "wrong answer three"], correct: [0], explanation: "The document says so.", sourceQuote: quote, difficulty: "medium",
});
const questions = [
  q("At what fill level does Zephyr Cache start evicting entries?", "When the arena is ninety percent full"),
  q("What happens to pinned entries when the arena is full?", "Entries marked pinned are never evicted"),
  q("How often is a snapshot written by default?", "writes a snapshot to disk every five minutes"),
  q("How many replicas can a primary node stream writes to?", "up to three replicas"),
  q("Which node answers read requests but rejects writes?", "Replicas serve read requests but reject writes"),
];

describe("scoreExistingQuiz: scoring a quiz that is already saved (the scorer service)", () => {
  it("runs the judge N times, returns every shared metric and a quality_overall", async () => {
    const calls: string[] = [];
    const base = createFakeLlm();
    const llm: LlmClient = { model: "judge-model", complete: (m, o) => (calls.push(o?.name ?? ""), base.complete(m, o)) };
    const r = await scoreExistingQuiz({ llm, judgeSamples: 3, questions, sourceText: DOC });
    expect(calls.filter((c) => c.startsWith("judge"))).toHaveLength(3);
    expect(calls.every((c) => c.startsWith("judge"))).toBe(true); // nothing but the judge: no generation work here
    expect(r.judgeFailed).toBe(false);
    expect(r.quality).toBeGreaterThan(0);
    expect(Object.keys(r.scores)).toEqual(expect.arrayContaining(["judge_overall", "judge_faithfulness", "lint_pass", "grounded", "question_diversity", "relevance"]));
    expect(r.judgeModel).toBe("judge-model");
    expect(r.usage.promptTokens).toBeGreaterThan(0);
  });

  it("gives the same quality as scoring inside generation would: one method, wherever it runs", async () => {
    const { scoreQuiz } = await import("./quality.js");
    const r = await scoreExistingQuiz({ llm: createFakeLlm(), judgeSamples: 1, questions, sourceText: DOC });
    const direct = await scoreQuiz({ questions, sourceText: DOC, judge: r.judge });
    expect(r.quality).toBeCloseTo(direct.quality!, 9);
  });

  it("when the judge fails twice: no quality_overall (never another formula), judgeFailed = true, and it does not throw", async () => {
    let calls = 0;
    const llm: LlmClient = { model: "broken", complete: async () => (calls++, Promise.reject(new Error("MiniMax unavailable"))) };
    const r = await scoreExistingQuiz({ llm, judgeSamples: 1, questions, sourceText: DOC });
    expect(r.judgeFailed).toBe(true);
    expect(r.quality).toBeUndefined();
    expect(r.scores.judge_overall).toBeUndefined();
    expect(r.scores.lint_pass).toBeDefined(); // the fixed metrics are still there
    expect(calls).toBeGreaterThanOrEqual(2); // it tried again
  });
});
