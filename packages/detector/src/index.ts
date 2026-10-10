import type { DetectorResult, InjectionDetector } from "@quizforge/llm";
import { chunkProse, type ChunkOptions } from "./chunk.js";

export { chunkProse } from "./chunk.js";

/**
 * Semantic prompt-injection detector: protectai/deberta-v3-base-prompt-injection-v2 (Apache 2.0, ungated, ONNX), the classifier
 * behind the PromptInjection scanner of LLM Guard, run in Node through transformers.js. No API key, no per-call cost; the model
 * (about 740 MB) is downloaded from the Hugging Face hub on first use and cached.
 *
 * LIMITS (be honest in the reports):
 *   - ENGLISH ONLY. The model card says it does not handle other languages, so documents in Portuguese or Spanish are skipped.
 *     TODO (expand): a multilingual classifier, or one model per supported language, behind this same interface.
 *   - 512 tokens per window: long documents are scanned in windows and at most `maxChunks` of them (evenly spread).
 *   - It sees "injection-like" text, not intent: a security tutorial that quotes an attack scores high. That is why the default
 *     mode is `flag`, and why it never replaces the delimiters, the guard or the output rails.
 */
export const DEFAULT_MODEL = "protectai/deberta-v3-base-prompt-injection-v2";

type Classify = (texts: string[]) => Promise<{ label: string; score: number }[]>;

export interface OnnxDetectorOptions extends ChunkOptions {
  model?: string;
  /** Score (0..1) of the INJECTION label at or above which a window counts as an injection. Default 0.9. */
  threshold?: number;
  /** For tests: replaces the model. */
  classify?: Classify;
}

async function loadClassifier(model: string): Promise<Classify> {
  const { pipeline } = await import("@huggingface/transformers");
  const pipe = await pipeline("text-classification", model, { dtype: "fp32" });
  return async (texts) => {
    const out: { label: string; score: number }[] = [];
    for (const t of texts) {
      const r = (await pipe(t, { truncation: true, max_length: 512 } as never)) as { label: string; score: number }[] | { label: string; score: number };
      out.push(Array.isArray(r) ? r[0]! : r);
    }
    return out;
  };
}

export function createOnnxDetector(opts: OnnxDetectorOptions = {}): InjectionDetector {
  const model = opts.model ?? DEFAULT_MODEL;
  const threshold = opts.threshold ?? 0.9;
  let classifier: Promise<Classify> | undefined;
  const classify: Classify = (texts) => (opts.classify ? opts.classify(texts) : (classifier ??= loadClassifier(model)).then((c) => c(texts)));
  return {
    name: `onnx:${model}`,
    languages: ["en"],
    async detect(text: string): Promise<DetectorResult> {
      const started = Date.now();
      const { chunks, total } = chunkProse(text, opts);
      if (!chunks.length) return { flagged: false, score: 0, scanned: 0, total: 0, ms: 0 };
      const results = await classify(chunks);
      let best = { score: 0, index: -1 };
      results.forEach((r, i) => {
        const injection = /inject|unsafe|1/i.test(r.label) ? r.score : 1 - r.score;
        if (injection > best.score) best = { score: injection, index: i };
      });
      return {
        flagged: best.score >= threshold,
        score: best.score,
        scanned: chunks.length,
        total,
        ms: Date.now() - started,
        ...(best.index >= 0 && best.score >= threshold ? { excerpt: chunks[best.index]!.slice(0, 80) } : {}),
      };
    },
  };
}
