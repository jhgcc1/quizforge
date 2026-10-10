import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { QuizJobMessageSchema, type QuizJobMessage } from "@quizforge/core";
import type { Logger } from "./log.js";
import type { Outcome } from "./processor.js";

export interface QueueMessage {
  id: string;
  body: string;
  receiveCount: number;
  receiptHandle: string;
  requestId?: string | undefined;
}

/** The slice of SQS the consumer needs, so the loop can be tested without AWS. */
export interface QueueTransport {
  receive(max: number, waitSeconds: number): Promise<QueueMessage[]>;
  delete(receiptHandle: string): Promise<void>;
  setVisibility(receiptHandle: string, seconds: number): Promise<void>;
}

export class SqsTransport implements QueueTransport {
  constructor(private readonly client: SQSClient, private readonly queueUrl: string) {}
  async receive(max: number, waitSeconds: number): Promise<QueueMessage[]> {
    const res = await this.client.send(
      new ReceiveMessageCommand({ QueueUrl: this.queueUrl, MaxNumberOfMessages: max, WaitTimeSeconds: waitSeconds, MessageSystemAttributeNames: ["ApproximateReceiveCount"], MessageAttributeNames: ["All"] }),
    );
    return (res.Messages ?? []).map((m: Message) => ({
      id: m.MessageId ?? "",
      body: m.Body ?? "",
      receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 1),
      receiptHandle: m.ReceiptHandle!,
      requestId: m.MessageAttributes?.requestId?.StringValue,
    }));
  }
  async delete(receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }));
  }
  async setVisibility(receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }));
  }
}

export interface ConsumerOptions<M extends { requestId?: string | undefined } = QuizJobMessage> {
  transport: QueueTransport;
  /** Validates the body of a message of THIS queue (generation jobs by default; the scorer passes its own schema). */
  parse?: (raw: unknown) => M;
  handler: (msg: M, receive: { count: number }) => Promise<Outcome>;
  log: Logger;
  concurrency: number;
  visibilityTimeout: number;
  waitSeconds?: number;
  /** Delay (s) before a transient failure is redelivered: min(cap, base * 2^(receiveCount-1)). */
  backoffBaseSeconds?: number;
  backoffCapSeconds?: number;
}

/**
 * Long-poll loop. A message is deleted only after its outcome is durable in Postgres; while a job
 * runs, a heartbeat keeps extending the visibility timeout so SQS does not hand the same job to a
 * second worker. `stop()` finishes in-flight jobs and returns.
 */
export class Consumer<M extends { requestId?: string | undefined } = QuizJobMessage> {
  private stopping = false;
  private inFlight = new Set<Promise<void>>();
  private loop: Promise<void> | undefined;
  /** Last time the poll loop made progress; the health endpoint uses it to detect a wedged worker. */
  lastActivity = Date.now();

  constructor(private readonly o: ConsumerOptions<M>) {}

  start(): void {
    this.loop = this.run();
  }

  async stop(graceMs: number): Promise<void> {
    this.stopping = true;
    await Promise.race([Promise.allSettled([this.loop, ...this.inFlight]), new Promise((r) => setTimeout(r, graceMs))]);
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      this.lastActivity = Date.now();
      const free = this.o.concurrency - this.inFlight.size;
      if (free <= 0) {
        await Promise.race(this.inFlight);
        continue;
      }
      let messages: QueueMessage[];
      try {
        messages = await this.o.transport.receive(Math.min(free, 10), this.o.waitSeconds ?? 20);
      } catch (err) {
        this.o.log.error({ err }, "receive failed");
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (this.stopping) {
        // A long poll that was already in flight when shutdown began can still return messages. Starting them
        // now would get them killed mid-job when the process exits (and lost for the whole visibility timeout),
        // so hand them straight back to the queue for another worker.
        await Promise.allSettled(messages.map((m) => this.o.transport.setVisibility(m.receiptHandle, 0)));
        break;
      }
      for (const m of messages) {
        const p: Promise<void> = this.handle(m).finally(() => this.inFlight.delete(p));
        this.inFlight.add(p);
      }
    }
  }

  private async handle(m: QueueMessage): Promise<void> {
    const t = this.o.transport;
    const log = this.o.log.child({ messageId: m.id });
    let parsed: M;
    try {
      parsed = (this.o.parse ?? (QuizJobMessageSchema.parse as unknown as (raw: unknown) => M))(JSON.parse(m.body));
    } catch (err) {
      // Poison message: it can never succeed. Drop it (and say so loudly) rather than loop to the DLQ.
      log.error({ err, body: m.body.slice(0, 200) }, "invalid message dropped");
      await t.delete(m.receiptHandle).catch(() => undefined);
      return;
    }
    const beat = setInterval(() => {
      t.setVisibility(m.receiptHandle, this.o.visibilityTimeout).catch((err) => log.warn({ err }, "heartbeat failed"));
    }, (this.o.visibilityTimeout * 1000) / 3);
    try {
      const outcome = await this.o.handler({ ...parsed, requestId: parsed.requestId ?? m.requestId }, { count: m.receiveCount });
      switch (outcome.kind) {
        case "done":
        case "skipped":
        case "failed":
          await t.delete(m.receiptHandle);
          break;
        case "retry": {
          const delay = Math.min(this.o.backoffCapSeconds ?? 300, (this.o.backoffBaseSeconds ?? 20) * 2 ** (m.receiveCount - 1));
          await t.setVisibility(m.receiptHandle, delay);
          log.warn({ delay, error: outcome.error }, "will retry");
          break;
        }
        case "exhausted":
          // not deleted on purpose: SQS moves it to the DLQ, which raises the alarm
          await t.setVisibility(m.receiptHandle, 1).catch(() => undefined);
          log.error({ error: outcome.error }, "attempts exhausted; message goes to the DLQ");
          break;
      }
    } catch (err) {
      // e.g. the database was unreachable: leave the message, SQS redelivers after the visibility timeout
      log.error({ err }, "unexpected processing error");
    } finally {
      clearInterval(beat);
    }
  }
}
