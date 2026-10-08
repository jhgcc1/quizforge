import type { LangfuseClient } from "@langfuse/client";

/**
 * Langfuse computes cost per generation only for models it has a price for, and MiniMax is not in its built-in list:
 * without this, traces show tokens but a blank cost. Prices are USD per token (MiniMax list price per 1M: $0.30 in / $1.20 out).
 * Idempotent: a model that is already defined is left alone.
 */
export const MINIMAX_PRICES = [
  { modelName: "MiniMax-M2.7", inputPrice: 0.3e-6, outputPrice: 1.2e-6 },
  { modelName: "MiniMax-M3", inputPrice: 0.3e-6, outputPrice: 1.2e-6 },
] as const;

export const modelPattern = (name: string) => `(?i)^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;

export async function ensureModelPrices(lf: LangfuseClient): Promise<string[]> {
  const existing = new Set<string>();
  for (let page = 1; page <= 10; page++) {
    const res = await lf.api.models.list({ page, limit: 100 });
    res.data.forEach((m) => existing.add(m.modelName));
    if (res.data.length < 100) break;
  }
  const created: string[] = [];
  for (const m of MINIMAX_PRICES) {
    if (existing.has(m.modelName)) continue;
    await lf.api.models.create({ modelName: m.modelName, matchPattern: modelPattern(m.modelName), unit: "TOKENS", inputPrice: m.inputPrice, outputPrice: m.outputPrice });
    created.push(m.modelName);
  }
  return created;
}
