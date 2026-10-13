import { z } from "zod";

/**
 * Request and response contracts shared by the API, the web BFF and the browser, so none of them can drift.
 * Pure zod (no Node imports, no keyword rules): the browser bundle imports this package, "@quizforge/contract".
 *  - requests are validated in the browser form, again at the BFF, and finally by the API (the only one that is trusted)
 *  - responses are validated in the browser client, and the API integration tests assert every response against them
 */

export const STRATEGIES = ["auto", "single-shot", "section-map-reduce"] as const;

// Local, basic check of the topic (the browser form and the BFF use it). The STRICT check (instruction phrases, encoded text)
// is server-side only: core's CreateQuizBodyStrictSchema adds it on top of this one.
const HAS_LINE_BREAK = /[\r\n\u2028\u2029]/;
const HAS_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const HAS_INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/u;

export const TopicSchema = z
  .string()
  .trim()
  .min(2)
  .max(200)
  .superRefine((t, ctx) => {
    if (HAS_LINE_BREAK.test(t)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The topic must be a single line" });
    else if (HAS_INVISIBLE.test(t) || HAS_CONTROL.test(t)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The topic contains invisible or control characters" });
  });

export const CreateQuizBodySchema = z
  .object({
    /** Markdown document to quiz on. Falls back to the server default when omitted. */
    sourceUrl: z.string().trim().url().max(2000).optional(),
    /** Free text that ends up in a prompt: one plain line, no invisible characters. The server adds the strict check (instructions, encodings). */
    topic: TopicSchema.optional(),
    numQuestions: z.number().int().min(5).max(8).default(6),
    strategy: z.enum(STRATEGIES).default("auto"),
    critique: z.boolean().default(true),
  })
  .strict();
export type CreateQuizBody = z.output<typeof CreateQuizBodySchema>;

export const SaveAnswerBodySchema = z
  .object({
    optionIds: z.array(z.string().uuid()).min(1).max(4),
    /** Monotonic per question, chosen by the client: a delayed retry with an older value is ignored. */
    revision: z.number().int().min(0).max(1_000_000),
  })
  .strict();
export type SaveAnswerBody = z.output<typeof SaveAnswerBodySchema>;

export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_\-:.]{8,128}$/, "Idempotency-Key must be 8-128 chars of [A-Za-z0-9_-:.]");


/* ------------------------------------------------------------------ responses (JSON: dates travel as ISO strings) */

const iso = z.string();
const status = z.enum(["queued", "generating", "ready", "failed"]);

export const QuizSummarySchema = z.object({
  id: z.string().uuid(),
  status,
  sourceUrl: z.string(),
  topic: z.string().nullable(),
  numQuestions: z.number().int(),
  strategyRequested: z.string(),
  strategyUsed: z.string().nullable(),
  critique: z.boolean(),
  error: z.string().nullable(),
  createdAt: iso,
});
export type QuizSummary = z.output<typeof QuizSummarySchema>;

export const PublicQuestionSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int(),
  prompt: z.string(),
  type: z.enum(["single", "multiple"]),
  difficulty: z.enum(["easy", "medium", "hard"]),
  options: z.array(z.object({ id: z.string().uuid(), position: z.number().int(), text: z.string() })).length(4),
});
export type PublicQuestion = z.output<typeof PublicQuestionSchema>;

export const QuizEnvelopeSchema = z.object({ quiz: QuizSummarySchema });
export const QuizWithQuestionsSchema = z.object({ quiz: QuizSummarySchema, questions: z.array(PublicQuestionSchema) });
/** What a user did with a quiz: the history list shows it next to each quiz. */
export const QuizProgressSchema = z.object({
  attempts: z.number().int(),
  inProgressAttemptId: z.string().uuid().nullable(),
  /** The most recent submitted attempt, with its score (0..4). */
  last: z.object({ attemptId: z.string().uuid(), finalScore: z.number(), percent: z.number(), submittedAt: iso }).nullable(),
  best: z.number().nullable(),
});
export type QuizProgress = z.output<typeof QuizProgressSchema>;
export const QuizListItemSchema = QuizSummarySchema.extend({ progress: QuizProgressSchema });
export type QuizListItem = z.output<typeof QuizListItemSchema>;
export const QuizListSchema = z.object({ quizzes: z.array(QuizListItemSchema) });

export const AttemptListItemSchema = z.object({ id: z.string().uuid(), status: z.enum(["in_progress", "submitted"]), startedAt: iso, submittedAt: iso.nullable(), finalScore: z.number().nullable(), percent: z.number().nullable() });
export const AttemptListSchema = z.object({ attempts: z.array(AttemptListItemSchema) });

export const SavedAnswerSchema = z.object({ questionId: z.string().uuid(), optionIds: z.array(z.string().uuid()), revision: z.number().int() });
export type SavedAnswer = z.output<typeof SavedAnswerSchema>;

export const AttemptSchema = z.object({ id: z.string().uuid(), quizId: z.string().uuid(), status: z.enum(["in_progress", "submitted"]), startedAt: iso });
export const AttemptWithAnswersSchema = z.object({ attempt: AttemptSchema, answers: z.array(SavedAnswerSchema) });
export const SaveAnswerResponseSchema = z.object({ status: z.enum(["saved", "ignored"]), reason: z.string().optional() });

export const AttemptResultSchema = z.object({
  attemptId: z.string().uuid(),
  quizId: z.string().uuid(),
  status: z.enum(["in_progress", "submitted"]),
  finalScore: z.number().nullable(),
  percent: z.number().nullable(),
  questions: z.array(
    z.object({
      id: z.string().uuid(),
      position: z.number().int(),
      prompt: z.string(),
      type: z.enum(["single", "multiple"]),
      explanation: z.string(),
      sourceQuote: z.string(),
      score: z.number().nullable(),
      weight: z.number().nullable(),
      options: z.array(z.object({ id: z.string().uuid(), position: z.number().int(), text: z.string(), isCorrect: z.boolean(), selected: z.boolean() })),
    }),
  ),
});
export type AttemptResult = z.output<typeof AttemptResultSchema>;
export const SubmitResponseSchema = z.object({ replayed: z.boolean(), result: AttemptResultSchema });

export const ErrorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional(), requestId: z.string().optional() }) });

/* ------------------------------------------------------------------ sample catalog (the dropdown) */

export const CatalogEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  description: z.string(),
  url: z.string().url(),
  /** `readme` = a real project README; `test` = a document written to exercise one behaviour of the generator */
  kind: z.enum(["readme", "test"]),
  language: z.enum(["en", "pt", "es"]),
  size: z.enum(["short", "medium", "long"]),
  /** what this document is good for testing */
  tests: z.string(),
});
export type CatalogEntry = z.output<typeof CatalogEntrySchema>;
export const CatalogResponseSchema = z.object({ items: z.array(CatalogEntrySchema) });
