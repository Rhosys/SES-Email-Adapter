import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, PROCESSING_TABLE } from "./shared.js";
import type { SuppressedAddress } from "../types/index.js";

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
