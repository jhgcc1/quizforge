/** Errors that retrying cannot fix: the worker marks the quiz failed and deletes the SQS message. */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class BudgetExceededError extends NonRetryableError {}

/** The model kept returning invalid output after all repair attempts. Retryable at the job level. */
export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly lastRaw: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}
