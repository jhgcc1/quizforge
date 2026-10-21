import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const base = { DATABASE_URL: "postgres://u:p@h:5432/d", SQS_QUEUE_URL: "http://sqs/q", MINIMAX_API_KEY: "k" };

describe("worker loadConfig", () => {
  it("applies the defaults and derives the database url and the allowed hosts", () => {
    const c = loadConfig({ ...base, SOURCE_ALLOWED_HOSTS: " GitHub.com , ,Example.org " });
    expect(c).toMatchObject({ WORKER_ROLE: "generate", SQS_MAX_RECEIVE: 3, SQS_VISIBILITY_TIMEOUT: 360, JUDGE_SAMPLES: 3, WORKER_CONCURRENCY: 1, LLM_MODE: "minimax" });
    expect(c.databaseUrl).toBe(base.DATABASE_URL);
    expect(c.allowedHosts).toEqual(["github.com", "example.org"]);
  });

  it("coerces numeric env vars", () => {
    const c = loadConfig({ ...base, SQS_MAX_RECEIVE: "5", WORKER_CONCURRENCY: "2" });
    expect(c.SQS_MAX_RECEIVE).toBe(5);
    expect(c.WORKER_CONCURRENCY).toBe(2);
  });

  it("rejects minimax mode without an API key", () => {
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL, SQS_QUEUE_URL: base.SQS_QUEUE_URL })).toThrow(/MINIMAX_API_KEY is required/);
  });

  it("allows the fake LLM outside production but refuses it in production", () => {
    expect(loadConfig({ ...base, LLM_MODE: "fake", MINIMAX_API_KEY: "", NODE_ENV: "test" }).LLM_MODE).toBe("fake");
    expect(() => loadConfig({ ...base, LLM_MODE: "fake", NODE_ENV: "production" })).toThrow(/LLM_MODE=fake is not allowed in production/);
  });

  it("lists every invalid field, naming the path", () => {
    expect(() => loadConfig({ ...base, SQS_QUEUE_URL: "", WORKER_CONCURRENCY: "9", SQS_VISIBILITY_TIMEOUT: "5" })).toThrow(/Invalid configuration:[\s\S]*SQS_QUEUE_URL[\s\S]*SQS_VISIBILITY_TIMEOUT[\s\S]*WORKER_CONCURRENCY/);
  });
});
