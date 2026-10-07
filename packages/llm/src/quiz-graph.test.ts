import { describe, expect, it } from "vitest";
import { JobBudget } from "./budget.js";
import { BudgetExceededError } from "./errors.js";
import type { ChatMessage, CompleteOptions, LlmClient } from "./llm.js";
import { QualityGateError, runQuizGraph } from "./quiz-graph.js";

const usage = { promptTokens: 100, completionTokens: 50, cachedTokens: 0 };

const FACTS = [
  "Pipecat is an open source framework for building voice and multimodal conversational agents",
  "Pipelines connect frame processors that pass audio, text and image frames downstream",
  "Transports such as Daily and WebSocket carry real time audio between the client and the bot",
  "Speech to text services convert microphone audio into transcribed words for the language model",
  "Text to speech services synthesize the bot answer back into streaming audio",
  "Voice activity detection decides when the user starts and stops speaking",
  "Function calling lets the language model invoke tools that the developer registers",
  "Interruptions allow the user to talk over the bot and cancel the audio being played",
];
const DOC = FACTS.map((f, i) => `## Topic ${i + 1}\n${f}. ${"Additional filler sentence for this section of the documentation. ".repeat(6)}`).join("\n\n");
const SHORT_DOC = "# Pipecat\n\n" + FACTS.join(".\n") + ".\n";

type QJson = { prompt: string; options: string[]; correct: number[]; explanation: string; sourceQuote: string; difficulty: string };
const q = (i: number, over: Partial<QJson> = {}): QJson => ({
  prompt: `Which statement about topic ${i + 1} is correct according to the docs?`,
  options: [`right ${i}`, `wrong a ${i}`, `wrong b ${i}`, `wrong c ${i}`],
  correct: [0],
  explanation: `Because the documentation states it for topic ${i + 1}.`,
  sourceQuote: FACTS[i % FACTS.length]!.slice(0, 60),
  difficulty: ["easy", "medium", "hard"][i % 3]!,
  ...over,
});
const ok = (...qs: QJson[]) => JSON.stringify({ questions: qs });

type Handler = (messages: ChatMessage[], opts: CompleteOptions) => string;
function scripted(handlers: Record<string, Handler | string>) {
  const calls: string[] = [];
  const llm: LlmClient = {
    model: "fake",
    async complete(messages, opts = {}) {
      const name = opts.name ?? "";
      calls.push(name);
      const key = Object.keys(handlers).find((k) => name.startsWith(k));
      if (!key) throw new Error(`unexpected call: ${name}`);
      const h = handlers[key]!;
      return { text: typeof h === "string" ? h : h(messages, opts), usage };
    },
  };
  return { llm, calls };
}
const five = [0, 1, 2, 3, 4].map((i) => q(i));

describe("single-shot", () => {
  it("one call when the first answer is valid and grounded", async () => {
    const f = scripted({ "generate:single-shot": `<think>plan</think>${ok(...five)}` });
    const r = await runQuizGraph({ llm: f.llm, budget: new JobBudget() }, { sourceText: SHORT_DOC, numQuestions: 5, strategy: "single-shot" });
    expect(r.questions).toHaveLength(5);
    expect(r.strategy).toBe("single-shot");
    expect(f.calls).toEqual(["generate:single-shot"]);
    expect(r.rounds).toBe(0);
    expect(r.budget.calls).toBe(1);
  });

  it("a hallucinated sourceQuote is caught deterministically and fixed by revise", async () => {
    const bad = [...five];
    bad[2] = q(2, { sourceQuote: "this sentence does not exist in the document" });
    const f = scripted({
      "generate:single-shot": ok(...bad),
      "revise:round-1": (m) => {
        expect(m.at(-1)!.content).toContain("not an exact excerpt");
        return ok(q(2));
      },
    });
    const r = await runQuizGraph({ llm: f.llm, budget: new JobBudget() }, { sourceText: SHORT_DOC, numQuestions: 5, strategy: "single-shot" });
    expect(f.calls).toEqual(["generate:single-shot", "revise:round-1"]);
    expect(r.rounds).toBe(1);
    expect(r.questions[2]!.sourceQuote).toBe(FACTS[2]!.slice(0, 60));
  });

  it("fails with QualityGateError when grounding is still broken after the max rounds", async () => {
    const bad = [...five];
    bad[0] = q(0, { sourceQuote: "totally made up quote here" });
    const f = scripted({ "generate:single-shot": ok(...bad), revise: ok(q(0, { sourceQuote: "still made up quote" })) });
    const err = await runQuizGraph({ llm: f.llm, budget: new JobBudget() }, { sourceText: SHORT_DOC, numQuestions: 5, strategy: "single-shot" }).catch((e) => e);
    expect(err).toBeInstanceOf(QualityGateError);
    expect(err.ungrounded).toEqual([1]);
    expect(f.calls).toEqual(["generate:single-shot", "revise:round-1", "revise:round-2"]);
  });

  it("critique stage: a flagged question is revised, others untouched", async () => {
    const f = scripted({
      "generate:single-shot": ok(...five),
      critique: JSON.stringify({ verdicts: five.map((_, i) => (i === 3 ? { index: 4, ok: false, issues: ["two options are correct"] } : { index: i + 1, ok: true, issues: [] })) }),
      "revise:round-1": ok(q(3, { prompt: "Rewritten question about topic four, now unambiguous?" })),
    });
    const r = await runQuizGraph({ llm: f.llm, budget: new JobBudget() }, { sourceText: SHORT_DOC, numQuestions: 5, strategy: "single-shot", critique: true });
    expect(f.calls).toEqual(["generate:single-shot", "critique", "revise:round-1"]);
    expect(r.questions[3]!.prompt).toContain("Rewritten");
    expect(r.questions[0]!.prompt).toBe(five[0]!.prompt);
  });

  it("critique that approves everything adds exactly one call", async () => {
    const f = scripted({
      "generate:single-shot": ok(...five),
      critique: JSON.stringify({ verdicts: five.map((_, i) => ({ index: i + 1, ok: true, issues: [] })) }),
    });
    await runQuizGraph({ llm: f.llm, budget: new JobBudget() }, { sourceText: SHORT_DOC, numQuestions: 5, strategy: "single-shot", critique: true });
    expect(f.calls).toEqual(["generate:single-shot", "critique"]);
  });
});

describe("section-map-reduce", () => {
  it("auto-routes long structured docs, samples sections, and selects n questions easy->hard", async () => {
    const f = scripted({
      "generate:section": (m) => {
        const num = /<document section="Topic (\d+)">/.exec(m.at(-1)!.content)?.[1];
        const i = num ? Number(num) - 1 : 7; // the padded "Extra" section maps to the last fact
        return ok(q(i, { prompt: `Question one about topic ${i + 1} please?` }), q(i, { prompt: `Question two about topic ${i + 1} please?`, difficulty: "hard" }));
      },
    });
    const long = DOC.repeat(1) + "\n\n" + "## Extra\n" + "More padding text to make the document long. ".repeat(500);
    const r = await runQuizGraph({ llm: f.llm, budget: new JobBudget(), mapSections: 5 }, { sourceText: long, numQuestions: 6 });
    expect(r.strategy).toBe("section-map-reduce");
    expect(f.calls.length).toBe(5);
    expect(r.questions).toHaveLength(6);
    const rank = { easy: 0, medium: 1, hard: 2 } as const;
    const ranks = r.questions.map((x) => rank[x.difficulty]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(r.questions.map((x) => x.prompt)).size).toBe(6);
  });
});

describe("budget", () => {
  it("aborts with BudgetExceededError instead of looping through revisions", async () => {
    const bad = [...five];
    bad[0] = q(0, { sourceQuote: "made up quote that is nowhere" });
    const f = scripted({ "generate:single-shot": ok(...bad), revise: ok(q(0, { sourceQuote: "still made up quote" })) });
    const budget = new JobBudget({ maxCalls: 2, maxTotalTokens: 1e9, maxDurationMs: 1e9 });
    await expect(
      runQuizGraph({ llm: f.llm, budget }, { sourceText: SHORT_DOC, numQuestions: 5, strategy: "single-shot" }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(f.calls).toHaveLength(2);
  });
});
