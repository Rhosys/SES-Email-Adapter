import type { SignalStatus, StatsCategory } from "../types/index.js";

const STATUS_TO_CATEGORY: Record<Exclude<SignalStatus, "draft">, StatsCategory> = {
  active: "allowed",
  block_hidden: "blocked",
  block_reject: "blocked",
  violate_report: "violationReport",
  quarantine_visible: "quarantined",
  quarantine_hidden: "quarantined",
} satisfies Record<Exclude<SignalStatus, "draft">, StatsCategory>;

export function statusToCategory(status: SignalStatus): StatsCategory | null {
  if (status === "draft") return null;
  return STATUS_TO_CATEGORY[status];
}

export interface StatsUpdateParams {
  TableName: string;
  Key: { pk: string; sk: string };
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
}

export function buildStatsUpdateParams(accountId: string, category: StatsCategory, now: Date, tableName: string): StatsUpdateParams {
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const month = today.slice(0, 7); // YYYY-MM
  const year = today.slice(0, 4); // YYYY

  const totalAttr = `total${category[0]!.toUpperCase()}${category.slice(1)}`;

  const dayAttr = `d_${today}_${category}`;
  const monthAttr = `m_${month}_${category}`;
  const yearAttr = `y_${year}_${category}`;

  return {
    TableName: tableName,
    Key: { pk: `ACCT#${accountId}`, sk: "STATS" },
    UpdateExpression: `ADD totalSignals :one, #totalCat :one, #day :one, #month :one, #year :one SET updatedAt = :now`,
    ExpressionAttributeNames: {
      "#totalCat": totalAttr,
      "#day": dayAttr,
      "#month": monthAttr,
      "#year": yearAttr,
    },
    ExpressionAttributeValues: {
      ":one": 1,
      ":now": now.toISOString(),
    },
  };
}
