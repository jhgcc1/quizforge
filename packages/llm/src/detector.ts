import type { Finding } from "@quizforge/core";
import type { Lang } from "./language.js";

/**
 * Seam for an OPTIONAL semantic prompt-injection detector (a classifier model). The implementation lives in
 * `@quizforge/detector` (heavy dependencies: ONNX runtime, a ~740 MB model) so that the service images stay small unless it is
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

/** off: not run. flag: a finding is recorded and the document goes on. block: the document is rejected. */
export type DetectorMode = "off" | "flag" | "block";

export const parseDetectorMode = (raw: string | undefined): DetectorMode => (raw === "flag" || raw === "block" ? raw : "off");

export type ScreenOutcome =
  | { status: "skipped"; reason: "off" | "language" }
  | { status: "clean"; result: DetectorResult }
  | { status: "flagged" | "blocked"; result: DetectorResult; finding: Finding };

/** Run the detector on an already admitted document. Never throws: a broken detector must not take the service down. */
export async function screenWithDetector(text: string, language: Lang, detector: InjectionDetector | undefined, mode: DetectorMode): Promise<ScreenOutcome> {
  if (!detector || mode === "off") return { status: "skipped", reason: "off" };
  if (language !== "unknown" && !detector.languages.includes(language)) return { status: "skipped", reason: "language" };
  const result = await detector.detect(text);
  if (!result.flagged) return { status: "clean", result };
  const finding: Finding = {
    kind: "semantic_injection",
    severity: mode === "block" ? "block" : "flag",
    detail: `the classifier scored ${result.score.toFixed(2)} for prompt injection (${result.scanned}/${result.total} windows scanned)`,
    ...(result.excerpt ? { sample: result.excerpt } : {}),
  };
  return { status: mode === "block" ? "blocked" : "flagged", result, finding };
}
