import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { DateTime } from "luxon";
import { dynamo, ACCOUNTS_TABLE } from "../database/shared.js";
import type { Logger } from "../logger.js";
import { generateId } from "../utils/id.js";

// ---------------------------------------------------------------------------
// System Signal Creator
// Writes a notification record to DynamoDB when user code produces invalid output.
// Stored in the accounts table as a per-account notification item.
// ---------------------------------------------------------------------------

export interface SystemSignalCreator {
  createInvalidOutputSignal(opts: {
    accountId: string;
    resourceType: "rule" | "template";
    resourceName: string;
    functionName?: string;
    issue: string;
  }): Promise<void>;

  createReplyTargetSuppressionSignal(opts: {
    accountId: string;
    fromAddress: string;
    replyToAddress: string;
    recipientAddress: string;
  }): Promise<void>;
}

export class DynamoSystemSignalCreator implements SystemSignalCreator {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async createInvalidOutputSignal(opts: {
    accountId: string;
    resourceType: "rule" | "template";
    resourceName: string;
    functionName?: string;
    issue: string;
  }): Promise<void> {
    const { accountId, resourceType, resourceName, functionName, issue } = opts;
    const id = generateId("sgn-");
    const timestamp = DateTime.utc().toISO()!;
    const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days

    const description = functionName
      ? `${resourceType} "${resourceName}" function "${functionName}": ${issue}`
      : `${resourceType} "${resourceName}": ${issue}`;

    try {
      await dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: {
          pk: `ACCT#${accountId}`,
          sk: `SYSSIG#${timestamp}#${id}`,
          id,
          signalLookupId: id,
          accountId,
          type: "invalid_output",
          resourceType,
          resourceName,
          ...(functionName ? { functionName } : {}),
          issue,
          description,
          createdAt: timestamp,
          ttl,
        },
      }));
    } catch (e) {
      // Best-effort — don't fail processing if notification write fails
      this.logger.warn("Failed to create system signal for invalid user code output.", {
        code: "system_signal.write_failed",
        accountId,
        resourceType,
        resourceName,
        functionName,
        issue,
        error: e,
      });
    }
  }

  async createReplyTargetSuppressionSignal(opts: {
    accountId: string;
    fromAddress: string;
    replyToAddress: string;
    recipientAddress: string;
  }): Promise<void> {
    const { accountId, fromAddress, replyToAddress, recipientAddress } = opts;
    const id = generateId("sgn-");
    const timestamp = DateTime.utc().toISO()!;
    const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days

    const description = `Auto-send suppressed for ${recipientAddress}: Reply-To ${replyToAddress} does not match From ${fromAddress} and is not in approved senders`;

    try {
      await dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: {
          pk: `ACCT#${accountId}`,
          sk: `SYSSIG#${timestamp}#${id}`,
          id,
          signalLookupId: id,
          accountId,
          type: "reply_target_suppression",
          fromAddress,
          replyToAddress,
          recipientAddress,
          description,
          createdAt: timestamp,
          ttl,
        },
      }));
    } catch (e) {
      // Best-effort — don't fail processing if notification write fails
      this.logger.warn("Failed to create system signal for reply-target suppression.", {
        code: "system_signal.write_failed",
        accountId,
        fromAddress,
        replyToAddress,
        recipientAddress,
        error: e,
      });
    }
  }
}
