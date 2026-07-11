import type {
  Workflow, WorkflowData,
  PackageData, TravelData, PaymentsData, HealthcareData, JobData, EventsData,
} from "../types/index.js";

export interface ResourceInfo {
  expectedResolutionDate: string;
  resourceKey: string;
  terminal: boolean;
}

/**
 * Extracts a resolution date + natural resource key + terminal-state signal from
 * workflowData, for the workflows whose data carries a forward-looking date.
 * Returns null for every other workflow, or when this specific workflowData
 * instance is missing its date field or its natural key.
 */
export function deriveResourceInfo(workflow: Workflow, workflowData: WorkflowData): ResourceInfo | null {
  switch (workflow) {
    case "package": {
      const d = workflowData as PackageData;
      if (!d.estimatedDelivery || !d.orderNumber) return null;
      const terminal = d.packageType === "delivered"
        || d.packageType === "cancellation"
        || d.packageType === "refund"
        || d.packageType === "return";
      return { expectedResolutionDate: d.estimatedDelivery, resourceKey: d.orderNumber, terminal };
    }

    case "travel": {
      const d = workflowData as TravelData;
      const date = d.returnDate ?? d.departureDate;
      const key = d.flightNumber ?? d.confirmationNumber;
      if (!date || !key) return null;
      // No TravelData enum value ever declares a trip finished — never terminal from data alone.
      return { expectedResolutionDate: date, resourceKey: key, terminal: false };
    }

    case "payments": {
      const d = workflowData as PaymentsData;
      if (!d.dueDate || !d.invoiceNumber) return null;
      const terminal = d.paymentType === "receipt"
        || d.paymentType === "payment_failed"
        || d.paymentType === "refund";
      return { expectedResolutionDate: d.dueDate, resourceKey: d.invoiceNumber, terminal };
    }

    case "healthcare": {
      const d = workflowData as HealthcareData;
      if (!d.appointmentDate || !d.provider) return null;
      const terminal = d.eventType === "test_results";
      return { expectedResolutionDate: d.appointmentDate, resourceKey: d.provider, terminal };
    }

    case "job": {
      const d = workflowData as JobData;
      if (!d.interviewDate || !d.company || !d.role) return null;
      const terminal = d.applicationStatus === "offer" || d.applicationStatus === "rejected";
      return { expectedResolutionDate: d.interviewDate, resourceKey: `${d.company}:${d.role}`, terminal };
    }

    case "events": {
      const d = workflowData as EventsData;
      const key = d.ticketReference ?? d.eventName;
      if (!d.eventStartDatetime || !key) return null;
      const terminal = d.eventType === "cancellation";
      return { expectedResolutionDate: d.eventStartDatetime, resourceKey: key, terminal };
    }

    default:
      return null;
  }
}
