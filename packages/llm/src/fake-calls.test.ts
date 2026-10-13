import { describe, expect, it } from "vitest";
import { createFakeLlm } from "./fake.js";
import { extractJson } from "./json.js";

const DOC = Array.from({ length: 10 }, (_, i) => `Pipecat component number ${i + 1} handles one specific part of the real time voice pipeline well.`).join("\n\n");
const userMsg = (content: string) => [{ role: "user" as const, content }];
const call = async (name: string, content: string) => extractJson((await createFakeLlm().complete(userMsg(content), { name })).text) as Record<string, unknown>;

describe("fake llm: one call at a time", () => {
  it("plan picks the requested number of facts from the document", async () => {
    const r = await call("plan", `Choose exactly 3 facts.\n<document>\n${DOC}\n</document>`) as { facts: { quote: string }[] };
    expect(r.facts).toHaveLength(3);
    for (const f of r.facts) expect(DOC).toContain(f.quote);
  });

  it("generate:write turns each planned fact into a question quoting that fact", async () => {
    const facts = [{ quote: "Pipecat component number 2 handles one" }, { quote: "Pipecat component number 5 handles one" }];
    const r = await call("generate:write", `Planned facts:\n${JSON.stringify(facts)}\n\n<document>\n${DOC}\n</document>`) as { questions: { sourceQuote: string }[] };
    expect(r.questions.map((q) => q.sourceQuote)).toEqual(facts.map((f) => f.quote));
  });

  it("generate:write without a fact list returns no questions", async () => {
    expect(await call("generate:write", `<document>\n${DOC}\n</document>`)).toEqual({ questions: [] });
  });

  it("critique approves every question it can see, and judge returns fixed scores", async () => {
    const c = await call("critique", `{"prompt": "a"} {"prompt": "b"}`) as { verdicts: { index: number; ok: boolean }[] };
    expect(c.verdicts).toEqual([{ index: 1, ok: true, issues: [] }, { index: 2, ok: true, issues: [] }]);
    const j = await call("judge:faithfulness", "x");
    expect(j).toMatchObject({ faithfulness: 4, distractors: 3 });
  });

  it("generate:single-shot defaults to 6 questions and generate:section to 2", async () => {
    expect((await call("generate:single-shot", `<document>\n${DOC}\n</document>`) as { questions: unknown[] }).questions).toHaveLength(6);
    expect((await call("generate:section", `<document section="A">\n${DOC}\n</document>`) as { questions: unknown[] }).questions).toHaveLength(2);
  });

  it("fails loudly on a call it does not know, and on a document that is too short", async () => {
    await expect(createFakeLlm().complete(userMsg("x"), { name: "mystery" })).rejects.toThrow(/unexpected call mystery/);
    await expect(createFakeLlm().complete(userMsg("<document>\nToo short.\n</document>"), { name: "generate:section" })).rejects.toThrow(/usable sentences/);
    await expect(createFakeLlm().complete([], {})).rejects.toThrow(/unexpected call/);
  });
});
