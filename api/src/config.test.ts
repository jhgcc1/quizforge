import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const db = { DATABASE_URL: "postgres://u:p@h:5432/d" };
const cognito = { ...db, COGNITO_USER_POOL_ID: "eu-1_x", COGNITO_CLIENT_IDS: " a , b,, ", SQS_QUEUE_URL: "http://sqs/q" };

describe("api loadConfig", () => {
  it("builds a cognito + sqs config with defaults and parsed lists", () => {
    const c = loadConfig({ ...cognito, SOURCE_ALLOWED_HOSTS: " GitHub.com ,Foo.io" });
    expect(c).toMatchObject({ AUTH_MODE: "cognito", QUEUE_MODE: "sqs", PORT: 8080, DAILY_QUIZ_QUOTA: 10, TRUST_PROXY: true });
    expect(c.clientIds).toEqual(["a", "b"]);
    expect(c.allowedHosts).toEqual(["github.com", "foo.io"]);
    expect(c.databaseUrl).toBe(db.DATABASE_URL);
  });

  it("parses TRUST_PROXY=false", () => {
    expect(loadConfig({ ...cognito, TRUST_PROXY: "false" }).TRUST_PROXY).toBe(false);
  });

  it("local auth with the memory queue needs a secret and has no client ids", () => {
    const c = loadConfig({ ...db, AUTH_MODE: "local", LOCAL_JWT_SECRET: "x".repeat(16), QUEUE_MODE: "memory" });
    expect(c.clientIds).toEqual([]);
    expect(() => loadConfig({ ...db, AUTH_MODE: "local", QUEUE_MODE: "memory" })).toThrow(/LOCAL_JWT_SECRET is required/);
  });

  it("refuses local auth and the memory queue in production", () => {
    const env = { ...db, NODE_ENV: "production", AUTH_MODE: "local", LOCAL_JWT_SECRET: "x".repeat(16), QUEUE_MODE: "memory" };
    expect(() => loadConfig(env)).toThrow(/AUTH_MODE=local is not allowed in production[\s\S]*QUEUE_MODE=memory is not allowed in production/);
  });

  it("requires the cognito pool and clients, and the queue url for sqs", () => {
    expect(() => loadConfig({ ...db, QUEUE_MODE: "memory" })).toThrow(/COGNITO_USER_POOL_ID and COGNITO_CLIENT_IDS are required/);
    expect(() => loadConfig({ ...db, COGNITO_USER_POOL_ID: "p", COGNITO_CLIENT_IDS: "c" })).toThrow(/SQS_QUEUE_URL is required for QUEUE_MODE=sqs/);
  });

  it("reports a bad field by its path", () => {
    expect(() => loadConfig({ ...cognito, PORT: "abc" })).toThrow(/- PORT:/);
  });
});
