import type { DbError, Result } from "../errors.js";
import type { Logger } from "../logger.js";
import type { SignalQueue } from "../messaging/signal-queue.js";

export interface DraftSendPayload {
  signalId: string;
  accountId: string;
  threadId: string;
  sendInitiatedAt: string;
}

export interface DraftSendDispatch {
  dispatch(payload: DraftSendPayload, delaySeconds: number): Promise<Result<void, DbError>>;
}

export class DraftSendDispatcher implements DraftSendDispatch {
  private readonly queue: SignalQueue;
  private readonly logger: Logger;

  constructor(queue: SignalQueue, logger: Logger) {
    this.queue = queue;
    this.logger = logger;
  }

  async dispatch(payload: DraftSendPayload, delaySeconds: number): Promise<Result<void, DbError>> {
    this.logger.trackPoint("draft_send_dispatch_start");
    const result = await this.queue.send("draft_send", payload, { delaySeconds });
    if (result.isOk()) {
      this.logger.trackPoint("draft_send_dispatch_complete");
    }
    return result;
  }
}
