/**
 * Attacker / generation provider for the red team: MiniMax through its OpenAI-compatible API.
 * MiniMax-M2.x writes a <think>...</think> block before the answer. For text generation (translations, paraphrases, jailbreak
 * rewrites) that block would end up INSIDE the attack, so this wrapper removes it (same idea as stripThink in packages/llm).
 * The key is read from the environment (MINIMAX_API_KEY) and is never written anywhere.
 */
export const stripThink = (text: string): string => {
  const closed = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const open = closed.search(/<think>/i);
  return (open === -1 ? closed : closed.slice(0, open)).trim();
};

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

type Message = { role: string; content: string };

/** The prompt can be a JSON chat (an array of messages) or plain text. */
export function toMessages(prompt: string): Message[] {
  try {
    const parsed: unknown = JSON.parse(prompt);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((m) => m && typeof m === "object" && "role" in m && "content" in m)) return parsed as Message[];
  } catch {
    /* plain text */
  }
  return [{ role: "user", content: prompt }];
}

export default class MiniMaxAttacker {
  constructor(private readonly options: { config?: { model?: string; baseUrl?: string; maxTokens?: number } } = {}) {}

  id(): string {
    return "minimax-attacker";
  }

  async callApi(prompt: string): Promise<{ output?: string; error?: string; tokenUsage?: { prompt: number; completion: number; total: number } }> {
    const apiKey = process.env.MINIMAX_API_KEY;
    if (!apiKey) return { error: "MINIMAX_API_KEY is not set (red team generation needs the MiniMax key)" };
    const base = this.options.config?.baseUrl ?? process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1";
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: this.options.config?.model ?? process.env.MINIMAX_MODEL ?? "MiniMax-M2.7", messages: toMessages(prompt), max_tokens: this.options.config?.maxTokens ?? 12000 }),
    });
    const body = (await res.json().catch(() => ({}))) as ChatResponse;
    if (!res.ok || body.error) return { error: `MiniMax ${res.status}: ${body.error?.message ?? "request failed"}` };
    const raw = body.choices?.[0]?.message?.content ?? "";
    const u = body.usage;
    return { output: stripThink(raw), ...(u ? { tokenUsage: { prompt: u.prompt_tokens ?? 0, completion: u.completion_tokens ?? 0, total: u.total_tokens ?? 0 } } : {}) };
  }
}
