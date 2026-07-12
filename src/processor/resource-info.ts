import { DateTime } from "luxon";
import type {
  Workflow, WorkflowData,
  PackageData, TravelData, PaymentsData, HealthcareData, JobData, EventsData,
} from "../types/index.js";

export interface ResourceInfo {
  expectedResolutionDate: string;
  resourceKey: string;
}

function isValidDate(date: string): boolean {
  return DateTime.fromISO(date).isValid;
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
export function deriveResourceInfo(workflow: Workflow, workflowData: WorkflowData): ResourceInfo | null {
  switch (workflow) {
    case "package": {
      const d = workflowData as PackageData;
      if (!d.estimatedDelivery || !d.orderNumber || !isValidDate(d.estimatedDelivery)) return null;
      return { expectedResolutionDate: d.estimatedDelivery, resourceKey: d.orderNumber };
    }

    case "travel": {
      const d = workflowData as TravelData;
      const date = d.returnDate ?? d.departureDate;
      const key = d.flightNumber ?? d.confirmationNumber;
      if (!date || !key || !isValidDate(date)) return null;
      return { expectedResolutionDate: date, resourceKey: key };
    }

    case "payments": {
      const d = workflowData as PaymentsData;
      if (!d.dueDate || !d.invoiceNumber || !isValidDate(d.dueDate)) return null;
      return { expectedResolutionDate: d.dueDate, resourceKey: d.invoiceNumber };
    }

    case "healthcare": {
      const d = workflowData as HealthcareData;
      if (!d.appointmentDate || !d.provider || !isValidDate(d.appointmentDate)) return null;
      return { expectedResolutionDate: d.appointmentDate, resourceKey: d.provider };
    }

    case "job": {
      const d = workflowData as JobData;
      if (!d.interviewDate || !d.company || !d.role || !isValidDate(d.interviewDate)) return null;
      return { expectedResolutionDate: d.interviewDate, resourceKey: `${d.company}:${d.role}` };
    }

    case "events": {
      const d = workflowData as EventsData;
      const key = d.ticketReference ?? d.eventName;
      if (!d.eventStartDatetime || !key || !isValidDate(d.eventStartDatetime)) return null;
      return { expectedResolutionDate: d.eventStartDatetime, resourceKey: key };
    }

    default:
      return null;
  }
}
