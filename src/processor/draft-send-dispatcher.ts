import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { Logger } from "../logger.js";
import { SQS_MESSAGE_TYPES } from "../types/index.js";

export interface DraftSendPayload {
  signalId: string;
  accountId: string;
  sendInitiatedAt: string;
}

export interface DraftSendDispatch {
  dispatch(payload: DraftSendPayload, delaySeconds: number): Promise<Result<void, DbError>>;
}

export class DraftSendDispatcher implements DraftSendDispatch {
  private readonly client: SQSClient;
  private readonly queueUrl: string;
  private readonly logger: Logger;

  constructor(queueUrl: string, client: SQSClient, logger: Logger) {
    this.queueUrl = queueUrl;
    this.client = client;
    this.logger = logger;
  }

  async dispatch(payload: DraftSendPayload, delaySeconds: number): Promise<Result<void, DbError>> {
    this.logger.trackPoint("draft_send_dispatch_start");
    try {
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(payload),
          DelaySeconds: delaySeconds,
          MessageAttributes: {
            messageType: { DataType: "String", StringValue: SQS_MESSAGE_TYPES[2] },
            callerInvocationId: { DataType: "String", StringValue: this.logger.getInvocationId() || "<NULL>" },
          },
        }),
      );
      this.logger.trackPoint("draft_send_dispatch_complete");
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }
}
