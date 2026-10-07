import { BudgetExceededError } from "./errors.js";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export const emptyUsage = (): Usage => ({ promptTokens: 0, completionTokens: 0, cachedTokens: 0 });

export interface BudgetLimits {
  maxCalls: number;
  maxTotalTokens: number;
  /** Wall-clock deadline in ms since `startedAt`. */
  maxDurationMs: number;
}

export const DEFAULT_LIMITS: BudgetLimits = { maxCalls: 16, maxTotalTokens: 120_000, maxDurationMs: 5 * 60_000 };

export interface BudgetState {
  calls: number;
  usage: Usage;
  startedAt: number;
}

/**
 * Hard cap on LLM work per job so layered retries (HTTP x repair x critique x SQS redelivery) can
 * never multiply. State is serializable: the worker persists it so a redelivered message resumes
 * with what was already spent instead of getting a fresh allowance.
 */
export class JobBudget {
  private state: BudgetState;

  constructor(
    readonly limits: BudgetLimits = DEFAULT_LIMITS,
    state?: BudgetState,
    private readonly now: () => number = Date.now,
  ) {
    this.state = state ?? { calls: 0, usage: emptyUsage(), startedAt: now() };
  }

  /** Throws BudgetExceededError if another call is not allowed. Call before every LLM request. */
  assertCanCall(): void {
    const { calls, usage, startedAt } = this.state;
    if (calls >= this.limits.maxCalls) throw new BudgetExceededError(`LLM call budget exceeded (${this.limits.maxCalls})`);
    if (usage.promptTokens + usage.completionTokens >= this.limits.maxTotalTokens) {
      throw new BudgetExceededError(`token budget exceeded (${this.limits.maxTotalTokens})`);
    }
    if (this.now() - startedAt >= this.limits.maxDurationMs) {
      throw new BudgetExceededError(`time budget exceeded (${this.limits.maxDurationMs}ms)`);
    }
  }

  record(u: Usage): void {
    this.state.calls += 1;
    this.state.usage = {
      promptTokens: this.state.usage.promptTokens + u.promptTokens,
      completionTokens: this.state.usage.completionTokens + u.completionTokens,
      cachedTokens: this.state.usage.cachedTokens + u.cachedTokens,
    };
  }

  snapshot(): BudgetState {
    return { calls: this.state.calls, usage: { ...this.state.usage }, startedAt: this.state.startedAt };
  }
}
