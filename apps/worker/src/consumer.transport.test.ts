import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Consumer, SqsTransport, type QueueMessage, type QueueTransport } from "./consumer.js";
import type { Logger } from "./log.js";

const QUIZ = "6f1d1e0c-9a0b-4c43-8a6e-1f2d3c4b5a69";

describe("SqsTransport", () => {
  const make = (respond: (cmd: unknown) => unknown = () => ({})) => {
    const sent: unknown[] = [];
    const client = { send: async (c: unknown) => (sent.push(c), respond(c)) } as unknown as SQSClient;
    return { t: new SqsTransport(client, "http://sqs/q"), sent };
  };

  it("long-polls with the receive count and message attributes requested, and maps the messages", async () => {
    const { t, sent } = make(() => ({
      Messages: [
        { MessageId: "a", Body: "{}", ReceiptHandle: "ra", Attributes: { ApproximateReceiveCount: "3" }, MessageAttributes: { requestId: { StringValue: "req-1", DataType: "String" } } },
        { ReceiptHandle: "rb" }, // SQS fields missing: defaults
      ],
    }));
    const out = await t.receive(5, 20);
    expect(sent[0]).toBeInstanceOf(ReceiveMessageCommand);
    expect((sent[0] as ReceiveMessageCommand).input).toMatchObject({ QueueUrl: "http://sqs/q", MaxNumberOfMessages: 5, WaitTimeSeconds: 20, MessageSystemAttributeNames: ["ApproximateReceiveCount"] });
    expect(out).toEqual([
      { id: "a", body: "{}", receiveCount: 3, receiptHandle: "ra", requestId: "req-1" },
      { id: "", body: "", receiveCount: 1, receiptHandle: "rb", requestId: undefined },
    ]);
  });

  it("an empty poll (no Messages key) yields an empty list", async () => {
    expect(await make().t.receive(1, 0)).toEqual([]);
  });

  it("deletes by receipt handle", async () => {
    const { t, sent } = make();
    await t.delete("rh");
    expect(sent[0]).toBeInstanceOf(DeleteMessageCommand);
    expect((sent[0] as DeleteMessageCommand).input).toEqual({ QueueUrl: "http://sqs/q", ReceiptHandle: "rh" });
  });

  it("changes the visibility timeout by receipt handle", async () => {
    const { t, sent } = make();
    await t.setVisibility("rh", 42);
    expect(sent[0]).toBeInstanceOf(ChangeMessageVisibilityCommand);
    expect((sent[0] as ChangeMessageVisibilityCommand).input).toEqual({ QueueUrl: "http://sqs/q", ReceiptHandle: "rh", VisibilityTimeout: 42 });
  });
});

function recordingLogger() {
  const lines: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const mk = (): Logger => ({
    error: (obj, msg) => void lines.push({ level: "error", obj, msg }),
    warn: (obj, msg) => void lines.push({ level: "warn", obj, msg }),
    info: (obj, msg) => void lines.push({ level: "info", obj, msg }),
    debug: (obj, msg) => void lines.push({ level: "debug", obj, msg }),
    child: () => mk(),
  });
  return { log: mk(), lines };
}

describe("Consumer resilience (fake timers)", () => {
  afterEach(() => vi.useRealTimers());

  it("a failing receive is logged and the loop polls again after a pause instead of dying", async () => {
    vi.useFakeTimers();
    const { log, lines } = recordingLogger();
    let polls = 0;
    const t: QueueTransport = {
      receive: async () => {
        polls++;
        if (polls === 1) throw new Error("sqs unreachable");
        await new Promise((r) => setTimeout(r, 60_000)); // an empty long poll
        return [];
      },
      delete: async () => {},
      setVisibility: async () => {},
    };
    const c = new Consumer({ transport: t, concurrency: 1, visibilityTimeout: 360, waitSeconds: 0, log, handler: async () => ({ kind: "done" }) });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBe(1);
    expect(lines.filter((l) => l.msg === "receive failed")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(polls).toBe(1); // still backing off
    await vi.advanceTimersByTimeAsync(2);
    expect(polls).toBeGreaterThanOrEqual(2);
    const stopping = c.stop(10);
    await vi.advanceTimersByTimeAsync(60_000);
    await stopping;
  });

  it("while a job runs, the heartbeat extends the visibility timeout every third of it, and a failed heartbeat only warns", async () => {
    vi.useFakeTimers();
    const { log, lines } = recordingLogger();
    const visibility: [string, number][] = [];
    const deleted: string[] = [];
    let batch: QueueMessage[] = [{ id: "m", body: JSON.stringify({ v: 1, quizId: QUIZ }), receiveCount: 1, receiptHandle: "rh" }];
    const t: QueueTransport = {
      receive: async () => {
        const b = batch;
        batch = [];
        if (!b.length) await new Promise((r) => setTimeout(r, 60_000));
        return b;
      },
      delete: async (h) => void deleted.push(h),
      setVisibility: async (h, s) => {
        visibility.push([h, s]);
        if (visibility.length === 2) throw new Error("throttled");
      },
    };
    let finish!: () => void;
    const job = new Promise<void>((r) => (finish = r));
    const c = new Consumer({ transport: t, concurrency: 1, visibilityTimeout: 30, waitSeconds: 0, log, handler: async () => (await job, { kind: "done" as const }) });
    c.start();
    await vi.advanceTimersByTimeAsync(10_000); // 30s / 3
    expect(visibility).toEqual([["rh", 30]]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(visibility).toHaveLength(2);
    expect(lines.some((l) => l.level === "warn" && l.msg === "heartbeat failed")).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(deleted).toEqual(["rh"]);
    await vi.advanceTimersByTimeAsync(60_000); // heartbeat stopped with the job
    expect(visibility).toHaveLength(2);
    const stopping = c.stop(10);
    await vi.advanceTimersByTimeAsync(60_000);
    await stopping;
  });

  it("never runs more jobs than the concurrency allows: a full house waits for a slot instead of polling", async () => {
    const { log } = recordingLogger();
    const mkMsg = (h: string): QueueMessage => ({ id: h, body: JSON.stringify({ v: 1, quizId: QUIZ }), receiveCount: 1, receiptHandle: h });
    const batches = [[mkMsg("a")], [mkMsg("b")]];
    const asked: number[] = [];
    const t: QueueTransport = {
      receive: async (max) => {
        asked.push(max);
        return batches.shift() ?? (await new Promise((r) => setTimeout(r, 20)), []);
      },
      delete: async () => {},
      setVisibility: async () => {},
    };
    const done: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const c = new Consumer({ transport: t, concurrency: 1, visibilityTimeout: 360, waitSeconds: 0, log, handler: async () => (await gate, done.push("x"), { kind: "done" as const }) });
    c.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toEqual([1]); // "a" holds the only slot: no second receive yet
    release();
    await new Promise((r) => setTimeout(r, 80));
    await c.stop(1000);
    expect(done).toHaveLength(2);
  });
});
