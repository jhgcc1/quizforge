import type { DetectorResult, InjectionDetector } from "@quizforge/llm";
import { chunkProse, type ChunkOptions } from "./chunk.js";

export { chunkProse } from "./chunk.js";

/**
 * Semantic prompt-injection detector: Meta's Llama Prompt Guard 2 86M (multilingual: en, fr, de, hi, it, pt, es, th), run in Node
 * through transformers.js (ONNX). Built with Llama; licence: Llama 4 Community License (see THIRD_PARTY_NOTICES.md). The official
 * repo is gated and has no ONNX, so we use the ungated ONNX conversion gravitee-io/Llama-Prompt-Guard-2-86M-onnx (fp32, 1.1 GB;
 * the quantized file is NOT used: its recall is far lower). No API key, no per-call cost.
 *
 * WHERE THE WEIGHTS COME FROM
 *   - INJECTION_DETECTOR_MODEL_DIR (production and the Docker image): a folder baked into the image at build time with
 *     config.json, tokenizer*.json, special_tokens_map.json and onnx/model.onnx. Remote downloads are disabled then, so a task
 *     never downloads 1.1 GB and works with no network.
 *   - otherwise `model` (env INJECTION_DETECTOR_MODEL, default DEFAULT_MODEL) is fetched from the Hugging Face hub on first use and
 *     cached in TRANSFORMERS_CACHE_DIR (the weights sit at the repo root there, hence `subfolder: ""`).
 *
 * LIMITS (be honest in the reports):
 *   - 512 tokens per window: long documents are scanned in windows and at most `maxChunks` of them (evenly spread).
 *   - It sees "injection-like" text, not intent: a security tutorial that quotes an attack can score high. That is why the default
 *     mode is `flag`, and why it never replaces the delimiters, the guard or the output rails. It also misses subtle attacks.
 */
export const DEFAULT_MODEL = "gravitee-io/Llama-Prompt-Guard-2-86M-onnx";
/** The languages Llama Prompt Guard 2 was trained for. Our language policy accepts en, pt and es, all of them covered. */
export const DETECTOR_LANGUAGES = ["en", "fr", "de", "hi", "it", "pt", "es", "th"] as const;
/** The model's own decision boundary. Chosen from the benchmark (docs/security/benchmark.html): scores are almost binary (blatant attacks 0.99+), so 0.5 recalls the most. On the benign benchmark rows and the test documents it has 0 false positives, but it flags a few real READMEs (docs/security/detector-fp.md: 5 of 98, scores up to 0.99), which is why the default mode is flag and never block. Raise it with INJECTION_DETECTOR_THRESHOLD before using block mode. */
export const DEFAULT_THRESHOLD = 0.5;

export type Classify = (texts: string[]) => Promise<{ label: string; score: number }[]>;

export interface OnnxDetectorOptions extends ChunkOptions {
  /** Hub id of the model. Default: env INJECTION_DETECTOR_MODEL or DEFAULT_MODEL. */
  model?: string;
  /** Folder with a local copy (config.json, tokenizer files, onnx/model.onnx). Default: env INJECTION_DETECTOR_MODEL_DIR. */
  modelDir?: string;
  /** Score (0..1) of the malicious label at or above which a window counts as an injection. Default: env INJECTION_DETECTOR_THRESHOLD or DEFAULT_THRESHOLD. */
  threshold?: number;
  /** For tests: replaces the model. */
  classify?: Classify;
}

/** Prompt Guard 2 labels: BENIGN / MALICIOUS (id2label in config.json), or LABEL_0 / LABEL_1 when a conversion has no names. */
const isMalicious = (label: string): boolean => /malicious|inject|unsafe|^label_1$|^1$/i.test(label);

/** The real model as a classify function (exported for the measurement scripts). */
export async function loadClassifier(model: string, modelDir: string | undefined): Promise<Classify> {
  const { pipeline, env } = await import("@huggingface/transformers");
  let id = model;
  let options: Record<string, unknown> = { dtype: "fp32", subfolder: "" };
  if (modelDir) {
    const dir = modelDir.replace(/\/+$/, "");
    env.allowRemoteModels = false;
    env.localModelPath = dir.slice(0, dir.lastIndexOf("/") + 1) || "/";
    id = dir.slice(dir.lastIndexOf("/") + 1);
    options = { dtype: "fp32" }; // local layout: <dir>/onnx/model.onnx
  } else if (process.env.TRANSFORMERS_CACHE_DIR) env.cacheDir = process.env.TRANSFORMERS_CACHE_DIR; // a volume in containers, so the model is downloaded once
  const pipe = await pipeline("text-classification", id, options as never);
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
  const model = opts.model ?? (process.env.INJECTION_DETECTOR_MODEL || DEFAULT_MODEL);
  const modelDir = opts.modelDir ?? (process.env.INJECTION_DETECTOR_MODEL_DIR || undefined);
  const fromEnv = Number(process.env.INJECTION_DETECTOR_THRESHOLD);
  const threshold = opts.threshold ?? (fromEnv > 0 && fromEnv <= 1 ? fromEnv : DEFAULT_THRESHOLD);
  let classifier: Promise<Classify> | undefined;
  const classify: Classify = (texts) => (opts.classify ? opts.classify(texts) : (classifier ??= loadClassifier(model, modelDir)).then((c) => c(texts)));
  return {
    name: `onnx:${model}`,
    languages: DETECTOR_LANGUAGES,
    async detect(text: string): Promise<DetectorResult> {
      const started = Date.now();
      const { chunks, total } = chunkProse(text, opts);
      if (!chunks.length) return { flagged: false, score: 0, scanned: 0, total: 0, ms: 0 };
      const results = await classify(chunks);
      let best = { score: 0, index: -1 };
      results.forEach((r, i) => {
        const injection = isMalicious(r.label) ? r.score : 1 - r.score;
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
