import { INJECTION_RULES, MODEL_MARKUP, type GeneratedQuestion } from "@quizforge/core";
import { UnsafeOutputError } from "./errors.js";
import { firstBalancedJson, stripThink } from "./json.js";
import { CRITIQUE_SYSTEM, GENERATION_SYSTEM, JUDGE_SYSTEM, PLAN_SYSTEM, REVISE_SYSTEM } from "./prompts.js";

/**
 * Output rails: deterministic checks (no second model) on what the model returned, BEFORE it is stored or shown.
 * Zod already guarantees the SHAPE (4 distinct options, valid answer indexes, lengths). These checks answer a different question:
 * "is this really a quiz about the document, in the format we asked for, and nothing else?"
 *
 *   reply format    the reply is the JSON object and (almost) nothing else
 *   prompt leak     no 8-word run of our own system prompts in the reply
 *   markup          no script, iframe, event handler, chat-template token (unless the document itself has it)
 *   links           no link to a site that is not in the document
 *   echoed attack   no instruction-like sentence that is not in the document
 *   looks like a quiz  most prompts are questions or "complete / select" tasks
 *
 * The first problem list goes back to the model for ONE repair round (see structured.ts, `check`); anything left after the
 * generation is rejected by `assertQuizOutput`.
 */

const WORDS = (s: string): string[] => s.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const SHINGLE = 8;
const MAX_TEXT_OUTSIDE_JSON = 200;

let shingles: Set<string> | undefined;
function systemShingles(): Set<string> {
  if (!shingles) {
    shingles = new Set();
    for (const p of [GENERATION_SYSTEM, CRITIQUE_SYSTEM, REVISE_SYSTEM, PLAN_SYSTEM, JUDGE_SYSTEM]) {
      const w = WORDS(p);
      for (let i = 0; i + SHINGLE <= w.length; i++) shingles.add(w.slice(i, i + SHINGLE).join(" "));
    }
  }
  return shingles;
}

/** An 8-word run of our own system prompts found in `text` (the model is repeating its instructions), if any. */
export function leakedPromptText(text: string): string | undefined {
  const w = WORDS(text);
  const set = systemShingles();
  for (let i = 0; i + SHINGLE <= w.length; i++) {
    const key = w.slice(i, i + SHINGLE).join(" ");
    if (set.has(key)) return key;
  }
  return undefined;
}

const QUESTION_START = /^(which|what|how|why|when|where|who|whom|whose|is|are|does|do|did|can|could|should|would|will|select|choose|identify|complete|match|according|in which|true or false|qual|quais|que|como|por que|quando|onde|quem|quanto|selecione|escolha|identifique|complete|de acordo|cu[aá]l|cu[aá]les|qu[eé]|c[oó]mo|por qu[eé]|cu[aá]ndo|d[oó]nde|qui[eé]n|cu[aá]nto|seleccione|elija|identifique|seg[uú]n)\b/iu;

/** A quiz prompt is a question, or an explicit task ("Select all…", "Complete the sentence:"). */
export function looksLikeQuestion(prompt: string): boolean {
  const p = prompt.trim();
  return p.includes("?") || /[¿]/.test(p) || /[:…]\s*$/.test(p) || /\.\.\.\s*$/.test(p) || QUESTION_START.test(p) || /\bselect all\b|\bselecione todas\b|\bselecciona todas\b/i.test(p);
}

const MARKUP = /<\s*(script|iframe|object|embed|img|svg|style|link|meta|form|input)\b|javascript:|data:\s*text\/html|\bon[a-z]{3,}\s*=\s*["']|<\|[a-z_]+\|>|\[\/?INST\]|<<\/?SYS>>/gi;
const URL_RE = /https?:\/\/[^\s)"'<>\]]+/gi;

/**
 * Rules used on the REPLY. The loose "mentions the system prompt" rules are left out: a quiz about an AI agent framework legitimately
 * says "the system prompt defines the agent's behaviour". Everything that gives an ORDER is kept.
 */
const ECHO_RULES = INJECTION_RULES.filter((r) => !/-system-prompt$|what-are-your-instructions$/.test(r.id));

const fieldsOf = (q: GeneratedQuestion): string[] => [q.prompt, ...q.options, q.explanation];

/** What is wrong with these questions as an OUTPUT (empty = fine). `sourceText` is the document they must come from. */
export function quizOutputProblems(questions: readonly GeneratedQuestion[], ctx: { sourceText: string }): string[] {
  const problems: string[] = [];
  const doc = ctx.sourceText.toLowerCase();

  questions.forEach((q, i) => {
    const n = i + 1;
    for (const text of [...fieldsOf(q), q.sourceQuote]) {
      const leak = leakedPromptText(text);
      if (leak) problems.push(`question ${n} repeats the assistant's own instructions ("${leak.slice(0, 40)}…"); write only the quiz`);
    }
    for (const text of fieldsOf(q)) {
      for (const m of text.matchAll(MARKUP)) {
        if (!doc.includes(m[0].toLowerCase())) problems.push(`question ${n} contains markup or script (${m[0].slice(0, 20)}) that is not in the document`);
      }
      for (const m of text.matchAll(URL_RE)) {
        const url = m[0].replace(/[.,;:!?/]+$/, "").toLowerCase();
        // the same site is fine (the model may cite another page of it, or add/remove a trailing slash); a new site is not
        const host = /^https?:\/\/([^/?#:]+)/.exec(url)?.[1] ?? url;
        if (!doc.includes(url) && !doc.includes(host)) problems.push(`question ${n} contains a link to a site that is not in the document (${host.slice(0, 40)})`);
      }
      const lower = text.toLowerCase();
      for (const rule of ECHO_RULES) {
        const hit = rule.re.exec(lower);
        if (hit && !doc.includes(hit[0])) problems.push(`question ${n} contains an instruction that is not in the document ("${hit[0].slice(0, 40)}")`);
      }
    }
  });

  if (questions.length >= 3) {
    const notQuestions = questions.filter((q) => !looksLikeQuestion(q.prompt));
    if (notQuestions.length / questions.length > 0.3) {
      const examples = notQuestions.slice(0, 2).map((q) => `"${q.prompt.slice(0, 70)}"`).join(", ");
      problems.push(`${notQuestions.length} of ${questions.length} prompts are not questions or tasks (for example ${examples}); every prompt must ask something about the document`);
    }
  }
  return [...new Set(problems)].slice(0, 8);
}

/** The reply must be the JSON object and (almost) nothing else, and must not repeat our prompts or chat markers. */
export function replyFormatProblem(raw: string): string | undefined {
  const clean = stripThink(raw).trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(clean);
  const body = fenced ? fenced[1]! : clean;
  const json = firstBalancedJson(body);
  if (json) {
    const outside = (fenced ? clean.replace(fenced[0], "") : body.replace(json, "")).trim();
    if (outside.length > MAX_TEXT_OUTSIDE_JSON) return `Your reply has ${outside.length} characters of text outside the JSON object. Return ONLY the JSON object.`;
  }
  if (MODEL_MARKUP.test(clean)) return "Your reply contains chat-template markers. Return ONLY the JSON object.";
  const leak = leakedPromptText(clean);
  return leak ? "Your reply repeats the assistant's instructions. Return ONLY the JSON object with the quiz." : undefined;
}

/** For `generateStructured({ check })`: the feedback for the repair round, or undefined. */
export function quizReplyCheck(sourceText: string) {
  return (value: { questions: GeneratedQuestion[] }, raw: string): string | undefined => {
    const format = replyFormatProblem(raw);
    if (format) return format;
    const problems = quizOutputProblems(value.questions, { sourceText });
    return problems.length ? `The questions have problems:\n${problems.map((p) => `- ${p}`).join("\n")}\nFix them and return ONLY the corrected JSON object.` : undefined;
  };
}

/** Last line of defence after the whole graph: throws if what is about to be saved is not a clean quiz. */
export function assertQuizOutput(questions: readonly GeneratedQuestion[], ctx: { sourceText: string }): void {
  const problems = quizOutputProblems(questions, ctx);
  if (problems.length) throw new UnsafeOutputError(problems);
}
