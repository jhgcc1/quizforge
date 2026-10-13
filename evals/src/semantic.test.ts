import type { GeneratedQuestion } from "@quizforge/core";
import { describe, expect, it } from "vitest";
import { docChunks, questionText, referenceText, semanticScores, type Reference } from "./semantic.js";
import type { Embedder } from "./similarity.js";

const q = (prompt: string, options: string[], correct: number[]): GeneratedQuestion => ({ prompt, options, correct }) as unknown as GeneratedQuestion;

/** Bag-of-topic-words embedder: one dimension per topic word, so cosine means "talks about the same topics". */
const TOPICS = ["retry", "queue", "cache", "auth"];
const topicEmbedder = (log: string[][] = []): Embedder => ({
  async embed(texts) {
    log.push(texts);
    return texts.map((t) => TOPICS.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)));
  },
});

describe("question and reference text", () => {
  it("joins the prompt with the correct option texts", () => {
    expect(questionText(q("Which retry?", ["a", "b", "c"], [0, 2]))).toBe("Which retry? a; c");
    expect(referenceText({ prompt: "P", answer: "A", sourceQuote: "s" })).toBe("P A");
  });
});

describe("docChunks", () => {
  const words = (n: number, w = "word") => Array.from({ length: n }, (_, i) => `${w}${String.fromCharCode(97 + (i % 26))}`).join(" ");

  it("splits on blank lines, drops chunks of fewer than 6 words and cuts each at 120 words", () => {
    const text = `# Title\n\n${words(30)}\n\nshort bit\n\n${words(200, "long")}`;
    const chunks = docChunks(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((c) => c.split(" ").length >= 6 && c.split(" ").length <= 120)).toBe(true);
    expect(chunks.some((c) => c.split(" ").length === 120)).toBe(true);
    expect(chunks.join(" ")).not.toContain("short bit");
  });

  it("falls back to the whole text when no section is long enough", () => {
    expect(docChunks("Just six little words right here.")).toEqual(["just six little words right here"]);
    expect(docChunks("tiny")).toEqual([]);
  });

  it("reduces links to their words", () => {
    const [c] = docChunks("See the [scheduler guide](https://example.com/very/long/url) for the retry policy details here");
    expect(c).toContain("scheduler guide");
    expect(c).not.toContain("https://");
  });
});

describe("semanticScores", () => {
  const source = "Retry policy: a failed job is retried three times with doubling delay between attempts.\n\nThe queue keeps jobs ordered and survives restarts of the worker process.";
  const refs: Reference[] = [
    { prompt: "How often is a job retry attempted?", answer: "three", sourceQuote: "" },
    { prompt: "What does the queue guarantee?", answer: "ordering", sourceQuote: "" },
  ];

  it("embeds questions, references, other references and chunks in ONE call and scores each signal from the right slice", async () => {
    const log: string[][] = [];
    const questions = [q("Retry count?", ["three", "five"], [0]), q("Queue order?", ["kept", "lost"], [0])];
    const other = [{ prompt: "How is auth cache handled?", answer: "token", sourceQuote: "" }];
    const s = await semanticScores({ questions, references: refs, sourceText: source, embedder: topicEmbedder(log), otherReferences: other });
    expect(log).toHaveLength(1);
    expect(log[0]!.length).toBe(2 + 2 + 1 + docChunks(source).length);
    expect(s.ref_recall).toBe(1); // both references are matched by a question on the same topic
    expect(s.ref_precision).toBe(1);
    expect(s.emb_relevance).toBe(1);
    expect(s.emb_diversity).toBe(1); // the two questions share no topic
    expect(s.ref_control).toBe(0); // other-document references share no topic with these questions
  });

  it("paraphrased duplicates lower diversity, a missing topic lowers recall but not precision", async () => {
    const dup = await semanticScores({ questions: [q("Retry A?", ["x"], [0]), q("Retry B?", ["y"], [0])], references: refs, sourceText: source, embedder: topicEmbedder() });
    expect(dup.emb_diversity).toBe(0);
    expect(dup.ref_recall).toBe(0.5); // the queue reference has no matching question
    expect(dup.ref_precision).toBe(1); // precision is still perfect: each question is close to SOME reference (that is why recall is reported too)
  });

  it("omits the reference signals when there are no references, and the control when there is no other set", async () => {
    const s = await semanticScores({ questions: [q("Retry?", ["x"], [0])], references: [], sourceText: source, embedder: topicEmbedder() });
    expect(Object.keys(s).sort()).toEqual(["emb_diversity", "emb_relevance"]);
    const s2 = await semanticScores({ questions: [q("Retry?", ["x"], [0])], references: refs, sourceText: source, embedder: topicEmbedder() });
    expect(s2).not.toHaveProperty("ref_control");
    expect(s2).toHaveProperty("ref_recall");
  });

  it("without questions, nothing is relevant and nothing is duplicated", async () => {
    const s = await semanticScores({ questions: [], references: refs, sourceText: source, embedder: topicEmbedder() });
    expect(s.emb_relevance).toBe(0);
    expect(s.ref_recall).toBe(0);
    expect(s.ref_precision).toBe(0);
  });
});
