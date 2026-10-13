import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sdkStart: vi.fn(),
  sdkShutdown: vi.fn(async () => undefined),
  scoreCreate: vi.fn(),
  flush: vi.fn(async () => undefined),
  genUpdate: vi.fn(),
  span: { traceId: "trace-1" },
  propagate: vi.fn(),
  startObs: vi.fn(),
}));

vi.mock("@opentelemetry/sdk-node", () => ({ NodeSDK: class { start = h.sdkStart; shutdown = h.sdkShutdown; } }));
vi.mock("@langfuse/otel", () => ({ LangfuseSpanProcessor: class {} }));
vi.mock("@langfuse/langchain", () => ({ CallbackHandler: class { kind = "handler"; } }));
vi.mock("@langfuse/client", () => ({ LangfuseClient: class { score = { create: h.scoreCreate }; flush = h.flush; } }));
vi.mock("@langfuse/tracing", () => ({ propagateAttributes: h.propagate, startActiveObservation: h.startObs }));

const obs = await import("./observability.js");

const ENV = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  vi.clearAllMocks();
  h.propagate.mockImplementation((_attrs: unknown, fn: () => unknown) => fn());
  h.startObs.mockImplementation(async (_name: string, fn: (s: unknown) => unknown) => fn(h.span));
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const enable = () => {
  process.env.LANGFUSE_PUBLIC_KEY = "pk";
  process.env.LANGFUSE_SECRET_KEY = "sk";
};
const disable = () => {
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
};

describe("tracing off (no keys)", () => {
  beforeEach(disable);
  it("is a no-op everywhere", async () => {
    expect(obs.tracingEnabled()).toBe(false);
    obs.initTracing();
    expect(h.sdkStart).not.toHaveBeenCalled();
    expect(await obs.traced("t", {}, async (ctx) => ctx)).toEqual({ traceId: undefined, callbacks: [] });
    await obs.scoreTrace("trace", "n", 1);
    expect(h.scoreCreate).not.toHaveBeenCalled();
    const llm = { model: "m", complete: vi.fn() };
    expect(obs.withGenerationTracing(llm)).toBe(llm);
  });
});

describe("tracing on", () => {
  beforeEach(enable);

  it("traced() propagates attributes (stringifying metadata, dropping nulls) and hands over the trace id", async () => {
    const ctx = await obs.traced("quiz", { sessionId: "s", userId: "u", tags: ["a"], metadata: { n: 3, drop: undefined, nul: null, k: "v" } }, async (c) => c);
    expect(ctx.traceId).toBe("trace-1");
    expect(ctx.callbacks).toHaveLength(1);
    expect(h.propagate.mock.calls[0]![0]).toEqual({ traceName: "quiz", sessionId: "s", userId: "u", tags: ["a"], metadata: { n: "3", k: "v" } });
    expect(h.sdkStart).toHaveBeenCalledTimes(1);
    await obs.traced("again", {}, async () => 1);
    expect(h.propagate.mock.calls[1]![0]).toEqual({ traceName: "again", metadata: {} });
    expect(h.sdkStart).toHaveBeenCalledTimes(1); // the SDK starts once
  });

  it("scoreTrace sends an idempotent score, with an optional comment, and skips without a trace id", async () => {
    await obs.scoreTrace("t1", "quality", 0.8, "good");
    await obs.scoreTrace("t1", "quality", 0.5);
    await obs.scoreTrace(undefined, "quality", 0.5);
    expect(h.scoreCreate).toHaveBeenCalledTimes(2);
    expect(h.scoreCreate.mock.calls[0]![0]).toEqual({ id: "t1:quality", traceId: "t1", name: "quality", value: 0.8, dataType: "NUMERIC", comment: "good" });
    expect(h.scoreCreate.mock.calls[1]![0]).not.toHaveProperty("comment");
  });

  it("scoreTrace never throws when the client does", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.scoreCreate.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await expect(obs.scoreTrace("t", "n", 1)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("langfuse score failed", "boom");
    warn.mockRestore();
  });

  it("withGenerationTracing records the call as a generation, clipping long prompts", async () => {
    const llm = { model: "m", complete: vi.fn(async () => ({ text: "x".repeat(2100), usage: { promptTokens: 4, completionTokens: 2, cachedTokens: 0 } })) };
    h.startObs.mockImplementation(async (_n: string, fn: (g: unknown) => unknown) => fn({ update: h.genUpdate }));
    const wrapped = obs.withGenerationTracing(llm);
    expect(wrapped.model).toBe("m");
    const res = await wrapped.complete([{ role: "user", content: "y".repeat(2500) }], { name: "judge", temperature: 0.1 });
    expect(res.text).toHaveLength(2100);
    expect(h.startObs.mock.calls[0]![0]).toBe("judge");
    expect(h.startObs.mock.calls[0]![2]).toEqual({ asType: "generation" });
    const [first, second] = h.genUpdate.mock.calls.map((c) => c[0]);
    expect(first.modelParameters).toEqual({ temperature: 0.1 });
    expect(first.input[0].content).toContain("…[500 more characters]");
    expect(second.output).toContain("…[100 more characters]");
    expect(second.usageDetails).toEqual({ input: 4, output: 2 });
    await wrapped.complete([{ role: "user", content: "short" }]);
    expect(h.startObs.mock.calls[1]![0]).toBe("llm-call");
    expect(h.genUpdate.mock.calls[2]![0]).not.toHaveProperty("modelParameters");
  });

  it("withGenerationTracing survives a tracing failure", async () => {
    const llm = { model: "m", complete: vi.fn(async () => ({ text: "ok", usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 } })) };
    h.startObs.mockImplementation(async (_n: string, fn: (g: unknown) => unknown) =>
      fn({ update: () => { throw new Error("tracing down"); } }),
    );
    expect((await obs.withGenerationTracing(llm).complete([])).text).toBe("ok");
  });

  it("flushTracing flushes the client and shuts the SDK down, and never throws", async () => {
    await obs.scoreTrace("t", "n", 1); // creates the client
    await obs.traced("x", {}, async () => 1); // sdk exists
    await obs.flushTracing();
    expect(h.flush).toHaveBeenCalled();
    expect(h.sdkShutdown).toHaveBeenCalledTimes(1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.flush.mockRejectedValueOnce(new Error("net"));
    await expect(obs.flushTracing()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("langfuse flush failed", "net");
    warn.mockRestore();
  });
});
