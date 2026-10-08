import { describe, expect, it } from "vitest";
import { Consumer, type QueueMessage, type QueueTransport } from "./consumer.js";
import { createLogger, emitMetrics } from "./log.js";
import type { Outcome } from "./processor.js";

const QUIZ = "6f1d1e0c-9a0b-4c43-8a6e-1f2d3c4b5a69";
const msg = (over: Partial<QueueMessage> = {}): QueueMessage => ({ id: "m1", body: JSON.stringify({ v: 1, quizId: QUIZ }), receiveCount: 1, receiptHandle: "rh1", ...over });

function transport(batches: QueueMessage[][]) {
  const calls = { deleted: [] as string[], visibility: [] as [string, number][] };
  const t: QueueTransport = {
    async receive(max) {
      const next = batches.shift();
      if (next) {
        const [now, later] = [next.slice(0, max), next.slice(max)]; // like SQS: never more than asked
        if (later.length) batches.unshift(later);
        return now;
      }
      await new Promise((r) => setTimeout(r, 10));
      return [];
    },
    async delete(h) { calls.deleted.push(h); },
    async setVisibility(h, s) { calls.visibility.push([h, s]); },
  };
  return { t, calls };
}
const run = async (batches: QueueMessage[][], handler: (c: { count: number }) => Promise<Outcome>, concurrency = 1) => {
  const { t, calls } = transport(batches);
  const handled: number[] = [];
  const c = new Consumer({ transport: t, concurrency, visibilityTimeout: 360, waitSeconds: 0, log: createLogger("error"), handler: async (_m, r) => (handled.push(r.count), handler(r)) });
  c.start();
  await new Promise((r) => setTimeout(r, 120));
  await c.stop(1000);
  return { calls, handled };
};

describe("Consumer", () => {
  it.each<[string, Outcome]>([["done", { kind: "done" }], ["skipped", { kind: "skipped", reason: "ready" }], ["failed", { kind: "failed", error: "x" }]])("deletes the message after a %s outcome", async (_n, outcome) => {
    const { calls } = await run([[msg()]], async () => outcome);
    expect(calls.deleted).toEqual(["rh1"]);
  });

  it("retry: keeps the message and delays redelivery with exponential backoff", async () => {
    const { calls } = await run([[msg({ receiveCount: 1 })], [msg({ receiveCount: 3, receiptHandle: "rh3" })]], async () => ({ kind: "retry", error: "e" }));
    expect(calls.deleted).toEqual([]);
    expect(calls.visibility).toEqual([["rh1", 20], ["rh3", 80]]);
  });

  it("exhausted: never deletes (SQS moves it to the DLQ)", async () => {
    const { calls } = await run([[msg({ receiveCount: 3 })]], async () => ({ kind: "exhausted", error: "e" }));
    expect(calls.deleted).toEqual([]);
  });

  it("drops poison messages without calling the handler", async () => {
    const { calls, handled } = await run([[msg({ body: "not json" }), msg({ body: JSON.stringify({ v: 9 }), receiptHandle: "rh2" })]], async () => ({ kind: "done" }));
    expect(handled).toEqual([]);
    expect(calls.deleted).toEqual(["rh1", "rh2"]);
  });

  it("a crashing handler leaves the message for redelivery", async () => {
    const { calls } = await run([[msg()]], async () => { throw new Error("db down"); });
    expect(calls.deleted).toEqual([]);
  });

  it("respects the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    await run([[msg({ receiptHandle: "a" }), msg({ receiptHandle: "b" }), msg({ receiptHandle: "c" })]], async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return { kind: "done" };
    }, 2);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("stop() waits for the in-flight job before returning", async () => {
    const { t, calls } = transport([[msg()]]);
    let finished = false;
    const c = new Consumer({ transport: t, concurrency: 1, visibilityTimeout: 360, waitSeconds: 0, log: createLogger("error"), handler: async () => { await new Promise((r) => setTimeout(r, 80)); finished = true; return { kind: "done" }; } });
    c.start();
    await new Promise((r) => setTimeout(r, 20));
    await c.stop(2000);
    expect(finished).toBe(true);
    expect(calls.deleted).toEqual(["rh1"]);
  });
});

describe("Consumer shutdown", () => {
  it("a long poll that returns AFTER stop() is released back to the queue, never processed (rolling deploys)", async () => {
    let release!: (m: QueueMessage[]) => void;
    const inFlightPoll = new Promise<QueueMessage[]>((r) => (release = r));
    const calls = { deleted: [] as string[], visibility: [] as [string, number][] };
    let polls = 0;
    const t: QueueTransport = {
      receive: async () => (polls++ === 0 ? inFlightPoll : []),
      delete: async (h) => void calls.deleted.push(h),
      setVisibility: async (h, s) => void calls.visibility.push([h, s]),
    };
    let handled = 0;
    const c = new Consumer({ transport: t, concurrency: 1, visibilityTimeout: 360, waitSeconds: 0, log: createLogger("error"), handler: async () => (handled++, { kind: "done" as const }) });
    c.start();
    await new Promise((r) => setTimeout(r, 10));
    const stopping = c.stop(1000); // SIGTERM arrives while the poll is still waiting
    release([msg()]); // ...and the poll then returns a message
    await stopping;
    expect(handled).toBe(0);
    expect(calls.deleted).toEqual([]);
    expect(calls.visibility).toEqual([["rh1", 0]]); // visible again immediately for another worker
  });
});

describe("logging", () => {
  it("redacts secrets and emits valid CloudWatch EMF", () => {
    const lines: string[] = [];
    createLogger("info", {}, (l) => lines.push(l)).info({ apiKey: "sk-123", nested: { Authorization: "Bearer x", ok: 1 } }, "hello");
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ msg: "hello", apiKey: "[redacted]", nested: { Authorization: "[redacted]", ok: 1 } });
    expect(lines[0]).not.toContain("sk-123");

    const out: string[] = [];
    emitMetrics({ QuizQuality: { value: 0.8 }, JobSucceeded: { value: 1, unit: "Count" } }, (l) => out.push(l));
    const emf = JSON.parse(out[0]!);
    expect(emf._aws.CloudWatchMetrics[0]).toMatchObject({ Namespace: "QuizForge", Dimensions: [["Service"]] });
    expect(emf.QuizQuality).toBe(0.8);
  });
});
