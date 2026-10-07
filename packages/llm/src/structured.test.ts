import { describe, expect, it } from "vitest";
import { z } from "zod";
import { JobBudget } from "./budget.js";
import { BudgetExceededError, StructuredOutputError } from "./errors.js";
import type { ChatMessage, LlmClient, LlmResponse } from "./llm.js";
import { generateStructured } from "./structured.js";

const usage = { promptTokens: 100, completionTokens: 50, cachedTokens: 10 };

/** Scripted fake: returns the given replies in order and records every prompt it received. */
function fakeLlm(replies: string[]) {
  const seen: ChatMessage[][] = [];
  let i = 0;
  const llm: LlmClient = {
    model: "fake",
    async complete(messages): Promise<LlmResponse> {
      seen.push(messages.map((m) => ({ ...m })));
      const text = replies[Math.min(i++, replies.length - 1)]!;
      return { text, usage };
    },
  };
  return { llm, seen, calls: () => i };
}

const Schema = z.object({ prompt: z.string(), options: z.array(z.string()).length(4) });
const good = JSON.stringify({ prompt: "p", options: ["a", "b", "c", "d"] });
const req = (llm: LlmClient, budget = new JobBudget(), maxRepairs?: number) => ({
  llm,
  budget,
  schema: Schema,
  system: "sys",
  user: "usr",
  ...(maxRepairs === undefined ? {} : { maxRepairs }),
});

describe("generateStructured", () => {
  it("returns on the first valid reply with think + fence noise", async () => {
    const f = fakeLlm([`<think>hmm</think>\n\`\`\`json\n${good}\n\`\`\``]);
    const r = await generateStructured(req(f.llm));
    expect(r.value.options).toHaveLength(4);
    expect(r).toMatchObject({ attempts: 1, repairs: 0 });
  });

  it("repairs a schema mismatch by feeding the concrete zod errors back", async () => {
    const wrongKeys = JSON.stringify({ question: "p", options: ["a", "b", "c", "d"] }); // M2.7 used 'question'
    const f = fakeLlm([wrongKeys, good]);
    const r = await generateStructured(req(f.llm));
    expect(r).toMatchObject({ attempts: 2, repairs: 1 });
    const repairPrompt = f.seen[1]!.at(-1)!.content;
    expect(repairPrompt).toContain("prompt");
    expect(repairPrompt).toContain("did not match the required schema");
    expect(f.seen[1]!.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("repairs unparseable output (truncated JSON)", async () => {
    const f = fakeLlm(['{"prompt": "p", "options": ["a", "b"', good]);
    expect((await generateStructured(req(f.llm))).repairs).toBe(1);
  });

  it("gives up after 1 + maxRepairs attempts with StructuredOutputError", async () => {
    const f = fakeLlm(["nope"]);
    await expect(generateStructured(req(f.llm, new JobBudget(), 2))).rejects.toMatchObject({
      name: "StructuredOutputError",
      attempts: 3,
      lastRaw: "nope",
    });
    expect(f.calls()).toBe(3);
  });

  it("sums usage across attempts and reports it to the shared budget", async () => {
    const f = fakeLlm(["bad", good]);
    const budget = new JobBudget();
    const r = await generateStructured(req(f.llm, budget));
    expect(r.usage).toEqual({ promptTokens: 200, completionTokens: 100, cachedTokens: 20 });
    expect(budget.snapshot().calls).toBe(2);
  });

  it("stops repairing when the job budget runs out (non-retryable)", async () => {
    const f = fakeLlm(["bad"]);
    const budget = new JobBudget({ maxCalls: 2, maxTotalTokens: 1e9, maxDurationMs: 1e9 });
    await expect(generateStructured(req(f.llm, budget, 5))).rejects.toBeInstanceOf(BudgetExceededError);
    expect(f.calls()).toBe(2);
  });

  it("does not wrap non-parse errors (e.g. network) as structured-output failures", async () => {
    const llm: LlmClient = { model: "x", complete: async () => Promise.reject(new Error("ECONNRESET")) };
    await expect(generateStructured(req(llm))).rejects.not.toBeInstanceOf(StructuredOutputError);
  });
});

describe("JobBudget", () => {
  it("enforces call, token and time limits and survives serialization", () => {
    let t = 0;
    const b = new JobBudget({ maxCalls: 3, maxTotalTokens: 1000, maxDurationMs: 5000 }, undefined, () => t);
    b.record({ promptTokens: 600, completionTokens: 300, cachedTokens: 0 });
    expect(() => b.assertCanCall()).not.toThrow();
    b.record({ promptTokens: 100, completionTokens: 10, cachedTokens: 0 });
    expect(() => b.assertCanCall()).toThrow(/token budget/);

    // a redelivered SQS message resumes from persisted state instead of resetting the allowance
    const resumed = new JobBudget({ maxCalls: 3, maxTotalTokens: 1e9, maxDurationMs: 5000 }, JSON.parse(JSON.stringify(b.snapshot())), () => t);
    resumed.record({ promptTokens: 1, completionTokens: 1, cachedTokens: 0 });
    expect(() => resumed.assertCanCall()).toThrow(/call budget/);

    t = 6000;
    const fresh = new JobBudget({ maxCalls: 99, maxTotalTokens: 1e9, maxDurationMs: 5000 }, { calls: 0, usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, startedAt: 0 }, () => t);
    expect(() => fresh.assertCanCall()).toThrow(/time budget/);
  });
});
