import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MAX_QUESTION_SCORE,
  WEIGHT_GROWTH,
  computeFinalScore,
  questionWeights,
  scoreQuestion,
} from "./scoring.js";

describe("questionWeights", () => {
  it("is a geometric sequence starting at 1.0 growing 10% each step", () => {
    const w = questionWeights(6);
    expect(w[0]).toBe(1);
    expect(w[1]).toBeCloseTo(1.1, 12);
    expect(w[2]).toBeCloseTo(1.21, 12);
    expect(w[5]).toBeCloseTo(1.1 ** 5, 12);
    expect(WEIGHT_GROWTH).toBe(1.1);
  });

  it("rejects non-positive or non-integer counts", () => {
    expect(() => questionWeights(0)).toThrow();
    expect(() => questionWeights(-1)).toThrow();
    expect(() => questionWeights(2.5)).toThrow();
  });

  it("property: each weight is exactly 1.1x the previous", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), (n) => {
        const w = questionWeights(n);
        for (let i = 1; i < n; i++) {
          expect(w[i]! / w[i - 1]!).toBeCloseTo(1.1, 10);
        }
      }),
    );
  });
});

describe("scoreQuestion", () => {
  it("single correct answer: correct = 4, wrong = 0, none = 0", () => {
    expect(scoreQuestion(["a"], ["a"])).toBe(4);
    expect(scoreQuestion(["a"], ["b"])).toBe(0);
    expect(scoreQuestion(["a"], [])).toBe(0);
  });

  it("single correct answer: selecting extras cancels the hit", () => {
    expect(scoreQuestion(["a"], ["a", "b"])).toBe(0);
  });

  it("multiple answers: partial credit by (hits - misses) / K", () => {
    expect(scoreQuestion(["a", "b"], ["a", "b"])).toBe(4);
    expect(scoreQuestion(["a", "b"], ["a"])).toBe(2);
    expect(scoreQuestion(["a", "b"], ["a", "c"])).toBe(0); // 1 hit - 1 miss
    expect(scoreQuestion(["a", "b", "c"], ["a", "b"])).toBeCloseTo((4 * 2) / 3, 12);
    expect(scoreQuestion(["a", "b", "c"], ["a", "b", "c"])).toBe(4);
  });

  it("selecting every option never beats the exact answer", () => {
    expect(scoreQuestion(["a", "b"], ["a", "b", "c", "d"])).toBe(0);
  });

  it("duplicate selections count once; unknown ids count as misses", () => {
    expect(scoreQuestion(["a"], ["a", "a"])).toBe(4);
    expect(scoreQuestion(["a"], ["zzz"])).toBe(0);
  });

  it("throws when there is no correct answer", () => {
    expect(() => scoreQuestion([], ["a"])).toThrow();
  });

  it("property: result is always within [0, 4]", () => {
    const ids = fc.constantFrom("a", "b", "c", "d", "x");
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom("a", "b", "c", "d"), { minLength: 1, maxLength: 3 }),
        fc.array(ids, { maxLength: 6 }),
        (correct, selected) => {
          const s = scoreQuestion(correct, selected);
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(MAX_QUESTION_SCORE);
        },
      ),
    );
  });

  it("property: the exact correct set always scores 4", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom("a", "b", "c", "d"), { minLength: 1, maxLength: 3 }),
        (correct) => {
          expect(scoreQuestion(correct, [...correct].reverse())).toBe(4);
        },
      ),
    );
  });
});

describe("computeFinalScore", () => {
  it("is the weighted average with weights 1.1^(i-1)", () => {
    const scores = [4, 0, 4, 0, 4, 4];
    const w = questionWeights(6);
    const expected =
      scores.reduce((acc, s, i) => acc + s * w[i]!, 0) / w.reduce((a, b) => a + b, 0);
    const r = computeFinalScore(scores);
    expect(r.score).toBeCloseTo(expected, 12);
    expect(r.percent).toBeCloseTo((expected / 4) * 100, 10);
    expect(r.weights).toHaveLength(6);
  });

  it("all correct = 4 (100%), all wrong = 0", () => {
    expect(computeFinalScore([4, 4, 4, 4, 4]).score).toBeCloseTo(4, 12);
    expect(computeFinalScore([4, 4, 4, 4, 4]).percent).toBeCloseTo(100, 10);
    expect(computeFinalScore([0, 0, 0, 0, 0]).score).toBe(0);
  });

  it("later questions weigh more: missing the last costs more than missing the first", () => {
    const missFirst = computeFinalScore([0, 4, 4, 4, 4]).score;
    const missLast = computeFinalScore([4, 4, 4, 4, 0]).score;
    expect(missLast).toBeLessThan(missFirst);
  });

  it("known value: 5 questions, only the first correct", () => {
    // weights 1, 1.1, 1.21, 1.331, 1.4641 -> sum 6.1051
    const r = computeFinalScore([4, 0, 0, 0, 0]);
    expect(r.score).toBeCloseTo(4 / 6.1051, 10);
  });

  it("rejects empty input and out-of-range scores", () => {
    expect(() => computeFinalScore([])).toThrow();
    expect(() => computeFinalScore([5])).toThrow();
    expect(() => computeFinalScore([-1])).toThrow();
    expect(() => computeFinalScore([Number.NaN])).toThrow();
  });

  it("property: always within [0, 4] and monotonic in each score", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 4, noNaN: true }), { minLength: 1, maxLength: 8 }),
        (scores) => {
          const { score } = computeFinalScore(scores);
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(4 + 1e-12);
          const bumped = scores.map((s, i) => (i === 0 ? Math.min(4, s + 1) : s));
          expect(computeFinalScore(bumped).score).toBeGreaterThanOrEqual(score - 1e-12);
        },
      ),
    );
  });
});
