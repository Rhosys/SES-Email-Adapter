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


export interface StatsResponse {
  lifetime: { totalSignals: number; totalAllowed: number; totalBlocked: number; totalQuarantined: number; totalViolationReport: number };
  daily: Array<{ date: string; allowed: number; blocked: number; quarantined: number; violationReport: number }>;
  monthly: Array<{ month: string; allowed: number; blocked: number; quarantined: number; violationReport: number }>;
  yearly: Array<{ year: string; allowed: number; blocked: number; quarantined: number; violationReport: number }>;
}

export function parseStatsRow(item: Record<string, unknown> | null): StatsResponse {
  if (!item) {
    return {
      lifetime: { totalSignals: 0, totalAllowed: 0, totalBlocked: 0, totalQuarantined: 0, totalViolationReport: 0 },
      daily: [],
      monthly: [],
      yearly: [],
    };
  }

  const lifetime = {
    totalSignals: (item["totalSignals"] as number) ?? 0,
    totalAllowed: (item["totalAllowed"] as number) ?? 0,
    totalBlocked: (item["totalBlocked"] as number) ?? 0,
    totalQuarantined: (item["totalQuarantined"] as number) ?? 0,
    totalViolationReport: (item["totalViolationReport"] as number) ?? 0,
  };

  const dailyMap = new Map<string, { allowed: number; blocked: number; quarantined: number; violationReport: number }>();
  const monthlyMap = new Map<string, { allowed: number; blocked: number; quarantined: number; violationReport: number }>();
  const yearlyMap = new Map<string, { allowed: number; blocked: number; quarantined: number; violationReport: number }>();

  for (const [key, value] of Object.entries(item)) {
    if (key.startsWith("d_")) {
      // d_YYYY-MM-DD_category
      const parts = key.slice(2); // YYYY-MM-DD_category
      const date = parts.slice(0, 10);
      const category = parts.slice(11);
      if (!dailyMap.has(date)) dailyMap.set(date, { allowed: 0, blocked: 0, quarantined: 0, violationReport: 0 });
      const entry = dailyMap.get(date)!;
      if (category in entry) (entry as Record<string, number>)[category] = value as number;
    } else if (key.startsWith("m_")) {
      // m_YYYY-MM_category
      const parts = key.slice(2); // YYYY-MM_category
      const month = parts.slice(0, 7);
      const category = parts.slice(8);
      if (!monthlyMap.has(month)) monthlyMap.set(month, { allowed: 0, blocked: 0, quarantined: 0, violationReport: 0 });
      const entry = monthlyMap.get(month)!;
      if (category in entry) (entry as Record<string, number>)[category] = value as number;
    } else if (key.startsWith("y_")) {
      // y_YYYY_category
      const parts = key.slice(2); // YYYY_category
      const year = parts.slice(0, 4);
      const category = parts.slice(5);
      if (!yearlyMap.has(year)) yearlyMap.set(year, { allowed: 0, blocked: 0, quarantined: 0, violationReport: 0 });
      const entry = yearlyMap.get(year)!;
      if (category in entry) (entry as Record<string, number>)[category] = value as number;
    }
  }

  const daily = [...dailyMap.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, counts]) => ({ date, ...counts }));

  const monthly = [...monthlyMap.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, counts]) => ({ month, ...counts }));

  const yearly = [...yearlyMap.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([year, counts]) => ({ year, ...counts }));

  return { lifetime, daily, monthly, yearly };
}
