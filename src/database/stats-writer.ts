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


export function buildPruneNames(now: Date): { names: Record<string, string>; expression: string } {
  const categories: StatsCategory[] = ["allowed", "blocked", "quarantined", "violationReport"];
  const names: Record<string, string> = {};
  let idx = 0;

  // Prune daily: day-8 through day-14
  for (let offset = 8; offset <= 14; offset++) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - offset);
    const dateStr = date.toISOString().slice(0, 10);
    for (const cat of categories) {
      names[`#prune${idx}`] = `d_${dateStr}_${cat}`;
      idx++;
    }
  }

  // Prune monthly: month-3 and month-4
  for (let offset = 3; offset <= 4; offset++) {
    const date = new Date(now);
    date.setUTCMonth(date.getUTCMonth() - offset);
    const monthStr = date.toISOString().slice(0, 7);
    for (const cat of categories) {
      names[`#prune${idx}`] = `m_${monthStr}_${cat}`;
      idx++;
    }
  }

  const expression = idx > 0 ? `REMOVE ${Object.keys(names).join(", ")}` : "";
  return { names, expression };
}
