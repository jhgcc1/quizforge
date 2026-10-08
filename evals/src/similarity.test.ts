import { describe, expect, it } from "vitest";
import { cosine, maxPairwise, tfidfEmbedder, tokens } from "./similarity.js";

const DOC = [
  "Zephyr Cache keeps every entry in a single arena so eviction never walks a pointer graph.",
  "When the arena is ninety percent full the least recently used entries are evicted first.",
  "A snapshot is written to disk every five minutes and loaded again after a crash.",
  "A primary node streams every write to up to three replicas over one TCP connection.",
  "Keys may be at most 250 bytes long and values at most one megabyte.",
];

describe("tfidf similarity", () => {
  it("tokenises with stop-word removal, plural folding and bigrams", () => {
    expect(tokens("The replicas stream writes")).toEqual(expect.arrayContaining(["replica", "stream", "write", "replica stream"]));
    expect(tokens("the of and")).toEqual([]);
  });

  it("catches near-verbatim duplicates; a paraphrase is only partly similar (the lexical limit, embeddings would close it)", async () => {
    const emb = tfidfEmbedder(DOC);
    const [a, verbatim, paraphrase, other] = await emb.embed([
      "How often is a snapshot written to disk?",
      "How often is the snapshot written to disk?",
      "How frequently does the snapshot get written to disk?",
      "How many replicas can a primary node stream writes to?",
    ]);
    expect(cosine(a!, verbatim!)).toBeGreaterThan(0.8); // what a duplicate-detection gate must catch
    expect(cosine(a!, paraphrase!)).toBeGreaterThan(0.25); // related, but synonyms are invisible to TF-IDF
    expect(cosine(a!, paraphrase!)).toBeLessThan(cosine(a!, verbatim!));
    expect(cosine(a!, other!)).toBeLessThan(0.15);
    expect(cosine(a!, a!)).toBeCloseTo(1, 6);
  });

  it("maxPairwise finds the worst pair and is 0 for unrelated items", async () => {
    const emb = tfidfEmbedder(DOC);
    const v = await emb.embed(["snapshot written to disk every five minutes", "snapshot written to disk every five minutes!", "maximum key length in bytes"]);
    expect(maxPairwise(v)).toBeGreaterThan(0.95);
    const u = await emb.embed(["snapshot disk crash", "replicas tcp connection"]);
    expect(maxPairwise(u)).toBeLessThan(0.1);
  });

  it("a question about the document is closer to it than a hallucinated one", async () => {
    const emb = tfidfEmbedder(DOC);
    const [good, bad, ...docs] = await emb.embed(["How many replicas can a primary node stream writes to?", "Which GPU architecture does the renderer require?", ...DOC]);
    const best = (q: number[]) => Math.max(...docs.map((d) => cosine(q, d)));
    expect(best(good!)).toBeGreaterThan(0.2);
    expect(best(bad!)).toBeLessThan(0.05);
  });
});
