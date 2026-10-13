import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
import { MemoryQuizQueue, SqsQuizQueue } from "./queue.js";

const QUIZ = "6f1d1e0c-9a0b-4c43-8a6e-1f2d3c4b5a69";

function fakeSqs() {
  const sent: SendMessageCommand[] = [];
  const client = { send: async (c: SendMessageCommand) => void sent.push(c) } as unknown as SQSClient;
  return { client, sent };
}

describe("SqsQuizQueue", () => {
  it("sends the JSON message to the queue, carrying the request id as a message attribute", async () => {
    const { client, sent } = fakeSqs();
    await new SqsQuizQueue("http://sqs/q", client).publish({ v: 1, quizId: QUIZ, requestId: "req-1" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input).toEqual({
      QueueUrl: "http://sqs/q",
      MessageBody: JSON.stringify({ v: 1, quizId: QUIZ, requestId: "req-1" }),
      MessageAttributes: { requestId: { DataType: "String", StringValue: "req-1" } },
    });
  });

  it("omits the attribute when there is no request id", async () => {
    const { client, sent } = fakeSqs();
    await new SqsQuizQueue("http://sqs/q", client).publish({ v: 1, quizId: QUIZ });
    expect(sent[0]!.input).not.toHaveProperty("MessageAttributes");
  });

  it("propagates a send failure so the API can answer 503", async () => {
    const client = { send: async () => { throw new Error("throttled"); } } as unknown as SQSClient;
    await expect(new SqsQuizQueue("q", client).publish({ v: 1, quizId: QUIZ })).rejects.toThrow("throttled");
  });

  it("builds its own client when none is injected", () => {
    expect(() => new SqsQuizQueue("http://sqs/q")).not.toThrow();
  });
});

describe("MemoryQuizQueue", () => {
  it("records messages and fails exactly once when asked to", async () => {
    const q = new MemoryQuizQueue();
    q.failNext = true;
    await expect(q.publish({ v: 1, quizId: QUIZ })).rejects.toThrow("queue unavailable");
    await q.publish({ v: 1, quizId: QUIZ });
    expect(q.messages).toHaveLength(1);
  });
});
