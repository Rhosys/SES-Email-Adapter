import { DateTime } from "luxon";
import type {
  Workflow, WorkflowData, ResourceAsset,
  PackageData, TravelData, PaymentsData, HealthcareData, JobData, EventsData,
} from "../types/index.js";

export interface ResourceInfo {
  expectedResolutionDate: string; // UTC_Instant — "2027-03-15T13:00:00.000Z"
  displayDate: string;            // Display_Date — passthrough from workflowData
  resourceKey: string;
  assets: ResourceAsset[];
}

/**
 * Converts a Display_Date string to a UTC instant using the account timezone.
 *
 * - Numeric offset present → convert to UTC directly
 * - Timezone abbreviation after time (e.g. "2027-03-15T14:00 CET") → fall back to account timezone
 * - No offset → interpret in accountTimezone, then convert to UTC
 * - Date-only (no "T") → assume midnight in accountTimezone
 * - Invalid → returns null
 */
function toUtcInstant(displayDate: string, accountTimezone: string): string | null {
  // Date-only: no "T" means no time component — assume midnight in account timezone
  if (!displayDate.includes("T")) {
    const dt = DateTime.fromISO(`${displayDate}T00:00:00`, { zone: accountTimezone });
    return dt.isValid ? dt.toUTC().toISO() : null;
  }

  // Abbreviation fallback: space followed by alphabetic chars after the time portion
  // e.g. "2027-03-15T14:00 CET" or "2027-03-15T14:00:00 EST"
  const abbrMatch = displayDate.match(/^(.+T[\d:]+)\s+([A-Za-z]+)$/);
  if (abbrMatch) {
    const dt = DateTime.fromISO(abbrMatch[1]!, { zone: accountTimezone });
    return dt.isValid ? dt.toUTC().toISO() : null;
  }

  // Try standard ISO parse — luxon handles numeric offsets natively
  const dt = DateTime.fromISO(displayDate);
  if (!dt.isValid) return null;

  // If offset info is present (the string has Z, +HH:mm, or -HH:mm), convert directly
  if (/[Zz]$/.test(displayDate) || /[+-]\d{2}:\d{2}$/.test(displayDate)) {
    return dt.toUTC().toISO();
  }

  // No offset — interpret in account timezone
  const dtInZone = DateTime.fromISO(displayDate, { zone: accountTimezone });
  return dtInZone.isValid ? dtInZone.toUTC().toISO() : null;
}

/**
 * Extracts a resolution date + natural resource key from workflowData, for the
 * workflows whose data carries a forward-looking date. Returns null for every
 * other workflow, or when this specific workflowData instance is missing its
 * date field, its natural key, or has an unparseable date (e.g. a classifier
 * hallucination) — a resource is simply not created/updated from that signal
 * rather than being written with a poisoned TTL.
 *
 * Completion is not inferred here — a resource only closes via explicit user
 * action (ResourceDatabase.setResourceStatus). This function only ever tells
 * the processor whether/where to upsert a resource, never whether it's done.
 */
export function deriveResourceInfo(
  workflow: Workflow,
  workflowData: WorkflowData,
  accountTimezone = "Europe/London",
): ResourceInfo | null {
  switch (workflow) {
    case "package": {
      const d = workflowData as PackageData;
      if (!d.estimatedDelivery || !d.orderNumber) return null;
      const utc = toUtcInstant(d.estimatedDelivery, accountTimezone);
      if (!utc) return null;
      return { expectedResolutionDate: utc, displayDate: d.estimatedDelivery, resourceKey: d.orderNumber, assets: [] };
    }

    case "travel": {
      const d = workflowData as TravelData;
      const date = d.returnDate ?? d.departureDate;
      const key = d.flightNumber ?? d.confirmationNumber;
      if (!date || !key) return null;
      const utc = toUtcInstant(date, accountTimezone);
      if (!utc) return null;
      return { expectedResolutionDate: utc, displayDate: date, resourceKey: key, assets: [] };
    }

    case "payments": {
      const d = workflowData as PaymentsData;
      if (!d.dueDate || !d.invoiceNumber) return null;
      const utc = toUtcInstant(d.dueDate, accountTimezone);
      if (!utc) return null;
      return { expectedResolutionDate: utc, displayDate: d.dueDate, resourceKey: d.invoiceNumber, assets: [] };
    }

    case "healthcare": {
      const d = workflowData as HealthcareData;
      if (!d.appointmentDate || !d.provider) return null;
      const utc = toUtcInstant(d.appointmentDate, accountTimezone);
      if (!utc) return null;
      return { expectedResolutionDate: utc, displayDate: d.appointmentDate, resourceKey: d.provider, assets: [] };
    }

    case "job": {
      const d = workflowData as JobData;
      if (!d.interviewDate || !d.company || !d.role) return null;
      const utc = toUtcInstant(d.interviewDate, accountTimezone);
      if (!utc) return null;
      return { expectedResolutionDate: utc, displayDate: d.interviewDate, resourceKey: `${d.company}:${d.role}`, assets: [] };
    }

    case "events": {
      const d = workflowData as EventsData;
      const key = d.ticketReference ?? d.eventName;
      if (!d.eventStartDatetime || !key) return null;
      const utc = toUtcInstant(d.eventStartDatetime, accountTimezone);
      if (!utc) return null;
      return { expectedResolutionDate: utc, displayDate: d.eventStartDatetime, resourceKey: key, assets: [] };
    }

    default:
      return null;
  }
}
