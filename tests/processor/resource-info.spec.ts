import { describe, it, expect } from "vitest";
import { deriveResourceInfo } from "../../src/processor/resource-info.js";
import type { WorkflowData } from "../../src/types/index.js";

/**
 * deriveResourceInfo is now pure selection: it reads the precomputed "<field>Instant"
 * sibling (produced upstream by the coercer) and picks which field's instant becomes
 * the resolution date + which fields form the natural key. It performs no date parsing.
 *
 * These tests therefore supply both the display string and its Instant sibling, exactly
 * as the coercer would have stored them. The display -> instant conversion itself is
 * frozen separately in display-to-instant.spec.ts.
 */

describe("deriveResourceInfo", () => {
  describe("package", () => {
    it("returns date + resourceKey", () => {
      const info = deriveResourceInfo("package", {
        workflow: "package", packageType: "shipping", retailer: "Amazon",
        orderNumber: "123-456", estimatedDelivery: "2024-01-20T00:00:00Z", estimatedDeliveryInstant: "2024-01-20T00:00:00.000Z",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-01-20T00:00:00.000Z", displayDate: "2024-01-20T00:00:00Z", resourceKey: "123-456", assets: [] });
    });

    it("returns the same shape regardless of packageType — completion is never inferred here", () => {
      for (const packageType of ["confirmation", "shipping", "out_for_delivery", "delivered", "return", "refund", "cancellation"] as const) {
        const info = deriveResourceInfo("package", {
          workflow: "package", packageType, retailer: "Amazon",
          orderNumber: "123-456", estimatedDelivery: "2024-01-20T00:00:00Z", estimatedDeliveryInstant: "2024-01-20T00:00:00.000Z",
        });
        expect(info).toEqual({ expectedResolutionDate: "2024-01-20T00:00:00.000Z", displayDate: "2024-01-20T00:00:00Z", resourceKey: "123-456", assets: [] });
      }
    });

    it("returns null when estimatedDelivery is missing", () => {
      expect(deriveResourceInfo("package", {
        workflow: "package", packageType: "shipping", retailer: "Amazon", orderNumber: "123-456",
      })).toBeNull();
    });

    it("returns null when orderNumber is missing", () => {
      expect(deriveResourceInfo("package", {
        workflow: "package", packageType: "shipping", retailer: "Amazon", estimatedDelivery: "2024-01-20T00:00:00Z", estimatedDeliveryInstant: "2024-01-20T00:00:00.000Z",
      })).toBeNull();
    });

    it("returns null when the instant sibling is absent (unparseable date upstream)", () => {
      expect(deriveResourceInfo("package", {
        workflow: "package", packageType: "shipping", retailer: "Amazon", orderNumber: "123-456", estimatedDelivery: "not-a-date",
      })).toBeNull();
    });
  });

  describe("travel", () => {
    it("prefers returnDate over departureDate, uses flightNumber", () => {
      const info = deriveResourceInfo("travel", {
        workflow: "travel", travelType: "flight", provider: "United",
        departureDate: "2024-02-01T00:00:00Z", departureDateInstant: "2024-02-01T00:00:00.000Z",
        returnDate: "2024-02-10T00:00:00Z", returnDateInstant: "2024-02-10T00:00:00.000Z", flightNumber: "UA123",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-02-10T00:00:00.000Z", displayDate: "2024-02-10T00:00:00Z", resourceKey: "UA123", assets: [] });
    });

    it("falls back to departureDate and confirmationNumber when returnDate/flightNumber absent", () => {
      const info = deriveResourceInfo("travel", {
        workflow: "travel", travelType: "hotel", provider: "Marriott",
        departureDate: "2024-02-01T00:00:00Z", departureDateInstant: "2024-02-01T00:00:00.000Z", confirmationNumber: "CONF-1",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-02-01T00:00:00.000Z", displayDate: "2024-02-01T00:00:00Z", resourceKey: "CONF-1", assets: [] });
    });

    it("returns null when neither date nor key is present", () => {
      expect(deriveResourceInfo("travel", { workflow: "travel", travelType: "flight", provider: "United" })).toBeNull();
    });

    it("returns null when the resolved date has no instant sibling", () => {
      expect(deriveResourceInfo("travel", {
        workflow: "travel", travelType: "flight", provider: "United", returnDate: "not-a-date", flightNumber: "UA123",
      })).toBeNull();
    });
  });

  describe("payments", () => {
    it("returns the same shape regardless of paymentType", () => {
      for (const paymentType of ["invoice", "receipt", "subscription_renewal", "payment_failed", "plan_changed", "tax", "wire_transfer", "refund", "statement", "other"] as const) {
        const info = deriveResourceInfo("payments", {
          workflow: "payments", paymentType, vendor: "AWS", date: "2024-01-15", dueDate: "2024-03-01T00:00:00Z", dueDateInstant: "2024-03-01T00:00:00.000Z", invoiceNumber: "INV-1",
        });
        expect(info).toEqual({ expectedResolutionDate: "2024-03-01T00:00:00.000Z", displayDate: "2024-03-01T00:00:00Z", resourceKey: "INV-1", assets: [] });
      }
    });

    it("returns null when dueDate or invoiceNumber is missing", () => {
      expect(deriveResourceInfo("payments", { workflow: "payments", paymentType: "invoice", vendor: "AWS", date: "2024-01-15", invoiceNumber: "INV-1" })).toBeNull();
      expect(deriveResourceInfo("payments", { workflow: "payments", paymentType: "invoice", vendor: "AWS", date: "2024-01-15", dueDate: "2024-03-01T00:00:00Z", dueDateInstant: "2024-03-01T00:00:00.000Z" })).toBeNull();
    });

    it("returns null when dueDate has no instant sibling", () => {
      expect(deriveResourceInfo("payments", {
        workflow: "payments", paymentType: "invoice", vendor: "AWS", date: "2024-01-15", dueDate: "not-a-date", invoiceNumber: "INV-1",
      })).toBeNull();
    });
  });

  describe("healthcare", () => {
    it("returns date + resourceKey, keyed by provider", () => {
      const info = deriveResourceInfo("healthcare", {
        workflow: "healthcare", eventType: "appointment_reminder", provider: "Dr. Smith",
        appointmentDate: "2024-04-01T00:00:00Z", appointmentDateInstant: "2024-04-01T00:00:00.000Z", requiresAction: false,
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-04-01T00:00:00.000Z", displayDate: "2024-04-01T00:00:00Z", resourceKey: "Dr. Smith", assets: [] });
    });

    it("returns null when appointmentDate or provider is missing", () => {
      expect(deriveResourceInfo("healthcare", { workflow: "healthcare", eventType: "appointment_reminder", requiresAction: false, appointmentDate: "2024-04-01T00:00:00Z", appointmentDateInstant: "2024-04-01T00:00:00.000Z" })).toBeNull();
      expect(deriveResourceInfo("healthcare", { workflow: "healthcare", eventType: "appointment_reminder", requiresAction: false, provider: "Dr. Smith" })).toBeNull();
    });

    it("returns null when appointmentDate has no instant sibling", () => {
      expect(deriveResourceInfo("healthcare", {
        workflow: "healthcare", eventType: "appointment_reminder", provider: "Dr. Smith", appointmentDate: "not-a-date", requiresAction: false,
      })).toBeNull();
    });
  });

  describe("job", () => {
    it("returns date + resourceKey, keyed by company:role", () => {
      const info = deriveResourceInfo("job", {
        workflow: "job", jobType: "interview_request", company: "Acme", role: "Engineer",
        interviewDate: "2024-05-01T00:00:00Z", interviewDateInstant: "2024-05-01T00:00:00.000Z", applicationStatus: "interview",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-05-01T00:00:00.000Z", displayDate: "2024-05-01T00:00:00Z", resourceKey: "Acme:Engineer", assets: [] });
    });

    it("returns null when company or role is missing", () => {
      expect(deriveResourceInfo("job", {
        workflow: "job", jobType: "interview_request", role: "Engineer", interviewDate: "2024-05-01T00:00:00Z", interviewDateInstant: "2024-05-01T00:00:00.000Z",
      })).toBeNull();
    });

    it("returns null when interviewDate has no instant sibling", () => {
      expect(deriveResourceInfo("job", {
        workflow: "job", jobType: "interview_request", company: "Acme", role: "Engineer", interviewDate: "not-a-date",
      })).toBeNull();
    });
  });

  describe("events", () => {
    it("keys by ticketReference when present, title passed through from eventName", () => {
      const info = deriveResourceInfo("events", {
        workflow: "events", eventType: "reminder", eventName: "Concert",
        eventStartDatetime: "2024-06-01T20:00:00Z", eventStartDatetimeInstant: "2024-06-01T20:00:00.000Z", ticketReference: "TIX-1",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-06-01T20:00:00.000Z", displayDate: "2024-06-01T20:00:00Z", resourceKey: "TIX-1", assets: [], title: "Concert" });
    });

    it("falls back to eventName when ticketReference is absent", () => {
      const info = deriveResourceInfo("events", {
        workflow: "events", eventType: "reminder", eventName: "Concert",
        eventStartDatetime: "2024-06-01T20:00:00Z", eventStartDatetimeInstant: "2024-06-01T20:00:00.000Z",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-06-01T20:00:00.000Z", displayDate: "2024-06-01T20:00:00Z", resourceKey: "Concert", assets: [], title: "Concert" });
    });

    it("passes description through when present", () => {
      const info = deriveResourceInfo("events", {
        workflow: "events", eventType: "reminder", eventName: "Concert", description: "An evening of live jazz.",
        eventStartDatetime: "2024-06-01T20:00:00Z", eventStartDatetimeInstant: "2024-06-01T20:00:00.000Z", ticketReference: "TIX-1",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-06-01T20:00:00.000Z", displayDate: "2024-06-01T20:00:00Z", resourceKey: "TIX-1", assets: [], title: "Concert", description: "An evening of live jazz." });
    });

    it("returns null when eventStartDatetime is missing", () => {
      expect(deriveResourceInfo("events", { workflow: "events", eventType: "reminder", eventName: "Concert" })).toBeNull();
    });

    it("returns null when eventStartDatetime has no instant sibling", () => {
      expect(deriveResourceInfo("events", {
        workflow: "events", eventType: "reminder", eventName: "Concert", eventStartDatetime: "not-a-date",
      })).toBeNull();
    });

    it("falls back to eventDate (date-only) when eventStartDatetime is absent — save-the-date", () => {
      const info = deriveResourceInfo("events", {
        workflow: "events", eventType: "save_the_date", eventName: "Red Hat Summit Zurich",
        eventDate: "2027-02-03", eventDateInstant: "2027-02-02T23:00:00.000Z",
      });
      expect(info).toEqual({ expectedResolutionDate: "2027-02-02T23:00:00.000Z", displayDate: "2027-02-03", resourceKey: "Red Hat Summit Zurich", assets: [], title: "Red Hat Summit Zurich" });
    });

    it("prefers eventStartDatetime over eventDate when both are present", () => {
      const info = deriveResourceInfo("events", {
        workflow: "events", eventType: "ticket_confirmation", eventName: "Concert", ticketReference: "TIX-9",
        eventDate: "2027-02-03", eventDateInstant: "2027-02-02T23:00:00.000Z",
        eventStartDatetime: "2027-02-03T20:00", eventStartDatetimeInstant: "2027-02-03T19:00:00.000Z",
      });
      expect(info).toEqual({ expectedResolutionDate: "2027-02-03T19:00:00.000Z", displayDate: "2027-02-03T20:00", resourceKey: "TIX-9", assets: [], title: "Concert" });
    });

    it("returns null when only eventDate is present but its instant sibling is missing", () => {
      expect(deriveResourceInfo("events", {
        workflow: "events", eventType: "save_the_date", eventName: "Concert", eventDate: "not-a-date",
      })).toBeNull();
    });
  });

  describe("resolution date is the precomputed instant sibling (passthrough, no reparse)", () => {
    it("uses the stored instant verbatim regardless of the display string's form", () => {
      const info = deriveResourceInfo("package", {
        workflow: "package", packageType: "shipping", retailer: "Amazon",
        orderNumber: "ORD-1", estimatedDelivery: "2027-03-15T14:00+02:00", estimatedDeliveryInstant: "2027-03-15T12:00:00.000Z",
      });
      expect(info).not.toBeNull();
      expect(info!.expectedResolutionDate).toBe("2027-03-15T12:00:00.000Z");
      expect(info!.displayDate).toBe("2027-03-15T14:00+02:00");
    });

    it("date-only display with its stored midnight-in-tz instant", () => {
      const info = deriveResourceInfo("package", {
        workflow: "package", packageType: "shipping", retailer: "Amazon",
        orderNumber: "ORD-3", estimatedDelivery: "2027-03-15", estimatedDeliveryInstant: "2027-03-14T23:00:00.000Z",
      });
      expect(info).not.toBeNull();
      expect(info!.expectedResolutionDate).toBe("2027-03-14T23:00:00.000Z");
      expect(info!.displayDate).toBe("2027-03-15");
    });
  });

  describe("non-resource workflows", () => {
    it.each(["auth", "conversation", "crm", "alert", "content", "onboarding", "notice", "support", "healthcheck", "test", "unspecified"] as const)(
      "returns null for workflow %s",
      (workflow) => {
        expect(deriveResourceInfo(workflow, { workflow } as unknown as WorkflowData)).toBeNull();
      },
    );
  });
});
