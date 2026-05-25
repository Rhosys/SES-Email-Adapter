import { DateTime } from "luxon";
import type { Signal, SignalType, InvalidRuleFunctionData, InvalidTemplateFunctionData, AutoSendBlockedData } from "../types/index.js";
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
  saveSignal(signal: Signal<InvalidRuleFunctionData> | Signal<InvalidTemplateFunctionData> | Signal<AutoSendBlockedData>): Promise<Result<void, DbError>>;
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
    const id = generateId("sgn-");
    const timestamp = DateTime.utc().toISO()!;
    const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days

    const signal: Signal<InvalidRuleFunctionData> = {
      id,
      signalLookupId: id,
      arcId: opts.arcId,
      accountId: opts.accountId,
      source: "email",
      type: "invalid_rule_function",
      status: "active",
      createdAt: timestamp,
      ttl,
      data: {
        resourceName: opts.resourceName,
        issue: opts.issue,
      },
    };

    await this.saveSystemSignal(signal, opts.accountId, "invalid_rule_function");
  }

  async createInvalidTemplateFunctionSignal(opts: {
    accountId: string;
    arcId: string;
    recipientAddress: string;
    resourceName: string;
    functionName: string;
    issue: string;
  }): Promise<void> {
    const id = generateId("sgn-");
    const timestamp = DateTime.utc().toISO()!;
    const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days

    const signal: Signal<InvalidTemplateFunctionData> = {
      id,
      signalLookupId: id,
      arcId: opts.arcId,
      accountId: opts.accountId,
      source: "email",
      type: "invalid_template_function",
      status: "active",
      createdAt: timestamp,
      ttl,
      data: {
        resourceName: opts.resourceName,
        functionName: opts.functionName,
        issue: opts.issue,
      },
    };

    await this.saveSystemSignal(signal, opts.accountId, "invalid_template_function");
  }

  async createAutoSendBlockedSignal(opts: {
    accountId: string;
    arcId: string;
    recipientAddress: string;
    fromAddress: string;
    replyToAddress: string;
  }): Promise<void> {
    const id = generateId("sgn-");
    const timestamp = DateTime.utc().toISO()!;
    const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days

    const signal: Signal<AutoSendBlockedData> = {
      id,
      signalLookupId: id,
      arcId: opts.arcId,
      accountId: opts.accountId,
      source: "email",
      type: "auto_send_blocked",
      status: "active",
      createdAt: timestamp,
      ttl,
      data: {
        fromAddress: opts.fromAddress,
        replyToAddress: opts.replyToAddress,
        recipientAddress: opts.recipientAddress,
      },
    };

    await this.saveSystemSignal(signal, opts.accountId, "auto_send_blocked");
  }

  private async saveSystemSignal(
    signal: Signal<InvalidRuleFunctionData> | Signal<InvalidTemplateFunctionData> | Signal<AutoSendBlockedData>,
    accountId: string,
    type: SignalType,
  ): Promise<void> {
    try {
      const result = await this.signalStore.saveSignal(signal);
      if (result.isErr()) {
        this.logger.warn("Failed to save system signal.", {
          code: "system_signal.write_failed",
          accountId,
          type,
          error: result.error,
        });
      }
    } catch (e) {
      this.logger.warn("Failed to save system signal.", {
        code: "system_signal.write_failed",
        accountId,
        type,
        error: e,
      });
    }
  }
}
