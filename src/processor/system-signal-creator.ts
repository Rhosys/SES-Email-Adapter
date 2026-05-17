import { randomUUID } from "crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, ACCOUNTS_TABLE } from "../database/shared.js";
import type { Logger } from "../logger.js";

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
    const id = randomUUID();
    const timestamp = new Date().toISOString();
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
}
