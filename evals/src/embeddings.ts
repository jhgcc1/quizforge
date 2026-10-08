import type { Embedder } from "./similarity.js";

/**
 * Free, local, multilingual sentence embeddings (no API key, no per-call cost): a quantised
 * paraphrase-multilingual-MiniLM (384 dims) run through transformers.js / ONNX. The MiniMax Token Plan key has no
 * usable embeddings endpoint, and a multilingual model is needed because one golden document is Portuguese.
 * The first run downloads ~120 MB from the Hugging Face hub into the package cache; later runs are offline.
 * Note: the model reads at most 128 tokens per text, so long passages are compared by their opening.
 */
export const EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

export async function localEmbedder(model = EMBEDDING_MODEL): Promise<Embedder> {
  const { pipeline } = await import("@huggingface/transformers");
  const extractor = await pipeline("feature-extraction", model, { dtype: "q8" });
  return {
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 16) {
        const t = await extractor(texts.slice(i, i + 16), { pooling: "mean", normalize: true });
        out.push(...(t.tolist() as number[][]));
      }
      return out;
    },
  };
}

/** Memoises vectors by text: the same document chunks are embedded once, not once per variant. */
export function cachedEmbedder(inner: Embedder): Embedder {
  const cache = new Map<string, number[]>();
  return {
    async embed(texts) {
      const missing = [...new Set(texts.filter((t) => !cache.has(t)))];
      if (missing.length) (await inner.embed(missing)).forEach((v, i) => cache.set(missing[i]!, v));
      return texts.map((t) => cache.get(t)!);
    },
  };
}
