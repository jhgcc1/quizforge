import type { GenerationProgress } from "@quizforge/llm";
import type { Logger } from "./log.js";

/** Sub-progress inside one phase ("section 3 of 5") is written at most this often; a change of phase is always written. */
export const DETAIL_THROTTLE_MS = 750;

export interface ProgressReporter {
  /** Synchronous and never throws: the write happens in the background. */
  report(p: GenerationProgress): void;
  /** Wait for the writes in flight (they never reject). Called before the quiz is completed or failed. */
  flush(): Promise<void>;
}

/**
 * Writes the phase of a running job to the database, in order, one UPDATE at a time. Progress is a courtesy to the user, so a
 * failed write is logged and dropped: it must never fail, slow down or retry a job.
 */
export function createProgressReporter(
  write: (p: GenerationProgress) => Promise<void>,
  log: Pick<Logger, "warn">,
  now: () => number = Date.now,
): ProgressReporter {
  let chain: Promise<void> = Promise.resolve();
  let last: GenerationProgress | undefined;
  let lastAt = 0;
  return {
    report(p) {
      if (last && last.phase === p.phase && last.step === p.step && last.totalSteps === p.totalSteps) {
        if (last.detail === p.detail) return;
        if (now() - lastAt < DETAIL_THROTTLE_MS) return;
      }
      last = p;
      lastAt = now();
      chain = chain.then(() => write(p)).catch((err: unknown) => log.warn({ err, phase: p.phase }, "could not record the generation phase"));
    },
    flush: () => chain,
  };
}
