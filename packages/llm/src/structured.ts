import type { ZodError, ZodTypeAny, z } from "zod";
import type { JobBudget, Usage } from "./budget.js";
import { emptyUsage } from "./budget.js";
import { StructuredOutputError } from "./errors.js";
import { JsonExtractionError, extractJson } from "./json.js";
import type { ChatMessage, CompleteOptions, LlmClient } from "./llm.js";

export interface StructuredRequest<S extends ZodTypeAny> {
  llm: LlmClient;
  budget: JobBudget;
  schema: S;
  system: string;
  user: string;
  /** Repair rounds after the first attempt (total attempts = 1 + maxRepairs). */
  maxRepairs?: number;
  options?: CompleteOptions;
}

export interface StructuredResult<T> {
  value: T;
  /** Calls made for this request (1 = valid on first try). */
  attempts: number;
  repairs: number;
  usage: Usage;
}

export function formatZodIssues(err: ZodError, limit = 8): string {
  return err.issues
    .slice(0, limit)
    .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}

/**
 * Ask for JSON, then enforce it. Provider-side JSON modes are not trusted (MiniMax ignores
 * json_schema field names and prepends <think>), so validity is guaranteed here: extract ->
 * zod-validate -> on failure feed the concrete errors back and ask for a corrected object.
 * Nothing unvalidated is ever returned.
 */
export async function generateStructured<S extends ZodTypeAny>(req: StructuredRequest<S>): Promise<StructuredResult<z.output<S>>> {
  const maxRepairs = req.maxRepairs ?? 2;
  const messages: ChatMessage[] = [
    { role: "system", content: req.system },
    { role: "user", content: req.user },
  ];
  const usage = emptyUsage();
  let lastRaw = "";
  let lastProblem = "";

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    req.budget.assertCanCall(); // BudgetExceededError is non-retryable and propagates
    const res = await req.llm.complete(messages, {
      ...req.options,
      name: `${req.options?.name ?? "structured"}${attempt > 0 ? `:repair-${attempt}` : ""}`,
    });
    req.budget.record(res.usage);
    usage.promptTokens += res.usage.promptTokens;
    usage.completionTokens += res.usage.completionTokens;
    usage.cachedTokens += res.usage.cachedTokens;
    lastRaw = res.text;

    let problem: string;
    try {
      const parsed = req.schema.safeParse(extractJson(res.text));
      if (parsed.success) return { value: parsed.data, attempts: attempt + 1, repairs: attempt, usage };
      problem = `The JSON did not match the required schema:\n${formatZodIssues(parsed.error)}`;
    } catch (err) {
      if (!(err instanceof JsonExtractionError)) throw err;
      problem = `Your reply was not parseable JSON (${err.message}).`;
    }
    lastProblem = problem;
    messages.push(
      { role: "assistant", content: res.text.length > 4000 ? res.text.slice(-4000) : res.text },
      { role: "user", content: `${problem}\nReturn ONLY the corrected JSON object. No prose, no code fences.` },
    );
  }
  throw new StructuredOutputError(
    `model output still invalid after ${maxRepairs + 1} attempts: ${lastProblem.split("\n")[0]}`,
    lastRaw,
    maxRepairs + 1,
  );
}
