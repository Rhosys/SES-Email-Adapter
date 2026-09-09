import { DateTime } from "luxon";

/**
 * Converts a Display_Date string (the output of coerceDate) into a UTC instant.
 *
 * This is the single, canonical display -> instant calculator. It runs once, at
 * the classifier coercion boundary, and its result is stored alongside the display
 * string on the signal (see coerceWorkflowData). Downstream consumers (resource
 * resolution, thread triggers) read that stored instant rather than reparsing.
 *
 * Timezone rule:
 * - Offset present (Z, +HH:mm, -HH:mm) -> converted directly to UTC; account tz ignored.
 * - Time but no offset -> interpreted in accountTimezone, then converted to UTC.
 * - Date-only (no "T") -> midnight in accountTimezone, then converted to UTC.
 * - Invalid -> null (no instant; a resource is simply not created from that field
 *   rather than being written with a poisoned TTL).
 *
 * The account timezone is only ever consulted as the fallback for offset-free
 * display strings — it never overrides an offset the source already carried.
 */
export function displayToInstant(displayDate: string, accountTimezone: string): string | null {
  // Date-only: no "T" means no time component — assume midnight in account timezone.
  if (!displayDate.includes("T")) {
    const dt = DateTime.fromISO(`${displayDate}T00:00:00`, { zone: accountTimezone });
    return dt.isValid ? dt.toUTC().toISO() : null;
  }

  // Try standard ISO parse — luxon handles numeric offsets natively.
  const dt = DateTime.fromISO(displayDate);
  if (!dt.isValid) return null;

  // If offset info is present (Z, +HH:mm, or -HH:mm), convert directly.
  if (/[Zz]$/.test(displayDate) || /[+-]\d{2}:\d{2}$/.test(displayDate)) {
    return dt.toUTC().toISO();
  }

  // No offset — interpret in account timezone.
  const dtInZone = DateTime.fromISO(displayDate, { zone: accountTimezone });
  return dtInZone.isValid ? dtInZone.toUTC().toISO() : null;
}
