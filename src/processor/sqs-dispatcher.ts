import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { Logger } from "../logger.js";
import type { SqsDispatcher, SideEffectPayload } from "./processor.js";

export class SqsDispatcherImpl implements SqsDispatcher {
  private readonly client: SQSClient;
  private readonly queueUrl: string;
  private readonly logger: Logger;

  constructor(queueUrl: string, client: SQSClient, logger: Logger) {
    this.queueUrl = queueUrl;
    this.client = client;
    this.logger = logger;
  }

  async sendMessage(payload: SideEffectPayload): Promise<Result<void, DbError>> {
    this.logger.trackPoint("sqs_send_start");
    try {
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(payload),
          MessageAttributes: {
            messageType: { DataType: "String", StringValue: "side_effect" },
          },
        }),
      );
      this.logger.trackPoint("sqs_send_complete");
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }
}
