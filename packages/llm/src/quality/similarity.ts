/**
 * Semantic-ish similarity WITHOUT an embedding API (used by the scorer service for every quiz, and by the evals). The MiniMax Token Plan key has no usable embeddings, and a
 * deterministic, free metric is better for a CI gate anyway (no extra model, no extra flakiness). TF-IDF cosine over
 * word uni+bi-grams is enough to catch what we care about: near-duplicate questions and questions unrelated to the
 * document. The Embedder interface lets real embeddings (Bedrock Titan, OpenAI, ...) replace it without touching metrics.
 */
export interface Embedder {
  /** One vector per text, all of the same dimension, L2-normalised. */
  embed(texts: string[]): Promise<number[][]>;
}

const STOP = new Set("a an and are as at be by can for from has have how in is it its of on or that the this to was what when where which who why will with does do not no your you we they their there than then these those into over under about after before between each any all more most other some such only own same so too very also but if our out up one two".split(" "));

export function tokens(text: string): string[] {
  const words = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)); // crude plural folding
  const grams = words.slice(1).map((w, i) => `${words[i]} ${w}`);
  return [...words, ...grams];
}

/** TF-IDF embedder fitted on `corpus` (the document, so IDF reflects what is rare IN THIS DOCUMENT). */
export function tfidfEmbedder(corpus: string[]): Embedder {
  const docs = corpus.map(tokens);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = Math.max(1, docs.length);
  const idf = (t: string) => Math.log(1 + n / (1 + (df.get(t) ?? 0)));
  const vocab = new Map<string, number>();
  const index = (t: string) => vocab.get(t) ?? (vocab.set(t, vocab.size), vocab.size - 1);

  return {
    async embed(texts) {
      const sparse = texts.map((txt) => {
        const tf = new Map<string, number>();
        for (const t of tokens(txt)) tf.set(t, (tf.get(t) ?? 0) + 1);
        const v = new Map<number, number>();
        let norm = 0;
        for (const [t, c] of tf) {
          const w = (1 + Math.log(c)) * idf(t);
          v.set(index(t), w);
          norm += w * w;
        }
        norm = Math.sqrt(norm) || 1;
        return { v, norm };
      });
      const dim = vocab.size;
      return sparse.map(({ v, norm }) => {
        const dense = new Array<number>(dim).fill(0);
        for (const [i, w] of v) dense[i] = w / norm;
        return dense;
      });
    },
  };
}

export const cosine = (a: number[], b: number[]): number => {
  let s = 0;
  const m = Math.min(a.length, b.length); // vectors from one embed() call share a dimension
  for (let i = 0; i < m; i++) s += a[i]! * b[i]!;
  return s;
};

/** Highest cosine similarity between any two DIFFERENT items (1 = identical pair exists). */
export function maxPairwise(vectors: number[][]): number {
  let max = 0;
  for (let i = 0; i < vectors.length; i++) for (let j = i + 1; j < vectors.length; j++) max = Math.max(max, cosine(vectors[i]!, vectors[j]!));
  return max;
}
