import type { DbError, Result } from "../errors.js";
import type { Logger } from "../logger.js";
import type { SqsDispatcher, SideEffectPayload } from "./processor.js";
import type { SignalQueue } from "../messaging/signal-queue.js";

export class SqsDispatcherImpl implements SqsDispatcher {
  private readonly queue: SignalQueue;
  private readonly logger: Logger;

  constructor(queue: SignalQueue, logger: Logger) {
    this.queue = queue;
    this.logger = logger;
  }

  async sendMessage(payload: SideEffectPayload): Promise<Result<void, DbError>> {
    this.logger.trackPoint("sqs_send_start");
    const result = await this.queue.send("side_effect", payload);
    if (result.isOk()) {
      this.logger.trackPoint("sqs_send_complete");
    }
    return result;
  }
}
