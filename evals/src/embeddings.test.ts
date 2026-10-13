import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Embedder } from "./similarity.js";

const extractorCalls: { texts: string[]; opts: unknown }[] = [];
const pipelineCalls: unknown[][] = [];
vi.mock("@huggingface/transformers", () => ({
  pipeline: async (...args: unknown[]) => {
    pipelineCalls.push(args);
    return async (texts: string[], opts: unknown) => {
      extractorCalls.push({ texts, opts });
      return { tolist: () => texts.map((t) => [t.length, 1]) };
    };
  },
}));
const { EMBEDDING_MODEL, cachedEmbedder, localEmbedder } = await import("./embeddings.js");

beforeEach(() => {
  extractorCalls.length = 0;
  pipelineCalls.length = 0;
});

describe("localEmbedder", () => {
  it("loads the multilingual feature-extraction model quantised and embeds in batches of 16, mean-pooled and normalised, keeping the order", async () => {
    const e = await localEmbedder();
    expect(pipelineCalls[0]).toEqual(["feature-extraction", EMBEDDING_MODEL, { dtype: "q8" }]);
    const texts = Array.from({ length: 35 }, (_, i) => "x".repeat(i + 1));
    const out = await e.embed(texts);
    expect(extractorCalls.map((c) => c.texts.length)).toEqual([16, 16, 3]);
    expect(extractorCalls[0]!.opts).toEqual({ pooling: "mean", normalize: true });
    expect(out.map((v) => v[0])).toEqual(texts.map((t) => t.length));
  });

  it("accepts another model name", async () => {
    await localEmbedder("some/model");
    expect(pipelineCalls[0]![1]).toBe("some/model");
  });
});

describe("cachedEmbedder", () => {
  const counting = () => {
    const seen: string[][] = [];
    const inner: Embedder = { embed: async (texts) => (seen.push(texts), texts.map((t) => [t.length])) };
    return { inner, seen };
  };

  it("embeds each distinct text once, across calls", async () => {
    const { inner, seen } = counting();
    const e = cachedEmbedder(inner);
    expect(await e.embed(["aa", "b", "aa"])).toEqual([[2], [1], [2]]);
    expect(seen).toEqual([["aa", "b"]]);
    expect(await e.embed(["b", "ccc"])).toEqual([[1], [3]]);
    expect(seen).toEqual([["aa", "b"], ["ccc"]]);
  });

  it("does not call the inner embedder when everything is cached or the input is empty", async () => {
    const { inner, seen } = counting();
    const e = cachedEmbedder(inner);
    await e.embed(["a"]);
    await e.embed(["a"]);
    await e.embed([]);
    expect(seen).toHaveLength(1);
  });
});
