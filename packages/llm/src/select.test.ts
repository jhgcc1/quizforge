import { describe, expect, it } from "vitest";
import type { GeneratedQuestion } from "@quizforge/core";
import { pickSections, selectQuestions, sortByDifficulty } from "./select.js";
import type { Section } from "./source.js";

const sec = (i: number, text = "word ".repeat(200), tokens = 200): Section => ({ heading: `S${i}`, level: 2, text, tokens });
const gq = (prompt: string, difficulty: GeneratedQuestion["difficulty"]): GeneratedQuestion =>
  ({ prompt, options: ["a", "b", "c", "d"], correct: [0], explanation: "e", sourceQuote: "q", difficulty }) as GeneratedQuestion;

describe("pickSections", () => {
  it("drops tiny sections and returns all usable ones when there are at most k", () => {
    const sections = [sec(0), sec(1, "tiny", 3), sec(2)];
    expect(pickSections(sections, 5).map((s) => s.heading)).toEqual(["S0", "S2"]);
  });

  it("spreads the choice evenly over the document when there is no topic", () => {
    const sections = Array.from({ length: 10 }, (_, i) => sec(i));
    expect(pickSections(sections, 2).map((s) => s.heading)).toEqual(["S2", "S7"]);
  });

  it("ranks by keyword overlap with the topic and keeps document order", () => {
    const sections = [sec(0), sec(1), sec(2, "kubernetes scheduling kubernetes pods " + "x ".repeat(100)), sec(3), sec(4, "pods and kubernetes " + "y ".repeat(100)), sec(5)];
    expect(pickSections(sections, 2, "Kubernetes pods").map((s) => s.heading)).toEqual(["S2", "S4"]);
  });

  it("falls back to even spreading when the topic matches nothing", () => {
    const sections = Array.from({ length: 10 }, (_, i) => sec(i));
    expect(pickSections(sections, 2, "zzzzzz").map((s) => s.heading)).toEqual(["S2", "S7"]);
  });
});

describe("selectQuestions", () => {
  it("takes round-robin across sections, skips duplicate prompts, and orders easy to hard", () => {
    const a = [gq("Alpha one?", "hard"), gq("Alpha two?", "easy")];
    const b = [gq("alpha  ONE?", "easy"), gq("Beta two?", "medium")];
    const out = selectQuestions([a, b], 3);
    expect(out.map((x) => x.prompt)).toEqual(["Alpha two?", "Beta two?", "Alpha one?"]);
    expect(out.map((x) => x.difficulty)).toEqual(["easy", "medium", "hard"]);
  });

  it("returns fewer than n when the candidates run out", () => {
    expect(selectQuestions([[gq("Only one?", "easy")], []], 5)).toHaveLength(1);
  });
});

describe("sortByDifficulty", () => {
  it("is stable within a difficulty", () => {
    const out = sortByDifficulty([gq("h1", "hard"), gq("e1", "easy"), gq("h2", "hard"), gq("e2", "easy")]);
    expect(out.map((x) => x.prompt)).toEqual(["e1", "e2", "h1", "h2"]);
  });
});
