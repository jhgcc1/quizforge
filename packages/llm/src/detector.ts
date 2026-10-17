import type { Finding } from "@quizforge/core";
import type { Lang } from "./language.js";

/**
 * Seam for an OPTIONAL semantic prompt-injection detector (a classifier model). The implementation lives in
 * `@quizforge/detector` (heavy dependencies: ONNX runtime, a 1.1 GB model) so that the service images stay small unless it is
 * switched on. Nothing here depends on it.
 */
export interface DetectorResult {
  flagged: boolean;
  /** Highest injection score over the windows scanned, 0..1. */
  score: number;
  scanned: number;
  /** Windows in the whole document (more than `scanned` when the document is long). */
  total: number;
  ms: number;
  /** A short excerpt of the highest-scoring window, only when flagged. */
  excerpt?: string;
}

export interface InjectionDetector {
  name: string;
  /** Languages the model understands. Documents in other languages are skipped, not judged. */
  languages: readonly string[];
  detect(text: string): Promise<DetectorResult>;
}

/** off: not run. flag: a finding is recorded and the document goes on. block: a high score rejects the document. */
export type DetectorMode = "off" | "flag" | "block";

/**
 * In `block` mode there are TWO thresholds, and the distance between them is the point.
 *
 * The detector's score is not a probability of attack: real READMEs sit at the top of its scale (measured: 12 of 722 real
 * READMEs score above 0.5, and six of those above 0.9 -- elasticsearch, youtube-dl, pure-bash-bible). So a single threshold
 * either marks a lot of legitimate documents or catches nothing.
 *
 *   score >= blockAt (0.9)   the document is REJECTED, and the user is offered a review request
 *   score >= flagAt  (0.5)   the document goes on, marked: that is what puts the output rails in strict mode
 *   below              nothing
 *
 * Keeping the flag at 0.5 matters: raising it to the block threshold would silently drop the strict rails for everything
 * between the two, which is where most of the real attacks the detector sees actually land.
 */
export const DEFAULT_BLOCK_THRESHOLD = 0.9;

export const parseDetectorMode = (raw: string | undefined): DetectorMode => (raw === "flag" || raw === "block" ? raw : "off");

export type ScreenOutcome =
  | { status: "skipped"; reason: "off" | "language" }
  | { status: "clean"; result: DetectorResult }
  | { status: "flagged" | "blocked"; result: DetectorResult; finding: Finding };

/** Run the detector on an already admitted document. Never throws: a broken detector must not take the service down. */
export async function screenWithDetector(
  text: string,
  language: Lang,
  detector: InjectionDetector | undefined,
  mode: DetectorMode,
  blockAt: number = DEFAULT_BLOCK_THRESHOLD,
): Promise<ScreenOutcome> {
  if (!detector || mode === "off") return { status: "skipped", reason: "off" };
  if (language !== "unknown" && !detector.languages.includes(language)) return { status: "skipped", reason: "language" };
  const result = await detector.detect(text);
  if (!result.flagged) return { status: "clean", result };
  const blocks = mode === "block" && result.score >= blockAt;
  const finding: Finding = {
    kind: "semantic_injection",
    severity: blocks ? "block" : "flag",
    detail: `the classifier scored ${result.score.toFixed(2)} for prompt injection (${result.scanned}/${result.total} windows scanned)`,
    ...(result.excerpt ? { sample: result.excerpt } : {}),
  };
  return { status: blocks ? "blocked" : "flagged", result, finding };
}
