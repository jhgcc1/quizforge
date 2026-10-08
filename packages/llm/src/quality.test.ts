import { describe, expect, it } from "vitest";
import type { GeneratedQuestion } from "@quizforge/core";
import { JudgeSchema, type JudgeResult } from "./judge.js";
import { JobBudget } from "./budget.js";
import { createFakeLlm } from "./fake.js";
import { generateQuiz } from "./generate.js";
import { QUALITY_GATES, QUALITY_VERSION, QUALITY_WEIGHTS, detectLanguage, scoreQuiz } from "./quality.js";

const DOC = `# Zephyr Cache

Zephyr Cache is an in-memory key-value store written for edge servers with very little RAM.
It keeps every entry in a single arena, so a full eviction pass never needs to walk a pointer graph.

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

const q = (prompt: string, quote: string, over: Partial<GeneratedQuestion> = {}): GeneratedQuestion => ({
  type: "single", prompt, options: ["right answer here", "wrong answer one", "wrong answer two", "wrong answer three"], correct: [0],
  explanation: "The document says so.", sourceQuote: quote, difficulty: "medium", ...over,
});
const questions = [
  q("At what fill level does Zephyr Cache start evicting entries?", "When the arena is ninety percent full"),
  q("What happens to pinned entries when the arena is full?", "Entries marked pinned are never evicted"),
  q("How often is a snapshot written by default?", "writes a snapshot to disk every five minutes"),
  q("How many replicas can a primary node stream writes to?", "up to three replicas"),
  q("Which node answers read requests but rejects writes?", "Replicas serve read requests but reject writes"),
];

const judge = (overall: number): JudgeResult => {
  const s = Math.round(1 + overall * 4);
  return { scores: JudgeSchema.parse({ faithfulness: s, clarity: s, distractors: s, coverage: s, difficulty_mix: s, reasoning: "ok" }), overall, spread: 0, samples: 3, usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 } };
};

describe("scoreQuiz: the one quality method used by production and by the evals", () => {
  it("produces the same named metrics Langfuse shows, with every value in 0..1", async () => {
    const r = await scoreQuiz({ questions, sourceText: DOC, judge: judge(0.8) });
    for (const name of ["grounded", "lint_pass", "difficulty_spread", "question_diversity", "relevance", "coverage", "language_match", "judge_overall", "judge_faithfulness", "judge_clarity", "judge_distractors", "judge_coverage", "judge_difficulty_mix"]) {
      expect(r.scores[name], name).toBeGreaterThanOrEqual(0);
      expect(r.scores[name], name).toBeLessThanOrEqual(1);
    }
    expect(r.scores.grounded).toBe(1);
    expect(r.scores.language_match).toBe(1);
    expect(r.gated).toBe(false);
    expect(r.quality).toBeGreaterThan(0.5);
  });

  it("is the weighted average of its metrics", async () => {
    const r = await scoreQuiz({ questions, sourceText: DOC, judge: judge(1) });
    const used = Object.keys(QUALITY_WEIGHTS).filter((k) => r.scores[k] !== undefined) as (keyof typeof QUALITY_WEIGHTS)[];
    const total = used.reduce((a, k) => a + QUALITY_WEIGHTS[k], 0);
    expect(r.quality).toBeCloseTo(used.reduce((a, k) => a + QUALITY_WEIGHTS[k] * r.scores[k]!, 0) / total, 9);
    expect(Object.values(QUALITY_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("a better judge score gives a better quality; the other inputs being equal", async () => {
    const low = await scoreQuiz({ questions, sourceText: DOC, judge: judge(0.3) });
    const high = await scoreQuiz({ questions, sourceText: DOC, judge: judge(0.9) });
    expect(high.quality!).toBeGreaterThan(low.quality!);
  });

  it("a hard gate zeroes it: invented quote, or questions in the wrong language", async () => {
    const invented = [...questions.slice(0, 4), q("Why?", "this sentence is not in the document at all")];
    const a = await scoreQuiz({ questions: invented, sourceText: DOC, judge: judge(0.95) });
    expect([a.scores.grounded, a.gated, a.quality]).toEqual([0, true, 0]);
    const pt = questions.map((x) => ({ ...x, prompt: "Qual é o comportamento que a documentação descreve para este caso?", options: ["a resposta que está certa", "uma resposta que não é a certa", "outra resposta que não é a certa", "mais uma resposta que não é a certa"], explanation: "A documentação diz isso para os casos que são descritos." }));
    const b = await scoreQuiz({ questions: pt, sourceText: DOC, judge: judge(0.95) });
    expect([b.scores.language_match, b.quality]).toEqual([0, 0]);
    expect(QUALITY_GATES).toEqual(["grounded", "language_match"]);
  });

  it("without the judge there is NO quality_overall (two formulas are never mixed under one name)", async () => {
    const r = await scoreQuiz({ questions, sourceText: DOC });
    expect(r.quality).toBeUndefined();
    expect(r.scores.judge_overall).toBeUndefined();
    expect(r.scores.lint_pass).toBeDefined();
  });

  it("detects Portuguese and English, and says unknown for text that is too short", () => {
    expect(detectLanguage("Qual é a versão mínima suportada do Python para esta biblioteca de relatórios?")).toBe("pt");
    expect(detectLanguage("Which version of Python is the minimum that this reporting library supports?")).toBe("en");
    expect(detectLanguage("ok")).toBe("unknown");
  });
});

describe("generateQuiz applies the same method to every call", () => {
  it("returns the shared scores, the method version and a judge that ran with the configured samples", async () => {
    const llm = createFakeLlm();
    const r = await generateQuiz({ llm, judgeSamples: 3, input: { sourceText: DOC + "\n## Limits\n\nKeys may be at most 250 bytes long, and values may be at most one megabyte.\n", numQuestions: 5, strategy: "single-shot", critique: false } });
    expect(r.judge?.samples).toBe(3);
    expect(r.judgeFailed).toBe(false);
    expect(r.qualityVersion).toBe(QUALITY_VERSION);
    expect(r.quality).toBeDefined();
    expect(Object.keys(r.scores)).toEqual(expect.arrayContaining(["grounded", "lint_pass", "judge_overall", "question_diversity", "relevance"]));
  });

  it("retries a failing judge once, and reports judge_failed (no quality) when it keeps failing, without failing the quiz", async () => {
    const base = createFakeLlm();
    let judgeCalls = 0;
    const flaky = { model: "flaky", complete: async (m: never, o: { name?: string } = {}) => (o.name?.startsWith("judge") ? (judgeCalls++, Promise.reject(new Error("judge unavailable"))) : base.complete(m, o as never)) };
    const doc = DOC + "\n## Limits\n\nKeys may be at most 250 bytes long, and values may be at most one megabyte.\n";
    const r = await generateQuiz({ llm: flaky as never, input: { sourceText: doc, numQuestions: 5, strategy: "single-shot", critique: false } });
    expect(r.questions).toHaveLength(5); // the quiz is delivered
    expect(r.judgeFailed).toBe(true);
    expect(r.quality).toBeUndefined();
    expect(judgeCalls).toBeGreaterThanOrEqual(2); // it was retried
    void JobBudget;
  });
});
