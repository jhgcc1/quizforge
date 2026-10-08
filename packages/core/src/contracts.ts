import { createHash } from "node:crypto";
import { z } from "zod";

/** Shared request/queue contracts: the API, worker and web UI import these, so they cannot drift. */

export const STRATEGIES = ["auto", "single-shot", "section-map-reduce"] as const;

export const CreateQuizBodySchema = z
  .object({
    /** Markdown document to quiz on. Falls back to the server default when omitted. */
    sourceUrl: z.string().trim().url().max(2000).optional(),
    topic: z.string().trim().min(2).max(200).optional(),
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

/** SQS message: only an id. The row in Postgres is the source of truth, so redelivery is harmless. */
export const QuizJobMessageSchema = z.object({
  v: z.literal(1),
  quizId: z.string().uuid(),
  requestId: z.string().max(200).optional(),
});
export type QuizJobMessage = z.output<typeof QuizJobMessageSchema>;

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
