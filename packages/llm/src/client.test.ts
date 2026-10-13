import { beforeEach, describe, expect, it, vi } from "vitest";

const made: { args: Record<string, unknown>; invoke: ReturnType<typeof vi.fn> }[] = [];
let nextResponse: unknown = { content: "hello", usage_metadata: { input_tokens: 11, output_tokens: 7, input_token_details: { cache_read: 3 } } };

vi.mock("@langchain/openai", () => ({
  ChatOpenAI: class {
    invoke = vi.fn(async () => nextResponse);
    constructor(args: Record<string, unknown>) {
      made.push({ args, invoke: this.invoke });
    }
  },
}));

const { createMiniMaxClient } = await import("./client.js");

beforeEach(() => {
  made.length = 0;
  nextResponse = { content: "hello", usage_metadata: { input_tokens: 11, output_tokens: 7, input_token_details: { cache_read: 3 } } };
});

describe("createMiniMaxClient", () => {
  it("calls the OpenAI-compatible endpoint with defaults and maps usage", async () => {
    const c = createMiniMaxClient({ apiKey: "k", model: "m1" });
    expect(c.model).toBe("m1");
    const r = await c.complete([{ role: "user", content: "hi" }]);
    expect(r).toEqual({ text: "hello", usage: { promptTokens: 11, completionTokens: 7, cachedTokens: 3 } });
    expect(made[0]!.args).toMatchObject({
      model: "m1",
      apiKey: "k",
      configuration: { baseURL: "https://api.minimax.io/v1" },
      temperature: 0.3,
      maxRetries: 3,
      timeout: 90_000,
    });
    expect(made[0]!.args).not.toHaveProperty("maxTokens");
    const [msgs, cfg] = made[0]!.invoke.mock.calls[0]! as unknown as [unknown, Record<string, unknown>];
    expect(msgs).toEqual([{ role: "user", content: "hi" }]);
    expect(cfg).toEqual({ runName: "minimax", metadata: {} });
  });

  it("honours config and per-call options, and reuses one model per temperature/maxTokens", async () => {
    const callbacks = [{}] as never;
    const c = createMiniMaxClient({ apiKey: "k", model: "m", baseUrl: "http://x/v1", maxRetries: 1, timeoutMs: 5, callbacks });
    await c.complete([{ role: "user", content: "a" }], { temperature: 0, maxTokens: 50, name: "gen", metadata: { q: 1 } });
    await c.complete([{ role: "user", content: "b" }], { temperature: 0, maxTokens: 50 });
    await c.complete([{ role: "user", content: "c" }], { temperature: 0.9 });
    expect(made).toHaveLength(2);
    expect(made[0]!.args).toMatchObject({ configuration: { baseURL: "http://x/v1" }, temperature: 0, maxTokens: 50, maxRetries: 1, timeout: 5 });
    expect(made[0]!.invoke).toHaveBeenCalledTimes(2);
    const cfg = made[0]!.invoke.mock.calls[0]![1] as Record<string, unknown>;
    expect(cfg).toEqual({ runName: "gen", metadata: { q: 1 }, callbacks });
  });

  it("flattens array content and tolerates missing usage and null content", async () => {
    const c = createMiniMaxClient({ apiKey: "k", model: "m" });
    nextResponse = { content: ["a", { text: "b" }, {}] };
    expect(await c.complete([])).toEqual({ text: "ab", usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 } });
    nextResponse = { content: null };
    expect((await c.complete([])).text).toBe("");
    nextResponse = { content: 42 };
    expect((await c.complete([])).text).toBe("42");
  });
});
