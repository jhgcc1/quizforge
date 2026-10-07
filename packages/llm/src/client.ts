import { ChatOpenAI } from "@langchain/openai";
import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { ChatMessage, CompleteOptions, LlmClient, LlmResponse } from "./llm.js";

export interface MiniMaxConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  /** HTTP-level retries (network, 429, 5xx) handled by the OpenAI SDK with backoff + Retry-After. */
  maxRetries?: number;
  timeoutMs?: number;
  callbacks?: BaseCallbackHandler[];
}

interface LcUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { cache_read?: number };
}

const textOf =(content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : ((p as { text?: string }).text ?? ""))).join("");
  }
  return String(content ?? "");
};

/** MiniMax speaks the OpenAI chat-completions protocol, so LangChain's ChatOpenAI works with a custom base URL. */
export function createMiniMaxClient(cfg: MiniMaxConfig): LlmClient {
  const cache = new Map<string, ChatOpenAI>();
  const modelFor = (temperature: number, maxTokens: number | undefined) => {
    const key = `${temperature}:${maxTokens ?? ""}`;
    let m = cache.get(key);
    if (!m) {
      m = new ChatOpenAI({
        model: cfg.model,
        apiKey: cfg.apiKey,
        configuration: { baseURL: cfg.baseUrl ?? "https://api.minimax.io/v1" },
        temperature,
        ...(maxTokens ? { maxTokens } : {}),
        maxRetries: cfg.maxRetries ?? 3,
        timeout: cfg.timeoutMs ?? 90_000,
      });
      cache.set(key, m);
    }
    return m;
  };

  return {
    model: cfg.model,
    async complete(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<LlmResponse> {
      const res = await modelFor(opts.temperature ?? 0.3, opts.maxTokens).invoke(
        messages.map((m) => ({ role: m.role, content: m.content })),
        {
          runName: opts.name ?? "minimax",
          metadata: opts.metadata ?? {},
          ...(cfg.callbacks ? { callbacks: cfg.callbacks } : {}),
        },
      );
      const u = (res as unknown as { usage_metadata?: LcUsage }).usage_metadata;
      return {
        text: textOf(res.content),
        usage: {
          promptTokens: u?.input_tokens ?? 0,
          completionTokens: u?.output_tokens ?? 0,
          cachedTokens: u?.input_token_details?.cache_read ?? 0,
        },
      };
    },
  };
}
