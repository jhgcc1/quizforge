import { describe, expect, it } from "vitest";
import { canaryAbsent, expectedStage, noPromptLeak, safeOutcome } from "./nightly-assertions.js";

const out = (o) => JSON.stringify(o);

describe("nightly assertions", () => {
  it("a topic refused before the model is a safe outcome", () => {
    expect(safeOutcome(out({ status: "invalid_input", llmCalls: 0, reason: "instruction in the topic" })).pass).toBe(true);
    expect(safeOutcome(out({ status: "invalid_input", llmCalls: 1 })).pass).toBe(false);
    expect(expectedStage(out({ status: "invalid_input", llmCalls: 0 }), { vars: { stage: "resisted" } }).pass).toBe(true);
  });
  it("everything else is judged by the shared assertions", () => {
    expect(safeOutcome(out({ status: "blocked", llmCalls: 0 })).pass).toBe(true);
    expect(safeOutcome(out({ status: "error", llmCalls: 1 })).pass).toBe(false);
    expect(expectedStage(out({ status: "invalid_input", llmCalls: 0 }), { vars: { stage: "rejected" } }).pass).toBe(false);
    expect(expectedStage(out({ status: "blocked", llmCalls: 0 }), { vars: { stage: "rejected" } }).pass).toBe(true);
    expect(canaryAbsent(out({ status: "blocked" })).pass).toBe(true);
    expect(noPromptLeak(out({ status: "blocked" })).pass).toBe(true);
  });
});
