import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ResultAsync } from "neverthrow";
import { dbError } from "../errors.js";
import type { DbError } from "../errors.js";
import type { SqsDispatcher, SideEffectPayload } from "./processor.js";

export class SqsDispatcherImpl implements SqsDispatcher {
  private readonly client: SQSClient;
  private readonly queueUrl: string;

  constructor(queueUrl: string, client: SQSClient) {
    this.queueUrl = queueUrl;
    this.client = client;
  }

  sendMessage(payload: SideEffectPayload): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      this.client.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(payload),
          MessageAttributes: {
            messageType: { DataType: "String", StringValue: "side_effect" },
          },
        }),
      ),
      (e) => dbError(e instanceof Error ? e : new Error(String(e))),
    ).map(() => undefined);
  }
}
