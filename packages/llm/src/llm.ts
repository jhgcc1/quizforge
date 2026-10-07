import type { Usage } from "./budget.js";

export type ChatRole = "system" | "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface CompleteOptions {
  temperature?: number;
  maxTokens?: number;
  /** Shown as the observation name in Langfuse. */
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface LlmResponse {
  text: string;
  usage: Usage;
}

/** Provider-agnostic seam: graphs and tests depend on this, not on LangChain. */
export interface LlmClient {
  readonly model: string;
  complete(messages: ChatMessage[], opts?: CompleteOptions): Promise<LlmResponse>;
}
