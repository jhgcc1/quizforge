import { describe, expect, it } from "vitest";
import { MINIMAX_PRICES, ensureModelPrices, modelPattern } from "./ensure-models.js";

describe("ensureModelPrices", () => {
  it("builds an anchored, case-insensitive, dot-safe pattern", () => {
    const re = new RegExp(modelPattern("MiniMax-M2.7").replace("(?i)", ""), "i");
    expect(re.test("MiniMax-M2.7")).toBe(true);
    expect(re.test("minimax-m2.7")).toBe(true);
    expect(re.test("MiniMax-M2x7")).toBe(false); // '.' is literal
    expect(re.test("MiniMax-M2.71")).toBe(false); // anchored
  });
  it("creates only the missing models and is idempotent", async () => {
    const created: string[] = [];
    const lf = { api: { models: { list: async () => ({ data: [{ modelName: "MiniMax-M3" }] }), create: async (b: { modelName: string }) => void created.push(b.modelName) } } };
    expect(await ensureModelPrices(lf as never)).toEqual(["MiniMax-M2.7"]);
    expect(created).toEqual(["MiniMax-M2.7"]);
    const all = { api: { models: { list: async () => ({ data: MINIMAX_PRICES.map((m) => ({ modelName: m.modelName })) }), create: async () => { throw new Error("must not create"); } } } };
    expect(await ensureModelPrices(all as never)).toEqual([]);
  });
  it("prices match the provider list price ($0.30 / $1.20 per 1M tokens)", () => {
    for (const m of MINIMAX_PRICES) {
      expect(m.inputPrice * 1e6).toBeCloseTo(0.3, 6);
      expect(m.outputPrice * 1e6).toBeCloseTo(1.2, 6);
    }
  });
});
