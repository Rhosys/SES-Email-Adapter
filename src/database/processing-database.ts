import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DateTime } from "luxon";
import { dynamo, PROCESSING_TABLE } from "./shared.js";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { SuppressedAddress } from "../types/index.js";

// ---------------------------------------------------------------------------
// ProcessingDatabase
// Owns: suppression list and global sender reputation in PROCESSING_TABLE
// ---------------------------------------------------------------------------

export class ProcessingDatabase {
  async suppressAddress(entry: SuppressedAddress): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new PutCommand({
        TableName: PROCESSING_TABLE,
        Item: { ...entry, pk: `SUPPRESS#${entry.address}`, sk: "SUPPRESS" },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async isAddressSuppressed(address: string): Promise<Result<boolean, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: PROCESSING_TABLE,
        Key: { pk: `SUPPRESS#${address}`, sk: "SUPPRESS" },
        ProjectionExpression: "address",
      }));
      return ok(res.Item !== undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateGlobalReputation(domain: string, update: { wasSpam: boolean; wasBlocked: boolean }): Promise<Result<void, DbError>> {
    const now = DateTime.utc().toISO()!;
    const addParts = ["signalCount :one"];
    if (update.wasSpam) addParts.push("spamCount :one");
    if (update.wasBlocked) addParts.push("blockCount :one");

    try {
      await dynamo.send(new UpdateCommand({
        TableName: PROCESSING_TABLE,
        Key: { pk: `GREP#${domain}`, sk: "GLOBAL_REP" },
        UpdateExpression: `ADD ${addParts.join(", ")} SET lastSeenAt = :now, updatedAt = :now, #domain = :domain`,
        ExpressionAttributeNames: { "#domain": "domain" },
        ExpressionAttributeValues: { ":one": 1, ":now": now, ":domain": domain },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }
}
