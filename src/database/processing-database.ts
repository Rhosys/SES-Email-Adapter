import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
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
  async suppressAddress(entry: SuppressedAddress): Promise<Result<{ bounceCount: number }, DbError>> {
    try {
      const setParts = [
        "#address = :address",
        "#reason = :reason",
        "#suppressedAt = :suppressedAt",
        "#feedback = :feedback",
        "#sesMessageId = :sesMessageId",
        "#linkedSignalId = :linkedSignalId",
      ];
      const exprNames: Record<string, string> = {
        "#address": "address",
        "#reason": "reason",
        "#suppressedAt": "suppressedAt",
        "#feedback": "feedback",
        "#sesMessageId": "sesMessageId",
        "#linkedSignalId": "linkedSignalId",
        "#bounceCount": "bounceCount",
      };
      const exprValues: Record<string, unknown> = {
        ":address": entry.address,
        ":reason": entry.reason,
        ":suppressedAt": entry.suppressedAt,
        ":feedback": entry.feedback ?? null,
        ":sesMessageId": entry.sesMessageId ?? null,
        ":linkedSignalId": entry.linkedSignalId ?? null,
        ":one": 1,
      };

      if (entry.ttl !== undefined) {
        setParts.push("#ttl = :ttl");
        exprNames["#ttl"] = "ttl";
        exprValues[":ttl"] = entry.ttl;
      }

      const res = await dynamo.send(new UpdateCommand({
        TableName: PROCESSING_TABLE,
        Key: { pk: `SUPPRESS#${entry.address}`, sk: "SUPPRESS" },
        UpdateExpression: `SET ${setParts.join(", ")} ADD #bounceCount :one`,
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues,
        ReturnValues: "ALL_NEW",
      }));
      const bounceCount = (res.Attributes?.bounceCount as number) ?? 1;
      return ok({ bounceCount });
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

  async updateGlobalReputation(domain: string, status: "quarantine_visible" | "quarantine_hidden" | "block_hidden" | "block_reject" | "report_violation"): Promise<Result<void, DbError>> {
    const now = DateTime.utc().toISO()!;
    const fieldMap: Record<typeof status, string> = {
      quarantine_visible: "quarantineVisibleCount",
      quarantine_hidden: "quarantineHiddenCount",
      block_hidden: "blockHiddenCount",
      block_reject: "blockRejectCount",
      report_violation: "reportViolationCount",
    };
    const countField = fieldMap[status];

    try {
      await dynamo.send(new UpdateCommand({
        TableName: PROCESSING_TABLE,
        Key: { pk: `GREP#${domain}`, sk: "GLOBAL_REP" },
        UpdateExpression: `ADD #countField :one SET #lastSeenAt = :now, #updatedAt = :now, #domain = :domain`,
        ExpressionAttributeNames: { "#countField": countField, "#lastSeenAt": "lastSeenAt", "#updatedAt": "updatedAt", "#domain": "domain" },
        ExpressionAttributeValues: { ":one": 1, ":now": now, ":domain": domain },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }
}
