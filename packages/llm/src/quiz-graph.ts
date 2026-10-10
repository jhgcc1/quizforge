import { Annotation, END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { z } from "zod";
import {
  GeneratedQuestionSchema,
  GeneratedQuizSchema,
  MIN_QUESTIONS,
  checkGrounding,
  type GeneratedQuestion,
} from "@quizforge/core";
import { JobBudget, emptyUsage, type BudgetState, type Usage } from "./budget.js";
import { NonRetryableError, StructuredOutputError } from "./errors.js";
import type { LlmClient } from "./llm.js";
import {
  CRITIQUE_SYSTEM,
  PLAN_SYSTEM,
  REVISE_SYSTEM,
  critiqueUser,
  generationSystem,
  planUser,
  reviseUser,
  sectionUser,
  singleShotUser,
  writeUser,
  type PromptVariant,
} from "./prompts.js";
import { chooseStrategy, type Strategy } from "./router.js";
import { lintQuestion } from "./lint.js";
import { pickSections, selectQuestions, sortByDifficulty } from "./select.js";
import { splitSections } from "./source.js";
import { quizReplyCheck } from "./output-guard.js";
import { generateStructured } from "./structured.js";

export type StrategyRequest = "auto" | Strategy;

export interface QuizGraphInput {
  sourceText: string;
  numQuestions: number;
  topic?: string | undefined;
  strategy?: StrategyRequest;
  /** Run the critique -> revise stage. */
  critique?: boolean;
  /** Generator prompt (default `baseline` = production). */
  promptVariant?: PromptVariant;
  /** "plan-then-write": plan the facts to test first, then write one question per fact (instead of generating directly). */
  planFirst?: boolean;
}

export interface PlannedFact {
  topic: string;
  quote: string;
  angle: string;
}

export interface QuizGraphDeps {
  llm: LlmClient;
  budget: JobBudget;
  /** Max critique/revise rounds. */
  maxRounds?: number;
  /** Concurrent section calls in map-reduce. */
  concurrency?: number;
  /** Sections sampled by map-reduce (each yields 2 candidates). */
  mapSections?: number;
}

/** Quality gate failed even after revisions (e.g. a quote that is not in the document). Retryable at job level. */
export class QualityGateError extends Error {
  constructor(
    message: string,
    readonly ungrounded: number[],
  ) {
    super(message);
    this.name = "QualityGateError";
  }
}

const MAX_SINGLE_SHOT_CHARS = 60_000;
const PLAN_EXTRA_FACTS = 2; // ask for a few more than needed: facts whose quote is not in the document are dropped

const State = Annotation.Root({
  input: Annotation<QuizGraphInput>(),
  strategy: Annotation<Strategy | undefined>(),
  routeReason: Annotation<string>(),
  context: Annotation<string>(),
  questions: Annotation<GeneratedQuestion[]>(),
  facts: Annotation<PlannedFact[]>(),
  /** 1-based question index -> open issues. */
  issues: Annotation<Record<number, string[]>>(),
  round: Annotation<number>(),
  repairs: Annotation<number>(),
  usage: Annotation<Usage>(),
  budget: Annotation<BudgetState | undefined>(),
  trail: Annotation<string[]>(),
});
type S = typeof State.State;

const Verdicts = z.object({
  verdicts: z.array(z.object({ index: z.number().int(), ok: z.boolean(), issues: z.array(z.string()).default([]) })),
});

const addUsage = (a: Usage, b: Usage): Usage => ({
  promptTokens: a.promptTokens + b.promptTokens,
  completionTokens: a.completionTokens + b.completionTokens,
  cachedTokens: a.cachedTokens + b.cachedTokens,
});

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/**
 * generate -> check -> [critique] -> revise (loop) -> done
 *
 * Strategy `single-shot` sends the whole document once; `section-map-reduce` samples sections,
 * asks for 2 candidates each in parallel, then selects deterministically. The deterministic gate
 * (schema, duplicates, verbatim sourceQuote) always runs; the LLM critic is optional.
 */
export function buildQuizGraph(deps: QuizGraphDeps, checkpointer?: BaseCheckpointSaver) {
  const maxRounds = deps.maxRounds ?? 2;
  const track = (u: Usage, s: S) => ({ usage: addUsage(s.usage, u), budget: deps.budget.snapshot() });

  const route = async (s: S): Promise<Partial<S>> => {
    const requested = s.input.strategy ?? "auto";
    if (requested !== "auto") {
      return { strategy: requested, routeReason: `requested: ${requested}`, trail: [...s.trail, `route:${requested}`] };
    }
    const d = chooseStrategy(s.input.sourceText);
    return { strategy: d.strategy, routeReason: d.reason, trail: [...s.trail, `route:${d.strategy}`] };
  };

  const generate = async (s: S): Promise<Partial<S>> => {
    const { sourceText, numQuestions: n, topic } = s.input;
    if (s.strategy === "section-map-reduce") {
      const sections = pickSections(splitSections(sourceText), deps.mapSections ?? 5, topic);
      if (sections.length === 0) throw new NonRetryableError("document has no usable sections");
      const Candidates = z.object({ questions: z.array(GeneratedQuestionSchema).min(1).max(4) });
      let usage = emptyUsage();
      let repairs = 0;
      const results = await mapLimit(sections, deps.concurrency ?? 3, async (sec) => {
        const r = await generateStructured({
          llm: deps.llm,
          budget: deps.budget,
          schema: Candidates,
          system: generationSystem(s.input.promptVariant),
          user: sectionUser({ heading: sec.heading, text: sec.text, n: 2, topic }),
          options: { name: `generate:section:${sec.heading.slice(0, 40)}`, temperature: 0.4 },
          check: quizReplyCheck(sourceText),
        });
        usage = addUsage(usage, r.usage);
        repairs += r.repairs;
        return r.value.questions;
      });
      const chosen = selectQuestions(results, n);
      if (chosen.length < n) throw new StructuredOutputError(`only ${chosen.length}/${n} distinct questions produced`, "", 1);
      return {
        questions: chosen,
        context: sections.map((x) => `## ${x.heading}\n${x.text}`).join("\n\n"),
        repairs: s.repairs + repairs,
        ...track(usage, s),
        trail: [...s.trail, `generate:map-reduce(${sections.length} sections)`],
      };
    }
    const doc = sourceText.length > MAX_SINGLE_SHOT_CHARS ? sourceText.slice(0, MAX_SINGLE_SHOT_CHARS) : sourceText;
    const Quiz = z.object({ questions: z.array(GeneratedQuestionSchema).length(n) });
    const r = await generateStructured({
      llm: deps.llm,
      budget: deps.budget,
      schema: Quiz,
      system: generationSystem(s.input.promptVariant),
      user: singleShotUser({ doc, n, topic }),
      options: { name: "generate:single-shot", temperature: 0.4 },
      check: quizReplyCheck(sourceText),
    });
    return {
      questions: sortByDifficulty(r.value.questions),
      context: doc,
      repairs: s.repairs + r.repairs,
      ...track(r.usage, s),
      trail: [...s.trail, "generate:single-shot"],
    };
  };

  /** plan-then-write, step 1: choose the facts to test; facts whose quote is not in the document are dropped here. */
  const plan = async (s: S): Promise<Partial<S>> => {
    const { sourceText, numQuestions: n, topic } = s.input;
    const doc = sourceText.length > MAX_SINGLE_SHOT_CHARS ? sourceText.slice(0, MAX_SINGLE_SHOT_CHARS) : sourceText;
    const Plan = z.object({ facts: z.array(z.object({ topic: z.string().min(1), quote: z.string().min(1), angle: z.string().min(1) })).min(n) });
    const r = await generateStructured({
      llm: deps.llm,
      budget: deps.budget,
      schema: Plan,
      system: PLAN_SYSTEM,
      user: planUser({ doc, n: n + PLAN_EXTRA_FACTS, topic }),
      options: { name: "plan", temperature: 0.3 },
    });
    const probe = r.value.facts.map((f) => ({ sourceQuote: f.quote }));
    const grounded = checkGrounding({ questions: probe }, sourceText);
    const facts = r.value.facts.filter((_, i) => !grounded.ungrounded.includes(i + 1)).slice(0, n);
    if (facts.length < MIN_QUESTIONS) throw new QualityGateError(`plan produced only ${facts.length} fact(s) quoted from the document`, grounded.ungrounded);
    return { facts, context: doc, repairs: s.repairs + r.repairs, ...track(r.usage, s), trail: [...s.trail, `plan:${facts.length} facts`] };
  };

  /** plan-then-write, step 2: one question per planned fact. */
  const write = async (s: S): Promise<Partial<S>> => {
    const Quiz = z.object({ questions: z.array(GeneratedQuestionSchema).length(s.facts.length) });
    const r = await generateStructured({
      llm: deps.llm,
      budget: deps.budget,
      schema: Quiz,
      system: generationSystem(s.input.promptVariant),
      user: writeUser({ doc: s.context, facts: s.facts }),
      options: { name: "generate:write", temperature: 0.4 },
      check: quizReplyCheck(s.input.sourceText),
    });
    return { questions: sortByDifficulty(r.value.questions), repairs: s.repairs + r.repairs, ...track(r.usage, s), trail: [...s.trail, "generate:plan-write"] };
  };

  /** Deterministic gate: duplicates and verbatim grounding. Resets deterministic issues each pass. */
  const check = async (s: S): Promise<Partial<S>> => {
    const issues: Record<number, string[]> = {};
    const add = (i: number, msg: string) => (issues[i] = [...(issues[i] ?? []), msg]);
    const grounding = checkGrounding({ questions: s.questions }, s.input.sourceText);
    for (const i of grounding.ungrounded) add(i, "sourceQuote is not an exact excerpt of the document; copy it verbatim");
    s.questions.forEach((q, i) => lintQuestion(q).forEach((m) => add(i + 1, m)));
    const parsed = GeneratedQuizSchema.safeParse({ questions: s.questions });
    if (!parsed.success) {
      for (const iss of parsed.error.issues) {
        const idx = iss.path[0] === "questions" && typeof iss.path[1] === "number" ? iss.path[1] + 1 : undefined;
        if (idx && /duplicate|distinct/.test(iss.message)) add(idx, iss.message);
      }
    }
    return { issues, trail: [...s.trail, `check:${Object.keys(issues).length} flagged`] };
  };

  const critique = async (s: S): Promise<Partial<S>> => {
    const r = await generateStructured({
      llm: deps.llm,
      budget: deps.budget,
      schema: Verdicts,
      system: CRITIQUE_SYSTEM,
      user: critiqueUser({ context: s.context, questionsJson: JSON.stringify(s.questions.map(toReview), null, 1) }),
      options: { name: "critique", temperature: 0 },
    });
    const issues = { ...s.issues };
    for (const v of r.value.verdicts) {
      if (!v.ok && v.issues.length > 0 && v.index >= 1 && v.index <= s.questions.length) {
        issues[v.index] = [...(issues[v.index] ?? []), ...v.issues];
      }
    }
    return { issues, repairs: s.repairs + r.repairs, ...track(r.usage, s), trail: [...s.trail, `critique:${Object.keys(issues).length} flagged`] };
  };

  const revise = async (s: S): Promise<Partial<S>> => {
    const indexes = Object.keys(s.issues).map(Number).sort((a, b) => a - b);
    const flagged = indexes.map((index) => ({ index, question: toReview(s.questions[index - 1]!), issues: s.issues[index]! }));
    const Revised = z.object({ questions: z.array(GeneratedQuestionSchema).length(flagged.length) });
    const r = await generateStructured({
      llm: deps.llm,
      budget: deps.budget,
      schema: Revised,
      system: REVISE_SYSTEM,
      user: reviseUser({ context: s.context, flagged }),
      options: { name: `revise:round-${s.round + 1}`, temperature: 0.3 },
      check: quizReplyCheck(s.input.sourceText),
    });
    const questions = [...s.questions];
    indexes.forEach((qi, k) => (questions[qi - 1] = r.value.questions[k]!));
    return { questions, round: s.round + 1, repairs: s.repairs + r.repairs, ...track(r.usage, s), trail: [...s.trail, `revise:round-${s.round + 1}`] };
  };

  const finalize = async (s: S): Promise<Partial<S>> => {
    const ungrounded = checkGrounding({ questions: s.questions }, s.input.sourceText).ungrounded;
    if (ungrounded.length === 0) return { trail: [...s.trail, "finalize"] };

    // Graceful degradation: a question whose quote cannot be found after the revision rounds is DROPPED (never shown)
    // when enough grounded ones remain, so the user gets a slightly shorter quiz instead of an error.
    const kept = s.questions.filter((_, i) => !ungrounded.includes(i + 1));
    if (kept.length >= MIN_QUESTIONS) {
      return { questions: kept, trail: [...s.trail, `finalize:dropped-${ungrounded.length}-ungrounded`] };
    }
    const quotes = ungrounded.map((i) => `#${i} "${s.questions[i - 1]!.sourceQuote.slice(0, 80)}"`).join("; ");
    throw new QualityGateError(`only ${kept.length} grounded question(s) after ${s.round} revision round(s); not found in the document: ${quotes}`, ungrounded);
  };

  const afterCheck = (s: S) => (s.input.critique && s.trail.every((t) => !t.startsWith("critique")) ? "critique" : decide(s));
  const decide = (s: S) => (Object.keys(s.issues).length > 0 && s.round < maxRounds ? "revise" : "finalize");

  return new StateGraph(State)
    .addNode("route", route)
    .addNode("generate", generate)
    .addNode("plan", plan)
    .addNode("write", write)
    .addNode("check", check)
    .addNode("critique", critique)
    .addNode("revise", revise)
    .addNode("finalize", finalize)
    .addEdge(START, "route")
    .addConditionalEdges("route", (s: S) => (s.input.planFirst ? "plan" : "generate"), ["plan", "generate"])
    .addEdge("plan", "write")
    .addEdge("write", "check")
    .addEdge("generate", "check")
    .addConditionalEdges("check", afterCheck, ["critique", "revise", "finalize"])
    .addConditionalEdges("critique", decide, ["revise", "finalize"])
    .addEdge("revise", "check")
    .addEdge("finalize", END)
    .compile(checkpointer ? { checkpointer } : {});
}

const toReview = (q: GeneratedQuestion) => ({
  prompt: q.prompt,
  options: q.options,
  correct: q.correct,
  explanation: q.explanation,
  sourceQuote: q.sourceQuote,
});

export interface QuizGraphResult {
  questions: GeneratedQuestion[];
  strategy: Strategy;
  routeReason: string;
  rounds: number;
  repairs: number;
  usage: Usage;
  trail: string[];
  budget: BudgetState;
  /** True when this run continued from a checkpoint of an earlier, interrupted attempt. */
  resumed: boolean;
}

export async function runQuizGraph(
  deps: QuizGraphDeps,
  input: QuizGraphInput,
  config?: { threadId?: string; checkpointer?: BaseCheckpointSaver; callbacks?: unknown[]; metadata?: Record<string, unknown> },
): Promise<QuizGraphResult> {
  const graph = buildQuizGraph(deps, config?.checkpointer);
  const runConfig = {
    configurable: { thread_id: config?.threadId ?? "local" },
    ...(config?.callbacks ? { callbacks: config.callbacks as never } : {}),
    ...(config?.metadata ? { metadata: config.metadata } : {}),
  };

  let out: Awaited<ReturnType<typeof graph.invoke>> | undefined;
  let resumed = false;
  if (config?.checkpointer) {
    // A previous attempt of this same job may have died mid-graph: continue from its last
    // checkpoint instead of paying again for the LLM calls that already succeeded.
    const snap = await graph.getState(runConfig);
    if (snap.next.length > 0) {
      const saved = snap.values.budget as BudgetState | undefined;
      if (saved) deps.budget.restore(saved);
      out = await graph.invoke(null, runConfig);
      resumed = true;
    }
  }
  out ??= await graph.invoke(
    { input, routeReason: "", context: "", questions: [], facts: [], issues: {}, round: 0, repairs: 0, usage: emptyUsage(), trail: [] },
    runConfig,
  );
  return {
    questions: out.questions,
    strategy: out.strategy!,
    routeReason: out.routeReason,
    rounds: out.round,
    repairs: out.repairs,
    usage: out.usage,
    trail: out.trail,
    budget: deps.budget.snapshot(),
    resumed,
  };
}
