import { checkShortText, inspectText, blockReason, type Finding } from "@quizforge/core";
import { z } from "zod";
import { InvalidLlmInputError, UnsafeDocumentError } from "./errors.js";
import { assertAllowedLanguage, SUPPORTED_LANGUAGES, type Lang, type SupportedLanguage } from "./language.js";
import type { ChatMessage, CompleteOptions, LlmClient, LlmResponse } from "./llm.js";
import { PROMPT_VARIANTS } from "./prompts.js";
import type { QuizGraphInput } from "./quiz-graph.js";

/**
 * The only way text reaches a model. Two doors, both strict (zod, no extra keys):
 *
 *   1. `admitDocument` / `parseQuizInput`: what a quiz request may contain (document, number of questions, topic, strategy).
 *      The document is inspected (hidden or encoded text -> rejected), its language must be a supported one, and the
 *      sanitized text is what continues.
 *   2. `guardLlm`: wraps a model client so that EVERY call (generation, critique, judge, planning...) is validated again:
 *      shape of the messages, size, and the same inspection on everything that is not the system prompt.
 *
 * So even a bug in a caller cannot send an unchecked string to the provider.
 */

export const MAX_DOCUMENT_CHARS = 600_000;
export const MAX_PROMPT_CHARS = 700_000;

export const QuizInputSchema = z
  .object({
    sourceText: z.string().min(1).max(MAX_DOCUMENT_CHARS),
    numQuestions: z.number().int().min(5).max(8),
    topic: z
      .string()
      .trim()
      .min(2)
      .max(200)
      .refine((t) => checkShortText(t) === undefined, "topic must be plain text on one line")
      .optional(),
    strategy: z.enum(["auto", "single-shot", "section-map-reduce"]).optional(),
    critique: z.boolean().optional(),
    promptVariant: z.enum(PROMPT_VARIANTS as [string, ...string[]]).optional(),
    planFirst: z.boolean().optional(),
  })
  .strict();

export interface AdmittedDocument {
  /** Sanitized text: use this, not the original. */
  text: string;
  language: Lang;
  /** sanitize and flag findings (a block throws instead). For logs and metrics. */
  findings: Finding[];
}

export interface AdmitOptions {
  allowedLanguages?: readonly SupportedLanguage[];
}

/** Inspect a downloaded document. Throws `UnsafeDocumentError` or `UnsupportedLanguageError` (both permanent). */
export function admitDocument(raw: string, opts: AdmitOptions = {}): AdmittedDocument {
  const r = inspectText(raw);
  if (r.blocked) throw new UnsafeDocumentError(blockReason(r.findings));
  const language = assertAllowedLanguage(r.text, opts.allowedLanguages ?? SUPPORTED_LANGUAGES);
  return { text: r.text, language, findings: r.findings };
}

/** Validate and sanitize the input of a quiz generation. */
export function parseQuizInput(input: QuizGraphInput, opts: AdmitOptions = {}): QuizGraphInput {
  const parsed = QuizInputSchema.safeParse(Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)));
  if (!parsed.success) throw new InvalidLlmInputError(parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  const doc = admitDocument(parsed.data.sourceText, opts);
  return { ...input, sourceText: doc.text };
}

const MessageSchema = z
  .object({ role: z.enum(["system", "user", "assistant"]), content: z.string().min(1).max(MAX_PROMPT_CHARS) })
  .strict();
const RequestSchema = z.object({
  messages: z.array(MessageSchema).min(1).max(8),
  options: z
    .object({
      temperature: z.number().min(0).max(1.5).optional(),
      maxTokens: z.number().int().min(1).max(32_000).optional(),
      name: z.string().max(120).optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .strict()
    .optional(),
});

/** Throws if a model request is malformed or carries hidden/encoded text outside the system prompt. */
export function assertLlmRequest(messages: ChatMessage[], options?: CompleteOptions): void {
  const parsed = RequestSchema.safeParse({ messages, options });
  if (!parsed.success) throw new InvalidLlmInputError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total > MAX_PROMPT_CHARS) throw new InvalidLlmInputError(`prompt too large (${total} characters)`);
  for (const m of messages) {
    if (m.role === "system") continue;
    const r = inspectText(m.content);
    if (r.blocked) throw new UnsafeDocumentError(blockReason(r.findings));
  }
}

/** Wrap a client: every `complete` call is validated first. The model name and everything else pass through. */
export function guardLlm(llm: LlmClient): LlmClient {
  if ((llm as { __guarded?: boolean }).__guarded) return llm;
  const guarded: LlmClient & { __guarded: true } = {
    __guarded: true,
    get model() {
      return llm.model;
    },
    async complete(messages: ChatMessage[], opts?: CompleteOptions): Promise<LlmResponse> {
      assertLlmRequest(messages, opts);
      return llm.complete(messages, opts);
    },
  };
  return guarded;
}
