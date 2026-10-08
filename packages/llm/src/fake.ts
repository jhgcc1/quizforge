import type { Usage } from "./budget.js";
import type { ChatMessage, CompleteOptions, LlmClient, LlmResponse } from "./llm.js";

/**
 * Deterministic stand-in for the real model, used by tests, CI and offline demos (LLM_MODE=fake).
 * It reads the <document> from the prompt and builds grounded questions from its own sentences, so
 * the whole pipeline (graph, gates, DB, scoring, UI) runs without network or secrets.
 */
const USAGE: Usage = { promptTokens: 100, completionTokens: 50, cachedTokens: 0 };

const sentencesOf = (doc: string, minWords: number): string[] =>
  doc
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`#>|]/g, " ").replace(/\s+/g, " ").replace(/^[^\p{L}\p{N}]+/u, "").replace(/^\d+[.)]\s+/, "").trim())
    .filter((s) => s.split(" ").length >= minWords && s.length <= 180);

function makeQuestions(doc: string, n: number) {
  // Link-heavy sections have few full sentences: relax the minimum length until there is enough material.
  let sents: string[] = [];
  for (const minWords of [6, 4, 3]) {
    sents = [...new Set(sentencesOf(doc, minWords))];
    if (sents.length >= n) break;
  }
  if (sents.length < n) throw new Error(`fake llm: document has only ${sents.length} usable sentences`);
  const step = Math.max(1, Math.floor(sents.length / n));
  return Array.from({ length: n }, (_, i) => {
    const s = sents[Math.min(i * step, sents.length - 1)]!;
    const words = s.split(" ");
    const distractors = [words.slice().reverse().join(" "), `It is not true that ${s.charAt(0).toLowerCase()}${s.slice(1)}`, words.slice(0, Math.ceil(words.length / 2)).join(" ") + " and nothing else"];
    const correctPos = i % 4;
    const options = [...distractors];
    options.splice(correctPos, 0, s);
    return {
      prompt: `Which statement, starting with "${words.slice(0, 3).join(" ")}", appears in the document? (${i + 1})`,
      options,
      correct: [correctPos],
      explanation: `The document states: ${s}`,
      sourceQuote: words.slice(0, Math.min(words.length, 10)).join(" "),
      difficulty: (["easy", "medium", "hard"] as const)[i % 3],
    };
  });
}

export function createFakeLlm(): LlmClient {
  return {
    model: "fake-llm",
    async complete(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<LlmResponse> {
      const name = opts.name ?? "";
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      const doc = /<document(?: section="[^\n]*")?>\n([\s\S]*?)\n<\/document>/.exec(user)?.[1] ?? "";
      const reply = (v: unknown): LlmResponse => ({ text: `<think>fake reasoning</think>\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``, usage: USAGE });

      if (name.startsWith("generate:single-shot")) {
        const n = Number(/exactly (\d+) questions/.exec(user)?.[1] ?? 6);
        return reply({ questions: makeQuestions(doc, n) });
      }
      if (name.startsWith("generate:section")) return reply({ questions: makeQuestions(doc, 2) });
      if (name === "plan") {
        const n = Number(/Choose exactly (\d+) facts/.exec(user)?.[1] ?? 6);
        const facts = makeQuestions(doc, n).map((q) => ({ topic: q.sourceQuote.split(" ").slice(0, 3).join(" "), quote: q.sourceQuote, angle: "what the document states" }));
        return reply({ facts });
      }
      if (name.startsWith("generate:write")) {
        const facts = JSON.parse(/Planned facts:\n([\s\S]*?)\n\n<document>/.exec(user)?.[1] ?? "[]") as { quote: string }[];
        const base = makeQuestions(doc, Math.max(facts.length, 1));
        return reply({ questions: facts.map((f, i) => ({ ...base[i % base.length]!, sourceQuote: f.quote })) });
      }
      if (name.startsWith("critique")) {
        const count = (user.match(/"prompt"/g) ?? []).length;
        return reply({ verdicts: Array.from({ length: count }, (_, i) => ({ index: i + 1, ok: true, issues: [] })) });
      }
      if (name.startsWith("judge")) {
        return reply({ faithfulness: 4, clarity: 4, distractors: 3, coverage: 4, difficulty_mix: 4, reasoning: "fake judge" });
      }
      throw new Error(`fake llm: unexpected call ${name}`);
    },
  };
}
