import type {
  Workflow, WorkflowData, ResourceAsset,
  PackageData, TravelData, PaymentsData, HealthcareData, JobData, EventsData,
} from "../types/index.js";

export interface ResourceInfo {
  expectedResolutionDate: string; // UTC_Instant — "2027-03-15T13:00:00.000Z"
  displayDate: string;            // Display_Date — passthrough from workflowData
  resourceKey: string;
  assets: ResourceAsset[];
  title?: string;
  description?: string;
}

/**
 * Selects a resolution instant + natural resource key from workflowData, for the
 * workflows whose data carries a forward-looking date. Returns null for every
 * other workflow, or when this specific workflowData instance is missing its
 * date field, its natural key, or its precomputed instant (e.g. the classifier
 * emitted an unparseable date, so no "<field>Instant" sibling was produced) — a
 * resource is simply not created/updated from that signal rather than being
 * written with a poisoned TTL.
 *
 * The instant is NOT computed here. It is computed once, upstream, at the
 * classifier coercion boundary (see coerceWorkflowData -> displayToInstant) and
 * stored on the "<field>Instant" sibling. This function only selects which
 * field's precomputed instant becomes the resolution date and which fields form
 * the natural key — it performs no date parsing.
 *
 * Completion is not inferred here — a resource only closes via explicit user
 * action (ResourceDatabase.setResourceStatus). This function only ever tells
 * the processor whether/where to upsert a resource, never whether it's done.
 */
export function deriveResourceInfo(
  workflow: Workflow,
  workflowData: WorkflowData,
): ResourceInfo | null {
  switch (workflow) {
    case "package": {
      const d = workflowData as PackageData;
      if (!d.estimatedDelivery || !d.estimatedDeliveryInstant || !d.orderNumber) return null;
      return { expectedResolutionDate: d.estimatedDeliveryInstant, displayDate: d.estimatedDelivery, resourceKey: d.orderNumber, assets: [] };
    }

    case "travel": {
      const d = workflowData as TravelData;
      const date = d.returnDate ?? d.departureDate;
      const instant = d.returnDate ? d.returnDateInstant : d.departureDateInstant;
      const key = d.flightNumber ?? d.confirmationNumber;
      if (!date || !instant || !key) return null;
      return { expectedResolutionDate: instant, displayDate: date, resourceKey: key, assets: [] };
    }

    case "payments": {
      const d = workflowData as PaymentsData;
      if (!d.dueDate || !d.dueDateInstant || !d.invoiceNumber) return null;
      return { expectedResolutionDate: d.dueDateInstant, displayDate: d.dueDate, resourceKey: d.invoiceNumber, assets: [] };
    }

    case "healthcare": {
      const d = workflowData as HealthcareData;
      if (!d.appointmentDate || !d.appointmentDateInstant || !d.provider) return null;
      return { expectedResolutionDate: d.appointmentDateInstant, displayDate: d.appointmentDate, resourceKey: d.provider, assets: [] };
    }

    case "job": {
      const d = workflowData as JobData;
      if (!d.interviewDate || !d.interviewDateInstant || !d.company || !d.role) return null;
      return { expectedResolutionDate: d.interviewDateInstant, displayDate: d.interviewDate, resourceKey: `${d.company}:${d.role}`, assets: [] };
    }

    case "events": {
      const d = workflowData as EventsData;
      const key = d.ticketReference ?? d.eventName;
      // Prefer the precise start datetime; fall back to the date-only eventDate. A
      // save-the-date with no time still yields a resource via eventDate.
      const display = d.eventStartDatetime ?? d.eventDate;
      const instant = d.eventStartDatetime ? d.eventStartDatetimeInstant : d.eventDateInstant;
      if (!display || !instant || !key) return null;
      return {
        expectedResolutionDate: instant, displayDate: display, resourceKey: key, assets: [],
        title: d.eventName,
        ...(d.description ? { description: d.description } : {}),
      };
    }

    default:
      return null;
  }
}
