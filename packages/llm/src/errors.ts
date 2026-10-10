/** Errors that retrying cannot fix: the worker marks the quiz failed and deletes the SQS message. */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class BudgetExceededError extends NonRetryableError {}

/** The document hides or encodes text meant for the model (invisible Unicode, Base64 instructions, hidden HTML...). */
export class UnsafeDocumentError extends NonRetryableError {
  constructor(readonly reason: string) {
    super(`unsafe_document: ${reason}`);
  }
}

/** A request that does not fit the strict schema of what a model call may carry. A bug or an attack: never retried. */
export class InvalidLlmInputError extends NonRetryableError {
  constructor(message: string) {
    super(`invalid_llm_input: ${message}`);
  }
}

/** What the model returned is not a clean quiz (repeats our prompts, carries script or foreign links, echoes an instruction...). A content failure: the retry regenerates. */
export class UnsafeOutputError extends Error {
  constructor(readonly problems: string[]) {
    super(`unsafe_output: ${problems.join("; ").slice(0, 400)}`);
    this.name = "UnsafeOutputError";
  }
}

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
