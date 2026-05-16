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
