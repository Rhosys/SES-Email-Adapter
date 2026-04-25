import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, PROCESSING_TABLE } from "./shared.js";
import type { SuppressedAddress } from "../types/index.js";

const FORWARD_TRACE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// ---------------------------------------------------------------------------
// ProcessingDatabase
// Owns: suppression list and global sender reputation in PROCESSING_TABLE
// ---------------------------------------------------------------------------

export class ProcessingDatabase {
  async suppressAddress(entry: SuppressedAddress): Promise<void> {
    await dynamo.send(new PutCommand({
      TableName: PROCESSING_TABLE,
      Item: { ...entry, pk: `SUPPRESS#${entry.address}`, sk: "SUPPRESS" },
    }));
  }

  async isAddressSuppressed(address: string): Promise<boolean> {
    const result = await dynamo.send(new GetCommand({
      TableName: PROCESSING_TABLE,
      Key: { pk: `SUPPRESS#${address}`, sk: "SUPPRESS" },
      ProjectionExpression: "address",
    }));
    return result.Item !== undefined;
  }

  async saveForwardTrace(messageId: string, accountId: string, toAddress: string): Promise<void> {
    await dynamo.send(new PutCommand({
      TableName: PROCESSING_TABLE,
      Item: {
        pk: `FWDMSG#${messageId}`,
        sk: "FWDMSG",
        accountId,
        toAddress,
        ttl: Math.floor(Date.now() / 1000) + FORWARD_TRACE_TTL_SECONDS,
      },
    }));
  }

  async getForwardTrace(messageId: string): Promise<{ accountId: string; toAddress: string } | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: PROCESSING_TABLE,
      Key: { pk: `FWDMSG#${messageId}`, sk: "FWDMSG" },
    }));
    if (!result.Item) return null;
    return { accountId: result.Item["accountId"] as string, toAddress: result.Item["toAddress"] as string };
  }

  async updateGlobalReputation(domain: string, update: { wasSpam: boolean; wasBlocked: boolean }): Promise<void> {
    const now = new Date().toISOString();
    const addParts = ["signalCount :one"];
    if (update.wasSpam) addParts.push("spamCount :one");
    if (update.wasBlocked) addParts.push("blockCount :one");

    await dynamo.send(new UpdateCommand({
      TableName: PROCESSING_TABLE,
      Key: { pk: `GREP#${domain}`, sk: "GLOBAL_REP" },
      UpdateExpression: `ADD ${addParts.join(", ")} SET lastSeenAt = :now, updatedAt = :now, #domain = :domain`,
      ExpressionAttributeNames: { "#domain": "domain" },
      ExpressionAttributeValues: { ":one": 1, ":now": now, ":domain": domain },
    }));
  }
}
