import { LangfuseClient } from "@langfuse/client";
import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
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
    lf.score.create({ traceId, name, value, dataType: "NUMERIC", ...(comment ? { comment } : {}) });
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
