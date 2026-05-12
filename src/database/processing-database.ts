import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ResultAsync } from "neverthrow";
import { dynamo, PROCESSING_TABLE } from "./shared.js";
import { dbError } from "../errors.js";
import type { DbError } from "../errors.js";
import type { SuppressedAddress } from "../types/index.js";

// ---------------------------------------------------------------------------
// ProcessingDatabase
// Owns: suppression list and global sender reputation in PROCESSING_TABLE
// ---------------------------------------------------------------------------

export class ProcessingDatabase {
  suppressAddress(entry: SuppressedAddress): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new PutCommand({
        TableName: PROCESSING_TABLE,
        Item: { ...entry, pk: `SUPPRESS#${entry.address}`, sk: "SUPPRESS" },
      })).then(() => undefined),
      (e) => dbError(e instanceof Error ? e : new Error(String(e))),
    );
  }

  isAddressSuppressed(address: string): ResultAsync<boolean, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new GetCommand({
        TableName: PROCESSING_TABLE,
        Key: { pk: `SUPPRESS#${address}`, sk: "SUPPRESS" },
        ProjectionExpression: "address",
      })).then(res => res.Item !== undefined),
      (e) => dbError(e instanceof Error ? e : new Error(String(e))),
    );
  }

  updateGlobalReputation(domain: string, update: { wasSpam: boolean; wasBlocked: boolean }): ResultAsync<void, DbError> {
    const now = new Date().toISOString();
    const addParts = ["signalCount :one"];
    if (update.wasSpam) addParts.push("spamCount :one");
    if (update.wasBlocked) addParts.push("blockCount :one");

    return ResultAsync.fromPromise(
      dynamo.send(new UpdateCommand({
        TableName: PROCESSING_TABLE,
        Key: { pk: `GREP#${domain}`, sk: "GLOBAL_REP" },
        UpdateExpression: `ADD ${addParts.join(", ")} SET lastSeenAt = :now, updatedAt = :now, #domain = :domain`,
        ExpressionAttributeNames: { "#domain": "domain" },
        ExpressionAttributeValues: { ":one": 1, ":now": now, ":domain": domain },
      })).then(() => undefined),
      (e) => dbError(e instanceof Error ? e : new Error(String(e))),
    );
  }
}
