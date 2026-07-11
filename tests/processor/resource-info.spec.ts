import { describe, it, expect } from "vitest";
import { deriveResourceInfo } from "../../src/processor/resource-info.js";
import type { WorkflowData } from "../../src/types/index.js";

describe("deriveResourceInfo", () => {
  describe("package", () => {
    it("returns date + resourceKey + non-terminal for an in-progress package", () => {
      const info = deriveResourceInfo("package", {
        workflow: "package", packageType: "shipping", retailer: "Amazon",
        orderNumber: "123-456", estimatedDelivery: "2024-01-20T00:00:00Z",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-01-20T00:00:00Z", resourceKey: "123-456", terminal: false });
    });

    it.each(["delivered", "cancellation", "refund", "return"] as const)("packageType %s is terminal", (packageType) => {
      const info = deriveResourceInfo("package", {
        workflow: "package", packageType, retailer: "Amazon",
        orderNumber: "123-456", estimatedDelivery: "2024-01-20T00:00:00Z",
      });
      expect(info?.terminal).toBe(true);
    });

    it.each(["confirmation", "shipping", "out_for_delivery"] as const)("packageType %s is not terminal", (packageType) => {
      const info = deriveResourceInfo("package", {
        workflow: "package", packageType, retailer: "Amazon",
        orderNumber: "123-456", estimatedDelivery: "2024-01-20T00:00:00Z",
      });
      expect(info?.terminal).toBe(false);
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
    it("prefers returnDate over departureDate, uses flightNumber, never terminal", () => {
      const info = deriveResourceInfo("travel", {
        workflow: "travel", travelType: "flight", provider: "United",
        departureDate: "2024-02-01T00:00:00Z", returnDate: "2024-02-10T00:00:00Z", flightNumber: "UA123",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-02-10T00:00:00Z", resourceKey: "UA123", terminal: false });
    });

    it("falls back to departureDate and confirmationNumber when returnDate/flightNumber absent", () => {
      const info = deriveResourceInfo("travel", {
        workflow: "travel", travelType: "hotel", provider: "Marriott",
        departureDate: "2024-02-01T00:00:00Z", confirmationNumber: "CONF-1",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-02-01T00:00:00Z", resourceKey: "CONF-1", terminal: false });
    });

    it("returns null when neither date nor key is present", () => {
      expect(deriveResourceInfo("travel", { workflow: "travel", travelType: "flight", provider: "United" })).toBeNull();
    });
  });

  describe("payments", () => {
    it.each(["receipt", "payment_failed", "refund"] as const)("paymentType %s is terminal", (paymentType) => {
      const info = deriveResourceInfo("payments", {
        workflow: "payments", paymentType, vendor: "AWS", dueDate: "2024-03-01T00:00:00Z", invoiceNumber: "INV-1",
      });
      expect(info?.terminal).toBe(true);
    });

    it("invoice is not terminal", () => {
      const info = deriveResourceInfo("payments", {
        workflow: "payments", paymentType: "invoice", vendor: "AWS", dueDate: "2024-03-01T00:00:00Z", invoiceNumber: "INV-1",
      });
      expect(info?.terminal).toBe(false);
    });

    it("returns null when dueDate or invoiceNumber is missing", () => {
      expect(deriveResourceInfo("payments", { workflow: "payments", paymentType: "invoice", vendor: "AWS", invoiceNumber: "INV-1" })).toBeNull();
      expect(deriveResourceInfo("payments", { workflow: "payments", paymentType: "invoice", vendor: "AWS", dueDate: "2024-03-01T00:00:00Z" })).toBeNull();
    });
  });

  describe("healthcare", () => {
    it("test_results is terminal, keyed by provider", () => {
      const info = deriveResourceInfo("healthcare", {
        workflow: "healthcare", eventType: "test_results", provider: "Dr. Smith",
        appointmentDate: "2024-04-01T00:00:00Z", requiresAction: false,
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-04-01T00:00:00Z", resourceKey: "Dr. Smith", terminal: true });
    });

    it("appointment_reminder is not terminal", () => {
      const info = deriveResourceInfo("healthcare", {
        workflow: "healthcare", eventType: "appointment_reminder", provider: "Dr. Smith",
        appointmentDate: "2024-04-01T00:00:00Z", requiresAction: false,
      });
      expect(info?.terminal).toBe(false);
    });
  });

  describe("job", () => {
    it("offer/rejected are terminal, keyed by company:role", () => {
      const info = deriveResourceInfo("job", {
        workflow: "job", jobType: "offer", company: "Acme", role: "Engineer",
        interviewDate: "2024-05-01T00:00:00Z", applicationStatus: "offer",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-05-01T00:00:00Z", resourceKey: "Acme:Engineer", terminal: true });
    });

    it("reviewing is not terminal", () => {
      const info = deriveResourceInfo("job", {
        workflow: "job", jobType: "application_status", company: "Acme", role: "Engineer",
        interviewDate: "2024-05-01T00:00:00Z", applicationStatus: "reviewing",
      });
      expect(info?.terminal).toBe(false);
    });

    it("returns null when company or role is missing", () => {
      expect(deriveResourceInfo("job", {
        workflow: "job", jobType: "interview_request", role: "Engineer", interviewDate: "2024-05-01T00:00:00Z",
      })).toBeNull();
    });
  });

  describe("events", () => {
    it("cancellation is terminal, keyed by ticketReference", () => {
      const info = deriveResourceInfo("events", {
        workflow: "events", eventType: "cancellation", eventName: "Concert",
        eventStartDatetime: "2024-06-01T20:00:00Z", ticketReference: "TIX-1",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-06-01T20:00:00Z", resourceKey: "TIX-1", terminal: true });
    });

    it("falls back to eventName when ticketReference is absent, reminder is not terminal", () => {
      const info = deriveResourceInfo("events", {
        workflow: "events", eventType: "reminder", eventName: "Concert",
        eventStartDatetime: "2024-06-01T20:00:00Z",
      });
      expect(info).toEqual({ expectedResolutionDate: "2024-06-01T20:00:00Z", resourceKey: "Concert", terminal: false });
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
