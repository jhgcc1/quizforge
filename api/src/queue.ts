import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { QuizJobMessage } from "@quizforge/core";

export interface QuizQueue {
  publish(message: QuizJobMessage): Promise<void>;
}

export class SqsQuizQueue implements QuizQueue {
  private readonly client: SQSClient;
  constructor(
    private readonly queueUrl: string,
    client?: SQSClient,
  ) {
    this.client = client ?? new SQSClient({});
  }
  async publish(message: QuizJobMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
        ...(message.requestId ? { MessageAttributes: { requestId: { DataType: "String", StringValue: message.requestId } } } : {}),
      }),
    );
  }
}

/** For tests and single-process local runs. */
export class MemoryQuizQueue implements QuizQueue {
  readonly messages: QuizJobMessage[] = [];
  failNext = false;
  async publish(message: QuizJobMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("queue unavailable");
    }
    this.messages.push(message);
  }
}
