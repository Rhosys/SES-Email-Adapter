import { describe, it, expect } from "vitest";
import { deriveResourceInfo } from "../../src/processor/resource-info.js";
import type { WorkflowData } from "../../src/types/index.js";

describe("deriveResourceInfo", () => {
  describe("package", () => {
    it("returns date + resourceKey", () => {
      const info = deriveResourceInfo("package", {
        workflow: "package", packageType: "shipping", retailer: "Amazon",
        orderNumber: "123-456", estimatedDelivery: "2024-01-20T00:00:00Z",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-01-20T00:00:00.000Z", displayDate: "2024-01-20T00:00:00Z", resourceKey: "123-456", assets: [] });
    });

    it("returns the same shape regardless of packageType — completion is never inferred here", () => {
      for (const packageType of ["confirmation", "shipping", "out_for_delivery", "delivered", "return", "refund", "cancellation"] as const) {
        const info = deriveResourceInfo("package", {
          workflow: "package", packageType, retailer: "Amazon",
          orderNumber: "123-456", estimatedDelivery: "2024-01-20T00:00:00Z",
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
        workflow: "package", packageType: "shipping", retailer: "Amazon", estimatedDelivery: "2024-01-20T00:00:00Z",
      })).toBeNull();
    });

    it("returns null when estimatedDelivery is not a parseable date (classifier hallucination)", () => {
      expect(deriveResourceInfo("package", {
        workflow: "package", packageType: "shipping", retailer: "Amazon", orderNumber: "123-456", estimatedDelivery: "not-a-date",
      })).toBeNull();
    });
  });

  describe("travel", () => {
    it("prefers returnDate over departureDate, uses flightNumber", () => {
      const info = deriveResourceInfo("travel", {
        workflow: "travel", travelType: "flight", provider: "United",
        departureDate: "2024-02-01T00:00:00Z", returnDate: "2024-02-10T00:00:00Z", flightNumber: "UA123",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-02-10T00:00:00.000Z", displayDate: "2024-02-10T00:00:00Z", resourceKey: "UA123", assets: [] });
    });

    it("falls back to departureDate and confirmationNumber when returnDate/flightNumber absent", () => {
      const info = deriveResourceInfo("travel", {
        workflow: "travel", travelType: "hotel", provider: "Marriott",
        departureDate: "2024-02-01T00:00:00Z", confirmationNumber: "CONF-1",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-02-01T00:00:00.000Z", displayDate: "2024-02-01T00:00:00Z", resourceKey: "CONF-1", assets: [] });
    });

    it("returns null when neither date nor key is present", () => {
      expect(deriveResourceInfo("travel", { workflow: "travel", travelType: "flight", provider: "United" })).toBeNull();
    });

    it("returns null when the resolved date is not parseable", () => {
      expect(deriveResourceInfo("travel", {
        workflow: "travel", travelType: "flight", provider: "United", returnDate: "not-a-date", flightNumber: "UA123",
      })).toBeNull();
    });
  });

  describe("payments", () => {
    it("returns the same shape regardless of paymentType", () => {
      for (const paymentType of ["invoice", "receipt", "subscription_renewal", "payment_failed", "plan_changed", "tax", "wire_transfer", "refund", "statement", "other"] as const) {
        const info = deriveResourceInfo("payments", {
          workflow: "payments", paymentType, vendor: "AWS", date: "2024-01-15", dueDate: "2024-03-01T00:00:00Z", invoiceNumber: "INV-1",
        });
        expect(info).toEqual({ expectedResolutionDate: "2024-03-01T00:00:00.000Z", displayDate: "2024-03-01T00:00:00Z", resourceKey: "INV-1", assets: [] });
      }
    });

    it("returns null when dueDate or invoiceNumber is missing", () => {
      expect(deriveResourceInfo("payments", { workflow: "payments", paymentType: "invoice", vendor: "AWS", date: "2024-01-15", invoiceNumber: "INV-1" })).toBeNull();
      expect(deriveResourceInfo("payments", { workflow: "payments", paymentType: "invoice", vendor: "AWS", date: "2024-01-15", dueDate: "2024-03-01T00:00:00Z" })).toBeNull();
    });

    it("returns null when dueDate is not a parseable date", () => {
      expect(deriveResourceInfo("payments", {
        workflow: "payments", paymentType: "invoice", vendor: "AWS", date: "2024-01-15", dueDate: "not-a-date", invoiceNumber: "INV-1",
      })).toBeNull();
    });
  });

  describe("healthcare", () => {
    it("returns date + resourceKey, keyed by provider", () => {
      const info = deriveResourceInfo("healthcare", {
        workflow: "healthcare", eventType: "appointment_reminder", provider: "Dr. Smith",
        appointmentDate: "2024-04-01T00:00:00Z", requiresAction: false,
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-04-01T00:00:00.000Z", displayDate: "2024-04-01T00:00:00Z", resourceKey: "Dr. Smith", assets: [] });
    });

    it("returns null when appointmentDate or provider is missing", () => {
      expect(deriveResourceInfo("healthcare", { workflow: "healthcare", eventType: "appointment_reminder", requiresAction: false, appointmentDate: "2024-04-01T00:00:00Z" })).toBeNull();
      expect(deriveResourceInfo("healthcare", { workflow: "healthcare", eventType: "appointment_reminder", requiresAction: false, provider: "Dr. Smith" })).toBeNull();
    });

    it("returns null when appointmentDate is not a parseable date", () => {
      expect(deriveResourceInfo("healthcare", {
        workflow: "healthcare", eventType: "appointment_reminder", provider: "Dr. Smith", appointmentDate: "not-a-date", requiresAction: false,
      })).toBeNull();
    });
  });

  describe("job", () => {
    it("returns date + resourceKey, keyed by company:role", () => {
      const info = deriveResourceInfo("job", {
        workflow: "job", jobType: "interview_request", company: "Acme", role: "Engineer",
        interviewDate: "2024-05-01T00:00:00Z", applicationStatus: "interview",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-05-01T00:00:00.000Z", displayDate: "2024-05-01T00:00:00Z", resourceKey: "Acme:Engineer", assets: [] });
    });

    it("returns null when company or role is missing", () => {
      expect(deriveResourceInfo("job", {
        workflow: "job", jobType: "interview_request", role: "Engineer", interviewDate: "2024-05-01T00:00:00Z",
      })).toBeNull();
    });

    it("returns null when interviewDate is not a parseable date", () => {
      expect(deriveResourceInfo("job", {
        workflow: "job", jobType: "interview_request", company: "Acme", role: "Engineer", interviewDate: "not-a-date",
      })).toBeNull();
    });
  });

  describe("events", () => {
    it("keys by ticketReference when present", () => {
      const info = deriveResourceInfo("events", {
        workflow: "events", eventType: "reminder", eventName: "Concert",
        eventStartDatetime: "2024-06-01T20:00:00Z", ticketReference: "TIX-1",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-06-01T20:00:00.000Z", displayDate: "2024-06-01T20:00:00Z", resourceKey: "TIX-1", assets: [] });
    });

    it("falls back to eventName when ticketReference is absent", () => {
      const info = deriveResourceInfo("events", {
        workflow: "events", eventType: "reminder", eventName: "Concert",
        eventStartDatetime: "2024-06-01T20:00:00Z",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-06-01T20:00:00.000Z", displayDate: "2024-06-01T20:00:00Z", resourceKey: "Concert", assets: [] });
    });

    it("returns null when eventStartDatetime is missing", () => {
      expect(deriveResourceInfo("events", { workflow: "events", eventType: "reminder", eventName: "Concert" })).toBeNull();
    });

    it("returns null when eventStartDatetime is not a parseable date", () => {
      expect(deriveResourceInfo("events", {
        workflow: "events", eventType: "reminder", eventName: "Concert", eventStartDatetime: "not-a-date",
      })).toBeNull();
    });
  });

  describe("UTC conversion per Display_Date variant", () => {
    it("date with offset → UTC (instant preserved)", () => {
      const info = deriveResourceInfo("package", {
        workflow: "package", packageType: "shipping", retailer: "Amazon",
        orderNumber: "ORD-1", estimatedDelivery: "2027-03-15T14:00+02:00",
      }, "Europe/London");
      expect(info).not.toBeNull();
      expect(info!.expectedResolutionDate).toBe("2027-03-15T12:00:00.000Z");
      expect(info!.displayDate).toBe("2027-03-15T14:00+02:00");
    });

    it("date without offset → account timezone applied → UTC", () => {
      const info = deriveResourceInfo("package", {
        workflow: "package", packageType: "shipping", retailer: "Amazon",
        orderNumber: "ORD-2", estimatedDelivery: "2027-03-15T14:00",
      }, "Europe/Zurich");
      expect(info).not.toBeNull();
      // March 15 Zurich is CET (+01:00), so 14:00 CET → 13:00 UTC
      expect(info!.expectedResolutionDate).toBe("2027-03-15T13:00:00.000Z");
      expect(info!.displayDate).toBe("2027-03-15T14:00");
    });

    it("date-only → midnight in account timezone → UTC", () => {
      const info = deriveResourceInfo("package", {
        workflow: "package", packageType: "shipping", retailer: "Amazon",
        orderNumber: "ORD-3", estimatedDelivery: "2027-03-15",
      }, "Europe/Zurich");
      expect(info).not.toBeNull();
      // March 15 Zurich is CET (+01:00), midnight → 23:00 previous day UTC
      expect(info!.expectedResolutionDate).toBe("2027-03-14T23:00:00.000Z");
      expect(info!.displayDate).toBe("2027-03-15");
    });

    it("date with Z offset → converts directly to UTC", () => {
      const info = deriveResourceInfo("travel", {
        workflow: "travel", travelType: "flight", provider: "United",
        departureDate: "2027-06-01T08:00+00:00", flightNumber: "UA100",
      }, "America/New_York");
      expect(info).not.toBeNull();
      expect(info!.expectedResolutionDate).toBe("2027-06-01T08:00:00.000Z");
    });

    it("date without offset uses default timezone when accountTimezone omitted", () => {
      // deriveResourceInfo defaults to "Europe/London" when no tz passed
      const info = deriveResourceInfo("payments", {
        workflow: "payments", paymentType: "invoice", vendor: "AWS",
        date: "2027-01-15", dueDate: "2027-01-15T09:00", invoiceNumber: "INV-99",
      });
      expect(info).not.toBeNull();
      // January in London is GMT (+00:00), so 09:00 → 09:00 UTC
      expect(info!.expectedResolutionDate).toBe("2027-01-15T09:00:00.000Z");
    });

    it("date-only with summer timezone (DST offset)", () => {
      const info = deriveResourceInfo("healthcare", {
        workflow: "healthcare", eventType: "appointment_reminder", provider: "Dr. Smith",
        appointmentDate: "2027-07-01", requiresAction: false,
      }, "Europe/Zurich");
      expect(info).not.toBeNull();
      // July in Zurich is CEST (+02:00), midnight → 22:00 previous day UTC
      expect(info!.expectedResolutionDate).toBe("2027-06-30T22:00:00.000Z");
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
