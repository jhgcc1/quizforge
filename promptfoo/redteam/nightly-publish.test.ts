import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { alarmMessage, contentType, defaultPresign, notifyLeaks, parsePublishArgs, publish, SEVEN_DAYS, updateLatest, uploadRun } from "./nightly-publish.js";
import { buildSummary, writeReport, type RunInfo } from "./nightly-report.js";
import type { EvalRow } from "./report.js";

const info: RunInfo = { runId: "2026-10-14T06-00-12Z", startedAt: "2026-10-14T06:00:12Z", finishedAt: "2026-10-14T06:10:12Z", gitSha: "abcdef0123456789", model: "MiniMax-M2.7", detector: "flag", promptfooVersion: "0.124.1", numTests: 10 };

const leakRow: EvalRow = {
  success: false,
  testCase: { description: "REDTEAM pt override plain", vars: { kind: "redteam", prompt: "p" }, metadata: { language: "pt", strategy: "plain", intent: "override", canary: "ZX9-ALPHA" } as never },
  response: { output: JSON.stringify({ status: "quiz", llmCalls: 1, questions: [{ prompt: "ZX9-ALPHA", options: ["a", "b", "c", "d"], explanation: "e", sourceQuote: "q" }] }) },
  gradingResult: { componentResults: [{ pass: false, reason: "CANARY LEAKED: ZX9-ALPHA" }] },
};
const cleanRow: EvalRow = { ...leakRow, success: true, gradingResult: { componentResults: [{ pass: true }] }, response: { output: JSON.stringify({ status: "blocked", llmCalls: 0 }) } };

const recorder = () => {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  return { calls, send: async (c: unknown) => void calls.push({ name: (c as { constructor: { name: string } }).constructor.name, input: (c as { input: Record<string, unknown> }).input }) };
};

const makeRun = (rows: EvalRow[]) => {
  const dir = mkdtempSync(join(tmpdir(), "publish-"));
  const out = join(dir, "run");
  writeReport(rows, info, out);
  const results = join(dir, "redteam-nightly.json");
  writeFileSync(results, JSON.stringify({ results: { results: rows } }));
  return { out, results };
};

describe("nightly publish", () => {
  it("uploads the run folder without overwriting, then moves the pointer", async () => {
    const { out, results } = makeRun([cleanRow]);
    const s3 = recorder();
    const r = await publish({ bucket: "b", runId: info.runId, dir: out, extra: [results] }, { s3, presign: async () => "unused" });
    expect(r.keys).toEqual([`redteam/${info.runId}/summary.json`, `redteam/${info.runId}/report.html`, `redteam/${info.runId}/new-failures.json`, `redteam/${info.runId}/redteam-nightly.json`]);
    expect(r.latest).toEqual(["redteam/latest/summary.json", "redteam/latest/report.html"]);
    expect(r.notified).toBe(false);
    const run = s3.calls.slice(0, 4);
    expect(run.every((c) => c.name === "PutObjectCommand" && c.input.IfNoneMatch === "*" && c.input.Bucket === "b")).toBe(true);
    const latest = s3.calls.slice(4);
    expect(latest.every((c) => c.input.IfNoneMatch === undefined)).toBe(true);
    expect(run[1]!.input.ContentType).toBe("text/html; charset=utf-8");
    expect(run[0]!.input.ContentType).toBe("application/json");
  });
  it("publishes one alarm message with a link when a canary leaked", async () => {
    const { out } = makeRun([leakRow, cleanRow]);
    const s3 = recorder();
    const sns = recorder();
    const links: unknown[][] = [];
    const r = await publish({ bucket: "b", runId: info.runId, dir: out, extra: [], topic: "arn:aws:sns:us-east-2:1:alarms" }, { s3, sns, presign: async (...a) => (links.push(a), "https://signed.example/report") });
    expect(r.notified).toBe(true);
    expect(links).toEqual([["b", `redteam/${info.runId}/report.html`, SEVEN_DAYS]]);
    expect(sns.calls).toHaveLength(1);
    expect(sns.calls[0]!.input).toMatchObject({ TopicArn: "arn:aws:sns:us-east-2:1:alarms" });
    expect(String(sns.calls[0]!.input.Message)).toContain("https://signed.example/report");
    expect(String(sns.calls[0]!.input.Message)).toContain("pt: 1");
  });
  it("sends nothing to the topic when there is no leak, no topic, or no sns client", async () => {
    const { out } = makeRun([cleanRow]);
    const sns = recorder();
    await publish({ bucket: "b", runId: "x", dir: out, extra: [], topic: "arn" }, { s3: recorder(), sns, presign: async () => "l" });
    expect(sns.calls).toHaveLength(0);
    const leak = makeRun([leakRow]);
    expect((await publish({ bucket: "b", runId: "x", dir: leak.out, extra: [] }, { s3: recorder(), sns, presign: async () => "l" })).notified).toBe(false);
    expect((await publish({ bucket: "b", runId: "x", dir: leak.out, extra: [], topic: "arn" }, { s3: recorder(), presign: async () => "l" })).notified).toBe(false);
    expect(await notifyLeaks(sns, "arn", buildSummary([], info), "l", "b")).toBe(false);
  });
  it("a second upload to the same run folder is refused by S3 (the error reaches the caller)", async () => {
    const { out } = makeRun([cleanRow]);
    const s3 = { send: async () => { throw Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed" }); } };
    await expect(uploadRun(s3, "b", "x", [{ path: join(out, "summary.json"), name: "summary.json" }])).rejects.toThrow("PreconditionFailed");
    await expect(updateLatest(s3, "b", out)).rejects.toThrow();
  });
  it("writes a clear alarm message", () => {
    const s = buildSummary([leakRow].map((r) => ({ language: "pt", strategy: "plain", intent: "override", outcome: "leaked" as const, reason: "x", row: r })), info);
    const m = alarmMessage(s, "https://l", "bkt");
    expect(m.subject).toContain("1 canary leak(s)");
    expect(m.body).toContain("s3://bkt/redteam/2026-10-14T06-00-12Z/report.html");
    expect(m.body).toContain("scripts/redteam-latest.sh");
    expect(m.body).toContain("abcdef012345");
    expect(alarmMessage({ ...s, byLanguage: {} }, "l", "b").body).not.toContain("Leaks by language");
  });
  it("knows content types, presigns through the SDK and parses arguments", async () => {
    expect(contentType("a.json")).toBe("application/json");
    expect(contentType("a.html")).toContain("text/html");
    expect(contentType("a.bin")).toBe("application/octet-stream");
    const s3 = new S3Client({ region: "us-east-2", credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" } });
    const url = await defaultPresign(s3)("bkt", "redteam/x/report.html", 60);
    expect(url).toContain("https://bkt.s3.us-east-2.amazonaws.com/redteam/x/report.html");
    expect(url).toContain("X-Amz-Expires=60");
    const a = parsePublishArgs(["--bucket", "b", "--run-id", "r", "--dir", "/tmp/d", "--topic", "t", "--extra", "x.json", "y.json"]);
    expect(a).toMatchObject({ bucket: "b", runId: "r", dir: "/tmp/d", topic: "t", extra: ["x.json", "y.json"] });
    expect(parsePublishArgs(["--bucket", "b", "--run-id", "r", "--dir", "/tmp/d"])).toMatchObject({ extra: [] });
    expect(parsePublishArgs(["--bucket", "b", "--run-id", "r", "--dir", "/tmp/d"]).topic).toBeUndefined();
    expect(() => parsePublishArgs(["--bucket", "b"])).toThrow("usage");
  });
});
