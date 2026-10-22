/**
 * What the layers BEFORE the model say about a document (no model call): the input guard (block or flag, which rule), the language policy,
 * and the semantic detector (Llama Prompt Guard 2, when INJECTION_DETECTOR_MODEL_DIR is set). Used by every case kind of the public part.
 * The detector always looks at the text, even when the guard has already blocked it, so the report can say what each layer would do alone.
 */
import { inspectText, type Finding } from "@quizforge/core";
import { UnsafeDocumentError, UnsupportedLanguageError, admitDocument, type InjectionDetector } from "@quizforge/llm";

export interface Layers {
  /** "guard" (a block finding), "language" (policy), or undefined (admitted). */
  rejectedBy?: "guard" | "language";
  /** The finding kinds (and rules) that blocked, or the detected language that was refused. */
  rejectedWhy?: string;
  language?: string;
  /** Keyword rules that FLAG (not block): rule ids. */
  rules: string[];
  /** Prompt Guard 2: highest window score and whether it flags (undefined: detector off or it failed). */
  pg2?: { score: number; flagged: boolean };
}

const idOf = (f: Finding): string => (f.rule ? `${f.kind}:${f.rule}` : f.kind);

export async function layersOf(document: string, detector?: InjectionDetector): Promise<Layers> {
  const inspected = inspectText(document);
  const layers: Layers = { rules: [...new Set(inspected.findings.filter((f) => f.severity === "flag").map(idOf))] };
  try {
    const admitted = admitDocument(document);
    layers.language = admitted.language;
  } catch (err) {
    if (err instanceof UnsafeDocumentError) {
      layers.rejectedBy = "guard";
      layers.rejectedWhy = [...new Set(inspected.findings.filter((f) => f.severity === "block").map(idOf))].join(", ") || err.message.slice(0, 120);
    } else if (err instanceof UnsupportedLanguageError) {
      layers.rejectedBy = "language";
      layers.language = err.detected;
      layers.rejectedWhy = `language policy refused "${err.detected}"`;
    } else throw err;
  }
  if (detector) {
    try {
      const r = await detector.detect(inspected.text);
      layers.pg2 = { score: Math.round(r.score * 1000) / 1000, flagged: r.flagged };
    } catch {
      /* a broken detector must not stop the night: the layer is reported as absent */
    }
  }
  return layers;
}

/** The verdict of the layers for one document, for the tables. */
export interface Verdict {
  blocked: boolean;
  rulesFlagged: boolean;
  pg2Flagged: boolean;
  either: boolean;
  passedBoth: boolean;
}

export function verdictOf(l: Layers): Verdict {
  const blocked = l.rejectedBy !== undefined;
  const rulesFlagged = l.rules.length > 0;
  const pg2Flagged = l.pg2?.flagged === true;
  return { blocked, rulesFlagged, pg2Flagged, either: blocked || rulesFlagged || pg2Flagged, passedBoth: !blocked && !rulesFlagged && !pg2Flagged };
}
