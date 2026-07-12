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
      expect(info).toEqual({ expectedResolutionDate: "2024-01-20T00:00:00Z", resourceKey: "123-456" });
    });

    it("returns the same shape regardless of packageType — completion is never inferred here", () => {
      for (const packageType of ["confirmation", "shipping", "out_for_delivery", "delivered", "return", "refund", "cancellation"] as const) {
        const info = deriveResourceInfo("package", {
          workflow: "package", packageType, retailer: "Amazon",
          orderNumber: "123-456", estimatedDelivery: "2024-01-20T00:00:00Z",
        });
        expect(info).toEqual({ expectedResolutionDate: "2024-01-20T00:00:00Z", resourceKey: "123-456" });
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
  });

  describe("travel", () => {
    it("prefers returnDate over departureDate, uses flightNumber", () => {
      const info = deriveResourceInfo("travel", {
        workflow: "travel", travelType: "flight", provider: "United",
        departureDate: "2024-02-01T00:00:00Z", returnDate: "2024-02-10T00:00:00Z", flightNumber: "UA123",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-02-10T00:00:00Z", resourceKey: "UA123" });
    });

    it("falls back to departureDate and confirmationNumber when returnDate/flightNumber absent", () => {
      const info = deriveResourceInfo("travel", {
        workflow: "travel", travelType: "hotel", provider: "Marriott",
        departureDate: "2024-02-01T00:00:00Z", confirmationNumber: "CONF-1",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-02-01T00:00:00Z", resourceKey: "CONF-1" });
    });

    it("returns null when neither date nor key is present", () => {
      expect(deriveResourceInfo("travel", { workflow: "travel", travelType: "flight", provider: "United" })).toBeNull();
    });
  });

  describe("payments", () => {
    it("returns the same shape regardless of paymentType", () => {
      for (const paymentType of ["invoice", "receipt", "subscription_renewal", "payment_failed", "plan_changed", "tax", "wire_transfer", "refund", "statement", "other"] as const) {
        const info = deriveResourceInfo("payments", {
          workflow: "payments", paymentType, vendor: "AWS", dueDate: "2024-03-01T00:00:00Z", invoiceNumber: "INV-1",
        });
        expect(info).toEqual({ expectedResolutionDate: "2024-03-01T00:00:00Z", resourceKey: "INV-1" });
      }
    });

    it("returns null when dueDate or invoiceNumber is missing", () => {
      expect(deriveResourceInfo("payments", { workflow: "payments", paymentType: "invoice", vendor: "AWS", invoiceNumber: "INV-1" })).toBeNull();
      expect(deriveResourceInfo("payments", { workflow: "payments", paymentType: "invoice", vendor: "AWS", dueDate: "2024-03-01T00:00:00Z" })).toBeNull();
    });
  });

  describe("healthcare", () => {
    it("returns date + resourceKey, keyed by provider", () => {
      const info = deriveResourceInfo("healthcare", {
        workflow: "healthcare", eventType: "appointment_reminder", provider: "Dr. Smith",
        appointmentDate: "2024-04-01T00:00:00Z", requiresAction: false,
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-04-01T00:00:00Z", resourceKey: "Dr. Smith" });
    });

    it("returns null when appointmentDate or provider is missing", () => {
      expect(deriveResourceInfo("healthcare", { workflow: "healthcare", eventType: "appointment_reminder", requiresAction: false, appointmentDate: "2024-04-01T00:00:00Z" })).toBeNull();
      expect(deriveResourceInfo("healthcare", { workflow: "healthcare", eventType: "appointment_reminder", requiresAction: false, provider: "Dr. Smith" })).toBeNull();
    });
  });

  describe("job", () => {
    it("returns date + resourceKey, keyed by company:role", () => {
      const info = deriveResourceInfo("job", {
        workflow: "job", jobType: "interview_request", company: "Acme", role: "Engineer",
        interviewDate: "2024-05-01T00:00:00Z", applicationStatus: "interview",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-05-01T00:00:00Z", resourceKey: "Acme:Engineer" });
    });

    it("returns null when company or role is missing", () => {
      expect(deriveResourceInfo("job", {
        workflow: "job", jobType: "interview_request", role: "Engineer", interviewDate: "2024-05-01T00:00:00Z",
      })).toBeNull();
    });
  });

  describe("events", () => {
    it("keys by ticketReference when present", () => {
      const info = deriveResourceInfo("events", {
        workflow: "events", eventType: "reminder", eventName: "Concert",
        eventStartDatetime: "2024-06-01T20:00:00Z", ticketReference: "TIX-1",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-06-01T20:00:00Z", resourceKey: "TIX-1" });
    });

    it("falls back to eventName when ticketReference is absent", () => {
      const info = deriveResourceInfo("events", {
        workflow: "events", eventType: "reminder", eventName: "Concert",
        eventStartDatetime: "2024-06-01T20:00:00Z",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-06-01T20:00:00Z", resourceKey: "Concert" });
    });

    it("returns null when eventStartDatetime is missing", () => {
      expect(deriveResourceInfo("events", { workflow: "events", eventType: "reminder", eventName: "Concert" })).toBeNull();
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
