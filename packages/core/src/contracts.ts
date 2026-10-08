import { createHash } from "node:crypto";
import { z } from "zod";

/** Queue contract and request fingerprint (server only). The request/response schemas live in schemas.ts, which the browser can import too. */

export * from "./schemas.js";

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
