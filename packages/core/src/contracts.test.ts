import { describe, expect, it } from "vitest";
import { CreateQuizBodySchema, IdempotencyKeySchema, QuizJobMessageSchema, SaveAnswerBodySchema, requestFingerprint } from "./contracts.js";

describe("contracts", () => {
  it("CreateQuizBody applies defaults and rejects unknown fields and out-of-range sizes", () => {
    expect(CreateQuizBodySchema.parse({})).toEqual({ numQuestions: 6, strategy: "auto", critique: true });
    expect(CreateQuizBodySchema.safeParse({ numQuestions: 4 }).success).toBe(false);
    expect(CreateQuizBodySchema.safeParse({ numQuestions: 9 }).success).toBe(false);
    expect(CreateQuizBodySchema.safeParse({ strategy: "magic" }).success).toBe(false);
    expect(CreateQuizBodySchema.safeParse({ admin: true }).success).toBe(false);
    expect(CreateQuizBodySchema.safeParse({ sourceUrl: "not a url" }).success).toBe(false);
  });
  it("SaveAnswerBody needs 1-4 uuids and a revision", () => {
    const id = "6f1d1e0c-9a0b-4c43-8a6e-1f2d3c4b5a69";
    expect(SaveAnswerBodySchema.safeParse({ optionIds: [id], revision: 1 }).success).toBe(true);
    expect(SaveAnswerBodySchema.safeParse({ optionIds: [], revision: 1 }).success).toBe(false);
    expect(SaveAnswerBodySchema.safeParse({ optionIds: ["x"], revision: 1 }).success).toBe(false);
    expect(SaveAnswerBodySchema.safeParse({ optionIds: [id], revision: -1 }).success).toBe(false);
  });
  it("Idempotency-Key format", () => {
    expect(IdempotencyKeySchema.safeParse("3b241101-e2bb-4255-8caf-4136c566a962").success).toBe(true);
    for (const bad of ["short", "has space in it!", "x".repeat(129)]) expect(IdempotencyKeySchema.safeParse(bad).success).toBe(false);
  });
  it("queue message is versioned and id-only", () => {
    expect(QuizJobMessageSchema.safeParse({ v: 1, quizId: "6f1d1e0c-9a0b-4c43-8a6e-1f2d3c4b5a69" }).success).toBe(true);
    expect(QuizJobMessageSchema.safeParse({ v: 2, quizId: "6f1d1e0c-9a0b-4c43-8a6e-1f2d3c4b5a69" }).success).toBe(false);
  });
  it("requestFingerprint ignores key order and undefined, but not values", () => {
    expect(requestFingerprint({ a: 1, b: { y: 2, x: 1 } })).toBe(requestFingerprint({ b: { x: 1, y: 2 }, a: 1, c: undefined }));
    expect(requestFingerprint({ a: 1 })).not.toBe(requestFingerprint({ a: 2 }));
  });
});
