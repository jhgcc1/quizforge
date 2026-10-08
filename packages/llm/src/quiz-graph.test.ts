import { MemorySaver } from "@langchain/langgraph";
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

const quoteOf = (i: number) => FACTS[i % FACTS.length]!.split(" ").slice(0, 8).join(" ");

type QJson = { prompt: string; options: string[]; correct: number[]; explanation: string; sourceQuote: string; difficulty: string };
const q = (i: number, over: Partial<QJson> = {}): QJson => ({
  prompt: `Which statement about topic ${i + 1} is correct according to the docs?`,
  options: [`right ${i}`, `wrong a ${i}`, `wrong b ${i}`, `wrong c ${i}`],
  correct: [0],
  explanation: `Because the documentation states it for topic ${i + 1}.`,
  sourceQuote: quoteOf(i),
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
    expect(r.questions.map((x) => x.sourceQuote)).toContain(quoteOf(2));
    expect(r.questions.map((x) => x.sourceQuote)).not.toContain("this sentence does not exist in the document");
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

describe("graceful degradation of ungrounded questions", () => {
  const six = [0, 1, 2, 3, 4, 5].map((i) => q(i));
  const hallucinated = (i: number) => q(i, { sourceQuote: `a quote about topic ${i} that does not exist anywhere in the document` });

  it("drops ONE persistently ungrounded question and still delivers a 5-question quiz", async () => {
    const bad = [...six];
    bad[2] = hallucinated(2);
    const f = scripted({ "generate:single-shot": ok(...bad), revise: ok(hallucinated(2)) }); // the reviser cannot fix it either
    const r = await runQuizGraph({ llm: f.llm, budget: new JobBudget() }, { sourceText: SHORT_DOC, numQuestions: 6, strategy: "single-shot" });
    expect(r.questions).toHaveLength(5);
    expect(r.questions.every((x) => !x.sourceQuote.includes("does not exist"))).toBe(true);
    expect(r.trail.at(-1)).toBe("finalize:dropped-1-ungrounded");
  });

  it("still fails when dropping would leave fewer than 5, and the error shows the rejected quote", async () => {
    const bad = [...six];
    bad[0] = hallucinated(0);
    bad[1] = hallucinated(1);
    const f = scripted({ "generate:single-shot": ok(...bad), revise: ok(hallucinated(0), hallucinated(1)) });
    const err = await runQuizGraph({ llm: f.llm, budget: new JobBudget() }, { sourceText: SHORT_DOC, numQuestions: 6, strategy: "single-shot" }).catch((e) => e);
    expect(err).toBeInstanceOf(QualityGateError);
    expect(err.ungrounded).toEqual([1, 3]); // positions after the easy->hard ordering
    expect(err.message).toContain("does not exist anywhere"); // diagnosable from the logs
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

describe("checkpoint resume (SQS redelivery)", () => {
  it("a crash mid-graph resumes from the checkpoint without repeating the LLM calls that succeeded", async () => {
    const bad = [...five];
    bad[0] = q(0, { sourceQuote: "made up quote that is nowhere in it" });
    let reviseCalls = 0;
    const f = scripted({
      "generate:single-shot": ok(...bad),
      "revise:round-1": () => {
        reviseCalls++;
        if (reviseCalls === 1) throw new Error("worker killed (ECONNRESET)"); // first delivery dies here
        return ok(q(0));
      },
    });
    const checkpointer = new MemorySaver();
    const budget1 = new JobBudget();
    await expect(
      runQuizGraph({ llm: f.llm, budget: budget1 }, { sourceText: SHORT_DOC, numQuestions: 5, strategy: "single-shot" }, { threadId: "job-1", checkpointer }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(f.calls).toEqual(["generate:single-shot", "revise:round-1"]);

    // redelivery: brand-new process (fresh budget object), same thread
    const budget2 = new JobBudget();
    const r = await runQuizGraph({ llm: f.llm, budget: budget2 }, { sourceText: SHORT_DOC, numQuestions: 5, strategy: "single-shot" }, { threadId: "job-1", checkpointer });
    expect(r.resumed).toBe(true);
    expect(f.calls).toEqual(["generate:single-shot", "revise:round-1", "revise:round-1"]); // generate NOT repeated
    expect(r.questions).toHaveLength(5);
    expect(budget2.snapshot().calls).toBeGreaterThanOrEqual(1); // allowance carried over from the checkpoint
  });

  it("a different thread (new job attempt) starts fresh", async () => {
    const f = scripted({ "generate:single-shot": ok(...five) });
    const checkpointer = new MemorySaver();
    const run = (threadId: string) => runQuizGraph({ llm: f.llm, budget: new JobBudget() }, { sourceText: SHORT_DOC, numQuestions: 5, strategy: "single-shot" }, { threadId, checkpointer });
    expect((await run("a")).resumed).toBe(false);
    expect((await run("b")).resumed).toBe(false);
    expect(f.calls).toHaveLength(2);
  });
});


describe("plan-then-write structure and prompt variants", () => {
  const plan = (n: number, quotes?: string[]) =>
    JSON.stringify({ facts: Array.from({ length: n }, (_, i) => ({ topic: `topic ${i}`, quote: quotes?.[i] ?? quoteOf(i), angle: "what it states" })) });

  it("plans first, then writes one question per fact (2 calls, same checks afterwards)", async () => {
    const f = scripted({ plan: plan(7), "generate:write": (m) => ok(...[0, 1, 2, 3, 4].map((i) => q(i))) });
    const r = await runQuizGraph({ llm: f.llm, budget: new JobBudget() }, { sourceText: SHORT_DOC, numQuestions: 5, strategy: "single-shot", planFirst: true });
    expect(f.calls).toEqual(["plan", "generate:write"]);
    expect(r.questions).toHaveLength(5);
    expect(r.trail).toEqual(expect.arrayContaining(["plan:5 facts", "generate:plan-write"]));
  });

  it("drops planned facts whose quote is not in the document and asks for extra ones", async () => {
    const quotes = [0, 1, 2, 3, 4, 5, 6].map(quoteOf);
    quotes[1] = "an invented sentence that is nowhere in the source";
    let planPrompt = "";
    let writePrompt = "";
    const f = scripted({
      plan: (m) => ((planPrompt = m.find((x) => x.role === "user")!.content), plan(7, quotes)),
      "generate:write": (m) => ((writePrompt = m.find((x) => x.role === "user")!.content), ok(...[0, 1, 2, 3, 4].map((i) => q(i)))),
    });
    await runQuizGraph({ llm: f.llm, budget: new JobBudget() }, { sourceText: SHORT_DOC, numQuestions: 5, strategy: "single-shot", planFirst: true });
    expect(planPrompt).toContain("exactly 7 facts"); // n + 2 spare
    expect(writePrompt).toContain("Write exactly 5 questions");
    expect(writePrompt).not.toContain("invented sentence");
  });

  it("fails as a content error when fewer than 5 planned facts are grounded", async () => {
    const f = scripted({ plan: plan(7, ["nope nope nope nope", "also not there at all", "still invented text here", quoteOf(3), quoteOf(4), "bogus bogus bogus", "missing missing missing"]) });
    await expect(runQuizGraph({ llm: f.llm, budget: new JobBudget() }, { sourceText: SHORT_DOC, numQuestions: 5, planFirst: true })).rejects.toBeInstanceOf(QualityGateError);
  });

  it("promptVariant only appends guidance: baseline is the production prompt, the others extend it", async () => {
    const { GENERATION_SYSTEM, generationSystem, PROMPT_VARIANTS } = await import("./prompts.js");
    expect(generationSystem()).toBe(GENERATION_SYSTEM);
    expect(generationSystem("baseline")).toBe(GENERATION_SYSTEM);
    for (const v of PROMPT_VARIANTS.filter((x) => x !== "baseline")) {
      const s = generationSystem(v);
      expect(s.startsWith(GENERATION_SYSTEM)).toBe(true); // the JSON contract and safety rules are untouched
      expect(s.length).toBeGreaterThan(GENERATION_SYSTEM.length);
    }
  });

  it("the chosen variant reaches the model as the system prompt", async () => {
    let system = "";
    const f = scripted({ "generate:single-shot": (m) => ((system = m.find((x) => x.role === "system")!.content), ok(...five)) });
    await runQuizGraph({ llm: f.llm, budget: new JobBudget() }, { sourceText: SHORT_DOC, numQuestions: 5, strategy: "single-shot", promptVariant: "conceptual" });
    expect(system).toContain("understanding over trivia");
  });
});
