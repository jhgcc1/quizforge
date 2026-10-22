/**
 * Structured JSON logs on stdout (collected by the ECS awslogs driver) and CloudWatch Embedded
 * Metric Format lines, which CloudWatch turns into metrics/alarms with no extra API calls.
 */

type Level = "error" | "warn" | "info" | "debug";
const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const SECRET_KEYS = /authorization|cookie|api[-_]?key|secret|token|password/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack?.split("\n").slice(0, 6).join("\n") };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1)]));
}

/** The small surface the worker actually uses, so swapping the implementation stays a one-file change. */
export interface Logger {
  error(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * A logger that writes one JSON object per line to stdout, where the ECS awslogs driver picks it up.
 * `bindings` are merged into every line (a request id, a quiz id), and `child()` adds more without losing them.
 * Every logged object passes through `redact`, so an error carrying a token or an Authorization header cannot
 * put it in CloudWatch. `write` is a parameter so the tests can capture lines instead of printing them.
 */
export function createLogger(level: Level = "info", bindings: Record<string, unknown> = {}, write: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const emit = (lvl: Level) => (obj: Record<string, unknown>, msg: string) => {
    if (ORDER[lvl] > ORDER[level]) return;
    write(JSON.stringify({ level: lvl, time: new Date().toISOString(), service: "worker", ...bindings, ...(redact(obj) as object), msg }));
  };
  return {
    error: emit("error"),
    warn: emit("warn"),
    info: emit("info"),
    debug: emit("debug"),
    child: (b) => createLogger(level, { ...bindings, ...b }, write),
  };
}

/** The CloudWatch units this worker emits; EMF rejects anything outside its own list. */
export type MetricUnit = "None" | "Count" | "Milliseconds" | "Seconds";

/** One EMF record: dimensions are fixed to Service so metric cardinality stays tiny. */
export function emitMetrics(metrics: Record<string, { value: number; unit?: MetricUnit }>, write: (line: string) => void = (l) => process.stdout.write(l + "\n")): void {
  const names = Object.keys(metrics);
  write(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: "QuizForge", Dimensions: [["Service"]], Metrics: names.map((Name) => ({ Name, Unit: metrics[Name]!.unit ?? "None" })) }],
      },
      Service: "worker",
      ...Object.fromEntries(names.map((n) => [n, metrics[n]!.value])),
    }),
  );
}
