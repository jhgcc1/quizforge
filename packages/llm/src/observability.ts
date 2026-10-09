import { LangfuseClient } from "@langfuse/client";
import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import type { LlmClient } from "./llm.js";
import { NodeSDK } from "@opentelemetry/sdk-node";

/**
 * Langfuse tracing. Everything here is a no-op when LANGFUSE_* keys are absent, and tracing
 * failures must never break quiz generation.
 */

let sdk: NodeSDK | undefined;
let client: LangfuseClient | undefined;

export const tracingEnabled = () => Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

export function initTracing(): void {
  if (sdk || !tracingEnabled()) return;
  sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
  sdk.start();
}

function langfuse(): LangfuseClient | undefined {
  if (!tracingEnabled()) return undefined;
  client ??= new LangfuseClient();
  return client;
}

export interface TraceAttrs {
  sessionId?: string;
  userId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface TraceContext {
  traceId: string | undefined;
  /** LangChain callbacks so every LLM call and graph node is nested under this trace. */
  callbacks: CallbackHandler[];
}

/** Run `fn` inside a Langfuse trace and hand it the trace id + LangChain callback handler. */
export async function traced<T>(name: string, attrs: TraceAttrs, fn: (ctx: TraceContext) => Promise<T>): Promise<T> {
  if (!tracingEnabled()) return fn({ traceId: undefined, callbacks: [] });
  initTracing();
  const meta = Object.fromEntries(
    Object.entries(attrs.metadata ?? {})
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  );
  return propagateAttributes(
    {
      traceName: name,
      ...(attrs.sessionId ? { sessionId: attrs.sessionId } : {}),
      ...(attrs.userId ? { userId: attrs.userId } : {}),
      ...(attrs.tags ? { tags: attrs.tags } : {}),
      metadata: meta,
    },
    () =>
      startActiveObservation(name, async (span) => {
        const handler = new CallbackHandler();
        return fn({ traceId: span.traceId, callbacks: [handler] });
      }),
  );
}

/** Attach a quality score to a trace (shows up in Langfuse dashboards and can drive alerts). */
export async function scoreTrace(
  traceId: string | undefined,
  name: string,
  value: number,
  comment?: string,
): Promise<void> {
  const lf = langfuse();
  if (!lf || !traceId) return;
  try {
    // The id makes the call idempotent: a redelivered score job or a sweeper re-queue updates the score instead of adding a copy.
    lf.score.create({ id: `${traceId}:${name}`, traceId, name, value, dataType: "NUMERIC", ...(comment ? { comment } : {}) });
  } catch (err) {
    console.warn("langfuse score failed", (err as Error).message);
  }
}

/** Flush buffered spans/scores; call before a short-lived process or container exits. */
export async function flushTracing(): Promise<void> {
  try {
    await client?.flush();
    await sdk?.shutdown();
    sdk = undefined;
  } catch (err) {
    console.warn("langfuse flush failed", (err as Error).message);
  }
}


const clip = (text: string, max = 2000): string => (text.length > max ? `${text.slice(0, max)}…[${text.length - max} more characters]` : text);

/**
 * Wraps an LLM client so that every call is a "generation" in Langfuse (model, tokens, cost, time). The judge runs
 * outside the LangChain graph, so without this its calls were missing from every trace. Prompts are clipped: the
 * judge reads a whole document and three samples would otherwise send hundreds of kilobytes per quiz.
 * A no-op when tracing is off; tracing failures never break the call.
 */
export function withGenerationTracing(llm: LlmClient): LlmClient {
  if (!tracingEnabled()) return llm;
  initTracing();
  return {
    model: llm.model,
    complete: (messages, opts) =>
      startActiveObservation(
        opts?.name ?? "llm-call",
        async (gen) => {
          try {
            gen.update({ model: llm.model, input: messages.map((m) => ({ role: m.role, content: clip(m.content) })), ...(opts?.temperature !== undefined ? { modelParameters: { temperature: opts.temperature } } : {}) });
          } catch {
            /* tracing must not break the call */
          }
          const res = await llm.complete(messages, opts);
          try {
            gen.update({ output: clip(res.text), usageDetails: { input: res.usage.promptTokens, output: res.usage.completionTokens } });
          } catch {
            /* ignore */
          }
          return res;
        },
        { asType: "generation" },
      ),
  };
}
