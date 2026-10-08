import { describe, expect, it } from "vitest";
import { checkGrounding } from "@quizforge/core";
import { createFakeLlm } from "./fake.js";
import { fetchMarkdown } from "./source.js";
import { generateQuiz } from "./generate.js";

const DOC = Array.from({ length: 14 }, (_, i) => `Pipecat component number ${i + 1} handles one specific part of the real time voice pipeline well.`).join("\n\n");

describe("fake llm (offline pipeline)", () => {
  it("produces a fully grounded 6-question quiz through the real graph, judge included", async () => {
    const r = await generateQuiz({ llm: createFakeLlm(), input: { sourceText: DOC, numQuestions: 6, critique: true } });
    expect(r.questions).toHaveLength(6);
    expect(checkGrounding({ questions: r.questions }, DOC).ok).toBe(true);
    expect(r.judge).toBeDefined();
    expect(r.quality).toBeGreaterThan(0.5);
    for (const q of r.questions) expect(q.options).toHaveLength(4);
  });
  it("works for the section-map-reduce path too", async () => {
    const sections = Array.from({ length: 6 }, (_, i) => `## Part ${i + 1}\n${Array.from({ length: 6 }, (_, j) => `Part ${i + 1} sentence ${j + 1} explains one more detail about the framework in depth.`).join(" ")}`).join("\n\n");
    const r = await generateQuiz({ llm: createFakeLlm(), input: { sourceText: sections, numQuestions: 6, strategy: "section-map-reduce", critique: false }, judge: false });
    expect(r.strategy).toBe("section-map-reduce");
    expect(r.questions).toHaveLength(6);
    expect(fetchMarkdown).toBeTypeOf("function");
  });
});
