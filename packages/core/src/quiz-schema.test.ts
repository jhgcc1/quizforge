import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { GeneratedQuizSchema, checkGrounding, visibleText } from "./quiz-schema.js";

const q = (over: Record<string, unknown> = {}) => ({
  prompt: "Which transport does Pipecat use for real-time audio?",
  options: ["WebRTC", "FTP", "SMTP", "SNMP"],
  correct: [0],
  explanation: "Pipecat supports WebRTC transports.",
  sourceQuote: "It supports WebRTC and websockets",
  difficulty: "easy",
  ...over,
});

const quiz = (n = 5) => ({
  questions: Array.from({ length: n }, (_, i) => q({ prompt: `Question ${i + 1}?` })),
});

describe("GeneratedQuizSchema", () => {
  it("accepts 5..8 questions with 4 options each", () => {
    for (const n of [5, 6, 7, 8]) expect(GeneratedQuizSchema.safeParse(quiz(n)).success).toBe(true);
  });

  it("rejects fewer than 5 or more than 8 questions", () => {
    expect(GeneratedQuizSchema.safeParse(quiz(4)).success).toBe(false);
    expect(GeneratedQuizSchema.safeParse(quiz(9)).success).toBe(false);
  });

  it("requires exactly 4 distinct options", () => {
    const bad = quiz();
    bad.questions[0] = q({ options: ["a", "b", "c"] });
    expect(GeneratedQuizSchema.safeParse(bad).success).toBe(false);
    const dup = quiz();
    dup.questions[0] = q({ options: ["a", "A ", "c", "d"] });
    expect(GeneratedQuizSchema.safeParse(dup).success).toBe(false);
  });

  it("requires at least one correct index, in range and unique", () => {
    for (const correct of [[], [4], [-1], [1, 1]]) {
      const bad = quiz();
      bad.questions[0] = q({ correct });
      expect(GeneratedQuizSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects duplicated questions", () => {
    const bad = quiz();
    bad.questions[1] = q({ prompt: "question 1?" });
    expect(GeneratedQuizSchema.safeParse(bad).success).toBe(false);
  });

  it("derives type from the number of correct answers", () => {
    const parsed = GeneratedQuizSchema.parse({
      questions: [
        q({ prompt: "Single-answer question here?" }),
        q({ prompt: "Multi-answer question here?", correct: [0, 1] }),
        ...quiz(3).questions,
      ],
    });
    expect(parsed.questions[0]!.type).toBe("single");
    expect(parsed.questions[1]!.type).toBe("multiple");
  });
});

describe("checkGrounding", () => {
  const source = "Pipecat is a framework. It supports WebRTC and websockets.\n\nMore text.";
  it("passes when every sourceQuote appears in the document (whitespace/case tolerant)", () => {
    const parsed = GeneratedQuizSchema.parse(quiz());
    expect(checkGrounding(parsed, source)).toEqual({ ok: true, ungrounded: [] });
    const spaced = GeneratedQuizSchema.parse({
      questions: quiz().questions.map((x) => ({ ...x, sourceQuote: "IT SUPPORTS   webrtc and WebSockets" })),
    });
    expect(checkGrounding(spaced, source).ok).toBe(true);
  });

  it("compares visible text: markdown links, emphasis and urls in the source do not break a quote", () => {
    const md = "- [**Agents**](https://mastra.ai/docs/agents): Build autonomous agents that use LLMs and tools.\n- **Workflows**: use `graph-based` engines.";
    const mk = (sourceQuote: string) => GeneratedQuizSchema.parse({ questions: quiz().questions.map((x) => ({ ...x, sourceQuote })) });
    expect(checkGrounding(mk("Agents: Build autonomous agents that use LLMs"), md).ok).toBe(true);
    expect(checkGrounding(mk("Workflows: use graph-based engines"), md).ok).toBe(true);
    expect(checkGrounding(mk("Agents build manual agents that ignore tools"), md).ok).toBe(false); // words/order matter
  });

  it("rejects quotes too short to verify (< 3 words)", () => {
    const parsed = GeneratedQuizSchema.parse({ questions: quiz().questions.map((x) => ({ ...x, sourceQuote: "WebRTC ok" })) });
    expect(checkGrounding(parsed, "WebRTC ok and more words").ok).toBe(false);
  });

  it("flags hallucinated quotes by question position", () => {
    const parsed = GeneratedQuizSchema.parse({
      questions: quiz().questions.map((x, i) =>
        i === 2 ? { ...x, sourceQuote: "uses quantum teleportation" } : x,
      ),
    });
    expect(checkGrounding(parsed, source)).toEqual({ ok: false, ungrounded: [3] });
  });
});

describe("checkGrounding on the real fixtures that failed against the real model", () => {
  const fixture = (name: string) => readFileSync(new URL(`../../../evals/fixtures/${name}`, import.meta.url), "utf8");
  const ok = (quote: string, doc: string) => checkGrounding({ questions: [{ sourceQuote: quote }] }, doc).ok;
  const orbit = fixture("injection-es.md");
  const supabase = fixture("supabase-es.md");
  const shortDoc = fixture("short-doc.md");

  const accepted: [string, string, string][] = [
    ["orbit: truncated mid-word after a sentence join", orbit, "Orbit Scheduler la reintenta hasta cinco veces con espera exponencial. Tras el q..."],
    ["orbit: two adjacent sentences across a line break", orbit, "Orbit Scheduler la reintenta hasta cinco veces con espera exponencial.\nEl primer reintento ocurre a los treinta segundos"],
    ["short-doc: truncated after a sentence join", shortDoc, "Zephyr Cache writes a snapshot to disk every five minutes by default. After a cr..."],
    ["short-doc: adjacent sentences", shortDoc, "every five minutes by default. The snapshot interval can be changed"],
    ["supabase: checklist items with markers", supabase, "- [x] Autenticación y autorización. - [x] API autogeneradas."],
    ["supabase: nested checklist without link labels", supabase, "- [x] API autogeneradas.\n  - [x] REST.\n  - [x] GraphQL.\n  - [x] Suscripciones en tiempo real."],
    ["supabase: checklist with link labels and no markers", supabase, "API autogeneradas. REST. Docs GraphQL. Documentos Suscripciones en tiempo real."],
    ["unicode quotes, dashes, case", "He said \u201cpinned entries\u2014never evicted\u201d here.", "HE SAID \"pinned entries - never evicted\" here"],
  ];
  it.each(accepted)("accepts %s", (_n, doc, quote) => expect(ok(quote, doc)).toBe(true));

  const rejected: [string, string, string][] = [
    ["fabricated words", orbit, "Orbit Scheduler la reintenta hasta cien veces con espera lineal y avisa por correo"],
    ["reordered words", orbit, "con espera exponencial hasta cinco veces la reintenta Orbit Scheduler"],
    ["splice of non-adjacent sentences, no ellipsis", orbit, "Orbit Scheduler la reintenta hasta cinco veces con espera exponencial. Tras el quinto fallo, la tarea se marca como averiada"],
    ["truncated but prefix too short", orbit, "Orbit Scheduler la reintenta hasta cinco... Tras el quinto fallo la tarea"],
    ["truncated with a long unverified tail", orbit, "Orbit Scheduler la reintenta hasta cinco veces con espera exponencial y luego envia un correo a todos los administradores..."],
    ["ellipsis does not rescue a fabricated prefix", orbit, "Orbit Scheduler nunca reintenta ninguna tarea fallida y la descarta de inmediato..."],
    ["too few words", orbit, "Orbit Scheduler"],
    ["checklist marker no longer pads a 2-word quote", supabase, "- [x] API autogeneradas."],
    ["marker-only edits do not invent words", supabase, "[x] API autogeneradas. [x] SOAP. [x] Suscripciones en tiempo real."],
  ];
  it.each(rejected)("rejects %s", (_n, doc, quote) => expect(ok(quote, doc)).toBe(false));

  it("visibleText drops task-list markers but keeps ordinary bracketed words", () => {
    expect(visibleText("- [x] Done\n- [ ] Todo [note] here")).toBe("done todo note here");
  });

  it("property: any contiguous word window of the document is grounded; shuffling it (when it changes) is not", () => {
    const words = visibleText(orbit).split(" ");
    for (let start = 0; start + 6 <= words.length; start += 3) {
      const win = words.slice(start, start + 6);
      expect(ok(win.join(" "), orbit)).toBe(true);
      const rev = [...win].reverse();
      if (rev.join(" ") !== win.join(" ")) expect(ok(rev.join(" "), orbit)).toBe(false);
    }
  });
});
