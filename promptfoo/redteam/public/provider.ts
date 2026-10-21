/**
 * promptfoo provider of the PUBLIC dataset cases (see docs/redteam-nightly.md). One case = one document; `vars.stage` says what to do:
 *
 *   A, benign, foreign   the layers before the model only (guard, language policy, Prompt Guard 2): no model call, no cost
 *   blocked              the whole pipeline with a COUNTING FAKE model: the document must be rejected before the model (llmCalls = 0)
 *   B, E                 the whole pipeline with the REAL model (the same provider as the replay); the quiz is judged by the code oracle
 *                        of replay/filter.ts (did the quiz obey the paragraph?). E = an encoded text (it should stop at the guard)
 *
 * The output is JSON text (see PublicOutput). Nothing here decides pass or fail: the nightly REPORTS (aggregate.ts); assertions only catch a broken harness.
 */
import { createFakeLlm, generateQuiz, UnsafeDocumentError, UnsupportedLanguageError, InvalidLlmInputError, type InjectionDetector, type LlmClient } from "@quizforge/llm";
import QuizPipelineProvider, { loadDetector } from "../../provider.js";
import { judgeQuiz, outcomeOf, type QuizQuestion } from "../lib/filter.js";
import { demandedPhrasesPtEs } from "../lib/ptes-data.js";
import { layersOf, type Layers } from "./stage.js";

export interface PublicVars {
  kind: "public";
  stage: "A" | "B" | "E" | "blocked" | "foreign" | "benign";
  id: string;
  dataset: string;
  language: string;
  text: string;
  document: string;
  paragraph?: string;
  clean?: string;
  readmeLanguage?: string;
  encoding?: string;
}

export interface PublicOutput {
  stage: PublicVars["stage"];
  id: string;
  dataset: string;
  language: string;
  /** Pipeline status (quiz, blocked, rejected_language, detector_blocked, no_quiz, error...) or "layers" for the cases that never call the pipeline. */
  status: string;
  /** rejected_before_model | rejected_by_rails | quiz | error (replay/filter.ts) for the pipeline cases. */
  outcome?: string;
  llmCalls?: number;
  layers: Layers;
  contaminated?: boolean;
  reasons?: string[];
  /** Only for a contaminated quiz: what the quiz said (cut). */
  quiz?: string;
  reason?: string;
}

const countingFake = (): { llm: LlmClient; calls: () => number } => {
  const fake = createFakeLlm();
  let calls = 0;
  return { llm: { model: fake.model, complete: (m, o) => (calls++, fake.complete(m, o)) }, calls: () => calls };
};

/** The whole pipeline with a fake model that counts its calls: what happens to a document BEFORE (and if) it reaches the model. */
export async function pipelineWithFake(document: string): Promise<{ status: string; llmCalls: number; reason?: string }> {
  const { llm, calls } = countingFake();
  try {
    await generateQuiz({ llm, input: { sourceText: document, numQuestions: 5, strategy: "single-shot", critique: false }, judge: false, score: false });
    return { status: "quiz", llmCalls: calls() };
  } catch (err) {
    const status = err instanceof UnsafeDocumentError ? "blocked" : err instanceof UnsupportedLanguageError ? "rejected_language" : err instanceof InvalidLlmInputError ? "invalid_input" : err instanceof Error && err.message.startsWith("fake llm:") ? "fake_limit" : "error";
    return { status, llmCalls: calls(), reason: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }
}

export default class PublicProvider {
  private detector: Promise<InjectionDetector | undefined> | undefined;
  private live: QuizPipelineProvider | undefined;

  constructor(private readonly deps: { detector?: InjectionDetector | undefined; live?: Pick<QuizPipelineProvider, "callApi"> } = {}) {}

  id(): string {
    return "quizforge-public-datasets";
  }

  private getDetector(): Promise<InjectionDetector | undefined> {
    return (this.detector ??= this.deps.detector ? Promise.resolve(this.deps.detector) : loadDetector().then((d) => d?.detector));
  }

  private async pipeline(v: PublicVars, detector: InjectionDetector | undefined): Promise<{ status: string; llmCalls: number; questions?: QuizQuestion[]; reason?: string }> {
    let provider: Pick<QuizPipelineProvider, "callApi"> | undefined = this.deps.live;
    if (!provider) {
      this.live ??= new QuizPipelineProvider({ config: { mode: "live" } });
      // one detector for the whole process (a second copy of the model would cost another 350 MB)
      if (detector) (this.live as unknown as { detector: Promise<unknown> }).detector = Promise.resolve({ detector, mode: "block" });
      provider = this.live;
    }
    const { output } = await provider.callApi("", { vars: { kind: "redteam", id: v.id, prompt: v.paragraph ?? "", document: v.document, lang: v.readmeLanguage ?? v.language } });
    return JSON.parse(output) as { status: string; llmCalls: number; questions?: QuizQuestion[]; reason?: string };
  }

  async callApi(_prompt: string, context: { vars: PublicVars }): Promise<{ output: string }> {
    const v = context.vars;
    const detector = await this.getDetector();
    const out: PublicOutput = { stage: v.stage, id: v.id, dataset: v.dataset, language: v.language, status: "layers", layers: await layersOf(v.document, detector) };
    try {
      if (v.stage === "blocked") {
        const r = await pipelineWithFake(v.document);
        Object.assign(out, { status: r.status, llmCalls: r.llmCalls, outcome: outcomeOf(r.status, r.reason ?? ""), ...(r.reason ? { reason: r.reason } : {}) });
      } else if (v.stage === "B" || v.stage === "E") {
        const r = await this.pipeline(v, detector);
        const outcome = outcomeOf(r.status, r.reason ?? "");
        Object.assign(out, { status: r.status, llmCalls: r.llmCalls, outcome, ...(r.reason ? { reason: r.reason } : {}) });
        if (r.status === "quiz" && r.questions) {
          const attack = v.text.replace(/\s+/g, " ").trim();
          const demanded = v.language === "en" ? [] : demandedPhrasesPtEs(v.text);
          const verdict = judgeQuiz(r.questions, attack, v.clean ?? "", v.readmeLanguage ?? v.language, demanded);
          out.contaminated = verdict.contaminated;
          out.reasons = verdict.reasons.slice(0, 6);
          if (verdict.contaminated) out.quiz = r.questions.map((q) => q.prompt).join(" | ").slice(0, 600);
        }
      }
    } catch (err) {
      out.status = "error";
      out.reason = err instanceof Error ? err.message.slice(0, 300) : String(err);
    }
    return { output: JSON.stringify(out) };
  }
}
