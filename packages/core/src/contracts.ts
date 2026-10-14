import { createHash } from "node:crypto";
import { z } from "zod";
import { CreateQuizBodySchema, TopicSchema } from "@quizforge/contract";
import { checkShortText } from "./guard.js";

/** Queue contract and request fingerprint (server only). The request/response schemas live in @quizforge/contract, which the browser imports too. */

export * from "@quizforge/contract";

/**
 * The create-quiz body as the SERVER validates it: the contract's schema plus the strict topic check (instruction phrases,
 * encoded or disguised text: the 106 keyword rules). The browser only has the basic check. Server code must use this one.
 */
export const CreateQuizBodyStrictSchema = CreateQuizBodySchema.extend({
  topic: TopicSchema.superRefine((t, ctx) => {
    const issue = checkShortText(t);
    if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `The topic ${issue.message}` });
  }).optional(),
});

/** SQS message: only an id. The row in Postgres is the source of truth, so redelivery is harmless. */
export const QuizJobMessageSchema = z.object({
  v: z.literal(1),
  quizId: z.string().uuid(),
  requestId: z.string().max(200).optional(),
});
export type QuizJobMessage = z.output<typeof QuizJobMessageSchema>;

/**
 * Scoring job: the quiz is already saved as `ready`; a separate scorer service judges it. Only ids travel: the questions,
 * the source document and the Langfuse trace id are read from Postgres, so a redelivered or duplicated message is harmless.
 */
export const ScoreJobMessageSchema = z.object({
  v: z.literal(1),
  quizId: z.string().uuid(),
  jobId: z.string().uuid(),
  requestId: z.string().max(200).optional(),
});
export type ScoreJobMessage = z.output<typeof ScoreJobMessageSchema>;

/** Stable fingerprint of a request body, so the same Idempotency-Key with a different body is detectable. */
export function requestFingerprint(value: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canon(x)]),
          )
        : v;
  return createHash("sha256").update(JSON.stringify(canon(value))).digest("hex");
}
