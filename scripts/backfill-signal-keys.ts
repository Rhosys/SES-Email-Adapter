/**
 * Backfill script: Migrate old-format signal IDs to new `sgn-` prefixed IDs.
 *
 * For each signal with an old-format ID (SES#*, USR#*, SYS#*):
 * - Generates a new `sgn-` ID
 * - Sets `signalLookupId` based on source
 * - Updates `gsi1sk` to the new `sgn-` ID
 * - Updates `gsi1pk` to include `ACCT#{accountId}#` prefix
 * - Stores old ID in `legacyId` for traceability
 *
 * Idempotent: skips signals that already have `sgn-` IDs.
 *
 * Usage:
 *   npx tsx scripts/backfill-signal-keys.ts
 *   npx tsx scripts/backfill-signal-keys.ts --dry-run
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { generateId } from "../src/utils/id.js";
import { SIGNALS_TABLE } from "../src/database/shared.js";

const dryRun = process.argv.includes("--dry-run");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

interface OldSignalItem {
  pk: string;
  sk: string;
  id: string;
  accountId: string;
  threadId?: string;
  status: string;
  gsi1pk?: string;
  gsi1sk?: string;
  [key: string]: unknown;
}

function isOldFormatId(id: string): boolean {
  return id.startsWith("SES#") || id.startsWith("USR#") || id.startsWith("SYS#");
}

function deriveSignalLookupId(oldId: string, newSgnId: string): string {
  if (oldId.startsWith("SES#")) {
    // Extract the SES message ID from "SES#{sesMessageId}"
    const sesMessageId = oldId.slice(4);
    return `ses-${sesMessageId}`;
  }
  // USR# and SYS# signals use the new sgn- ID as their lookup ID
  return newSgnId;
}

function deriveNewGsi1pk(item: OldSignalItem): string {
  const { accountId, threadId, status, gsi1pk } = item;

  // If it already has the new ACCT# prefix format, leave it alone
  if (gsi1pk?.startsWith("ACCT#")) {
    return gsi1pk;
  }

  // Old format: ARCSIG#{threadId} → New: ACCT#{accountId}#ARC#{threadId}
  if (gsi1pk?.startsWith("ARCSIG#")) {
    const oldThreadId = gsi1pk.slice(7);
    return `ACCT#${accountId}#ARC#${oldThreadId}`;
  }

  // Old format: QUARANTINED#{accountId} → New: ACCT#{accountId}#QUARANTINED
  if (gsi1pk?.startsWith("QUARANTINED#")) {
    return `ACCT#${accountId}#QUARANTINED`;
  }

  // Old format: BLOCKED#{accountId} → New: ACCT#{accountId}#BLOCKED
  if (gsi1pk?.startsWith("BLOCKED#")) {
    return `ACCT#${accountId}#BLOCKED`;
  }

  // Fallback: derive from current state
  if (threadId) {
    return `ACCT#${accountId}#ARC#${threadId}`;
  }
  if (status === "quarantine_visible" || status === "quarantine_hidden") {
    return `ACCT#${accountId}#QUARANTINED`;
  }
  return `ACCT#${accountId}#BLOCKED`;
}

async function backfill(): Promise<void> {
  console.log(`Starting signal backfill${dryRun ? " (DRY RUN)" : ""}...`);
  console.log(`Table: ${SIGNALS_TABLE}`);

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await dynamo.send(new ScanCommand({
      TableName: SIGNALS_TABLE,
      ExclusiveStartKey: exclusiveStartKey,
    }));

    const items = (result.Items ?? []) as OldSignalItem[];
    scanned += items.length;

    for (const item of items) {
      // Skip non-signal items (threads also live in this table)
      if (!item.id || !item.accountId) {
        skipped++;
        continue;
      }

      // Idempotent: skip signals that already have sgn- IDs
      if (item.id.startsWith("sgn-")) {
        skipped++;
        continue;
      }

      // Only process old-format signal IDs
      if (!isOldFormatId(item.id)) {
        skipped++;
        continue;
      }

      const oldId = item.id;
      const newSgnId = generateId("sgn-");
      const signalLookupId = deriveSignalLookupId(oldId, newSgnId);
      const newGsi1pk = deriveNewGsi1pk(item);

      if (dryRun) {
        console.log(`[DRY RUN] ${oldId} → id=${newSgnId}, signalLookupId=${signalLookupId}, gsi1pk=${newGsi1pk}`);
      } else {
        await dynamo.send(new UpdateCommand({
          TableName: SIGNALS_TABLE,
          Key: { pk: item.pk, sk: item.sk },
          UpdateExpression: "SET id = :id, signalLookupId = :lookupId, gsi1sk = :gsi1sk, gsi1pk = :gsi1pk, legacyId = :legacyId",
          ExpressionAttributeValues: {
            ":id": newSgnId,
            ":lookupId": signalLookupId,
            ":gsi1sk": newSgnId,
            ":gsi1pk": newGsi1pk,
            ":legacyId": oldId,
          },
        }));
      }

      updated++;
    }

    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    console.log(`Progress: scanned=${scanned}, updated=${updated}, skipped=${skipped}`);
  } while (exclusiveStartKey);

  console.log(`\nBackfill complete${dryRun ? " (DRY RUN — no writes performed)" : ""}.`);
  console.log(`Total scanned: ${scanned}`);
  console.log(`Total updated: ${updated}`);
  console.log(`Total skipped: ${skipped}`);
}

backfill().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
