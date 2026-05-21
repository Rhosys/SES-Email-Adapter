import { DateTime } from "luxon";
import type { Signal, SignalType } from "../types/index.js";
import type { Logger } from "../logger.js";
import type { Result } from "neverthrow";
import type { DbError } from "../errors.js";
import { generateId } from "../utils/id.js";

// ---------------------------------------------------------------------------
// System Signal Creator
// Creates real Signal objects for system-generated notifications (rule/template
// failures, auto-send blocks). These are stored alongside email/user signals
// in the same table and appear in the arc's signal thread.
// ---------------------------------------------------------------------------

export interface SignalStore {
  saveSignal(signal: Signal): Promise<Result<void, DbError>>;
}

export interface SystemSignalCreator {
  createInvalidRuleFunctionSignal(opts: {
    accountId: string;
    arcId: string;
    recipientAddress: string;
    resourceName: string;
    issue: string;
  }): Promise<void>;

  createInvalidTemplateFunctionSignal(opts: {
    accountId: string;
    arcId: string;
    recipientAddress: string;
    resourceName: string;
    functionName: string;
    issue: string;
  }): Promise<void>;

  createAutoSendBlockedSignal(opts: {
    accountId: string;
    arcId: string;
    recipientAddress: string;
    fromAddress: string;
    replyToAddress: string;
  }): Promise<void>;
}

export class DynamoSystemSignalCreator implements SystemSignalCreator {
  private readonly logger: Logger;
  private readonly signalStore: SignalStore;

  constructor(logger: Logger, signalStore: SignalStore) {
    this.logger = logger;
    this.signalStore = signalStore;
  }

  async createInvalidRuleFunctionSignal(opts: {
    accountId: string;
    arcId: string;
    recipientAddress: string;
    resourceName: string;
    issue: string;
  }): Promise<void> {
    const description = `rule "${opts.resourceName}": ${opts.issue}`;
    await this.saveSystemSignal({
      type: "invalid_rule_function",
      accountId: opts.accountId,
      arcId: opts.arcId,
      recipientAddress: opts.recipientAddress,
      subject: description,
    });
  }

  async createInvalidTemplateFunctionSignal(opts: {
    accountId: string;
    arcId: string;
    recipientAddress: string;
    resourceName: string;
    functionName: string;
    issue: string;
  }): Promise<void> {
    const description = `template "${opts.resourceName}" function "${opts.functionName}": ${opts.issue}`;
    await this.saveSystemSignal({
      type: "invalid_template_function",
      accountId: opts.accountId,
      arcId: opts.arcId,
      recipientAddress: opts.recipientAddress,
      subject: description,
    });
  }

  async createAutoSendBlockedSignal(opts: {
    accountId: string;
    arcId: string;
    recipientAddress: string;
    fromAddress: string;
    replyToAddress: string;
  }): Promise<void> {
    const description = `Auto-send suppressed for ${opts.recipientAddress}: Reply-To ${opts.replyToAddress} does not match From ${opts.fromAddress} and is not in approved senders`;
    await this.saveSystemSignal({
      type: "auto_send_blocked",
      accountId: opts.accountId,
      arcId: opts.arcId,
      recipientAddress: opts.recipientAddress,
      subject: description,
    });
  }

  private async saveSystemSignal(opts: {
    type: SignalType;
    accountId: string;
    arcId: string;
    recipientAddress: string;
    subject: string;
  }): Promise<void> {
    const id = generateId("sgn-");
    const timestamp = DateTime.utc().toISO()!;
    const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days

    const signal: Signal = {
      id,
      signalLookupId: id,
      arcId: opts.arcId,
      accountId: opts.accountId,
      source: "email",
      type: opts.type,
      status: "active",
      receivedAt: timestamp,
      from: { address: "system@internal" },
      to: [],
      cc: [],
      subject: opts.subject,
      attachments: [],
      headers: {},
      recipientAddress: opts.recipientAddress,
      workflow: "alert",
      workflowData: { workflow: "alert", eventType: "system_notification", service: "email-catcher", severity: "warning", requiresAction: false } as never,
      spamScore: 0,
      summary: "",
      s3Key: "",
      createdAt: timestamp,
      ttl,
    };

    try {
      const result = await this.signalStore.saveSignal(signal);
      if (result.isErr()) {
        this.logger.warn("Failed to save system signal.", {
          code: "system_signal.write_failed",
          accountId: opts.accountId,
          type: opts.type,
          error: result.error,
        });
      }
    } catch (e) {
      this.logger.warn("Failed to save system signal.", {
        code: "system_signal.write_failed",
        accountId: opts.accountId,
        type: opts.type,
        error: e,
      });
    }
  }
}
