import { describe, it, expect, vi, beforeEach } from "vitest";
import { coerceWorkflowData, coerceNumericToString, coerceBoolean, coerceString } from "../../src/classifier/coerce-workflow-data.js";
import { createMockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Unit tests for individual coercion functions
// ---------------------------------------------------------------------------

describe("coerceNumericToString", () => {
  it.each([
    { input: 0, expected: "0", label: "zero as number" },
    { input: 1, expected: "1", label: "positive integer" },
    { input: 149.99, expected: "149.99", label: "decimal number" },
    { input: -50, expected: "-50", label: "negative number" },
    { input: "0", expected: "0", label: "zero as string" },
    { input: "149.99", expected: "149.99", label: "decimal string" },
    { input: "1,234.56", expected: "1234.56", label: "comma-separated thousands" },
    { input: "  42  ", expected: "42", label: "whitespace-padded string" },
    { input: "0.00", expected: "0", label: "zero with decimals as string" },
    { input: "-10.5", expected: "-10.5", label: "negative decimal string" },
  ])("$label → $expected", ({ input, expected }) => {
    expect(coerceNumericToString(input)).toBe(expected);
  });

  it.each([
    { input: "two", label: "word number" },
    { input: "CHF 5.00", label: "currency-prefixed string" },
    { input: "$149", label: "dollar sign prefix" },
    { input: "", label: "empty string" },
    { input: "   ", label: "whitespace-only string" },
    { input: "N/A", label: "not applicable" },
    { input: Infinity, label: "Infinity" },
    { input: -Infinity, label: "negative Infinity" },
    { input: NaN, label: "NaN" },
    { input: null, label: "null" },
    { input: undefined, label: "undefined" },
    { input: {}, label: "object" },
    { input: [], label: "array" },
    { input: true, label: "boolean true" },
    { input: false, label: "boolean false" },
  ])("$label → null", ({ input }) => {
    expect(coerceNumericToString(input)).toBeNull();
  });
});

describe("coerceBoolean", () => {
  it.each([
    { input: true, expected: true, label: "boolean true" },
    { input: false, expected: false, label: "boolean false" },
    { input: "true", expected: true, label: "string 'true'" },
    { input: "false", expected: false, label: "string 'false'" },
    { input: "TRUE", expected: true, label: "string 'TRUE'" },
    { input: "FALSE", expected: false, label: "string 'FALSE'" },
    { input: "True", expected: true, label: "string 'True'" },
    { input: "yes", expected: true, label: "string 'yes'" },
    { input: "no", expected: false, label: "string 'no'" },
    { input: "YES", expected: true, label: "string 'YES'" },
    { input: "NO", expected: false, label: "string 'NO'" },
    { input: "1", expected: true, label: "string '1'" },
    { input: "0", expected: false, label: "string '0'" },
    { input: 1, expected: true, label: "number 1" },
    { input: 0, expected: false, label: "number 0" },
    { input: " true ", expected: true, label: "whitespace-padded 'true'" },
  ])("$label → $expected", ({ input, expected }) => {
    expect(coerceBoolean(input)).toBe(expected);
  });

  it.each([
    { input: "maybe", label: "ambiguous string" },
    { input: "y", label: "single char y" },
    { input: "n", label: "single char n" },
    { input: 2, label: "number 2" },
    { input: -1, label: "number -1" },
    { input: null, label: "null" },
    { input: undefined, label: "undefined" },
    { input: {}, label: "object" },
    { input: [], label: "array" },
    { input: "truthy", label: "truthy-like string" },
  ])("$label → null", ({ input }) => {
    expect(coerceBoolean(input)).toBeNull();
  });
});

describe("coerceString", () => {
  it.each([
    { input: "hello", expected: "hello", label: "regular string" },
    { input: "", expected: "", label: "empty string" },
    { input: 42, expected: "42", label: "number to string" },
    { input: 3.14, expected: "3.14", label: "decimal to string" },
    { input: true, expected: "true", label: "boolean true to string" },
    { input: false, expected: "false", label: "boolean false to string" },
    { input: 0, expected: "0", label: "zero to string" },
  ])("$label → $expected", ({ input, expected }) => {
    expect(coerceString(input)).toBe(expected);
  });

  it.each([
    { input: null, label: "null" },
    { input: undefined, label: "undefined" },
    { input: {}, label: "object" },
    { input: [], label: "array" },
    { input: { toString: () => "sneaky" }, label: "object with toString" },
    { input: Infinity, label: "Infinity" },
    { input: NaN, label: "NaN" },
  ])("$label → null", ({ input }) => {
    expect(coerceString(input)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration tests for coerceWorkflowData
// ---------------------------------------------------------------------------

describe("coerceWorkflowData", () => {
  let logger: ReturnType<typeof createMockLogger>;
  const ctx = { signalId: "sgn-test", accountId: "acc-test", workflow: "payments" };

  beforeEach(() => {
    logger = createMockLogger();
  });

  // -------------------------------------------------------------------------
  // Number fields → string coercion
  // -------------------------------------------------------------------------

  describe("number fields (stored as string)", () => {
    it("coerces numeric amount to string — payments.amount", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "receipt", vendor: "Stripe", amount: 149.99, currency: "USD" };
      coerceWorkflowData(data, "payments", logger, ctx);
      expect(data.amount).toBe("149.99");
    });

    it("coerces string numeric amount to string — payments.amount", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "receipt", vendor: "Stripe", amount: "49.00", currency: "USD" };
      coerceWorkflowData(data, "payments", logger, ctx);
      expect(data.amount).toBe("49");
    });

    it("coerces zero to '0' — events.totalAmount", () => {
      const data: Record<string, unknown> = { workflow: "events", eventType: "ticket_confirmation", eventName: "CHNUG", totalAmount: 0, currency: "CHF" };
      coerceWorkflowData(data, "events", logger, { ...ctx, workflow: "events" });
      expect(data.totalAmount).toBe("0");
    });

    it("coerces string zero to '0' — events.totalAmount", () => {
      const data: Record<string, unknown> = { workflow: "events", eventType: "ticket_confirmation", eventName: "CHNUG", totalAmount: "0", currency: "CHF" };
      coerceWorkflowData(data, "events", logger, { ...ctx, workflow: "events" });
      expect(data.totalAmount).toBe("0");
    });

    it("coerces comma-separated string — package.totalAmount", () => {
      const data: Record<string, unknown> = { workflow: "package", packageType: "confirmation", retailer: "Amazon", totalAmount: "1,234.56" };
      coerceWorkflowData(data, "package", logger, { ...ctx, workflow: "package" });
      expect(data.totalAmount).toBe("1234.56");
    });

    it("nullifies non-numeric string and logs TRACK — package.totalAmount", () => {
      const data: Record<string, unknown> = { workflow: "package", packageType: "confirmation", retailer: "Amazon", totalAmount: "free" };
      coerceWorkflowData(data, "package", logger, { ...ctx, workflow: "package" });
      expect(data.totalAmount).toBeNull();
      expect(logger.calls).toContainEqual(expect.objectContaining({
        method: "track",
        context: expect.objectContaining({ code: "classifier.coercion_failed", field: "totalAmount" }),
      }));
    });

    it("nullifies currency-prefixed amount — travel.totalAmount", () => {
      const data: Record<string, unknown> = { workflow: "travel", travelType: "flight", provider: "Swiss", totalAmount: "CHF 250" };
      coerceWorkflowData(data, "travel", logger, { ...ctx, workflow: "travel" });
      expect(data.totalAmount).toBeNull();
      expect(logger.calls.some(c => c.method === "track" && c.context?.field === "totalAmount")).toBe(true);
    });

    it("coerces auth.expiresInMinutes number to string", () => {
      const data: Record<string, unknown> = { workflow: "auth", authType: "verification", service: "GitHub", code: "123456", expiresInMinutes: 15 };
      coerceWorkflowData(data, "auth", logger, { ...ctx, workflow: "auth" });
      expect(data.expiresInMinutes).toBe("15");
    });

    it("coerces events.ticketCount number to string", () => {
      const data: Record<string, unknown> = { workflow: "events", eventType: "ticket_confirmation", eventName: "Concert", ticketCount: 2 };
      coerceWorkflowData(data, "events", logger, { ...ctx, workflow: "events" });
      expect(data.ticketCount).toBe("2");
    });

    it("coerces events.ticketCount string '3' to string", () => {
      const data: Record<string, unknown> = { workflow: "events", eventType: "ticket_confirmation", eventName: "Concert", ticketCount: "3" };
      coerceWorkflowData(data, "events", logger, { ...ctx, workflow: "events" });
      expect(data.ticketCount).toBe("3");
    });

    it("nullifies word-number ticketCount", () => {
      const data: Record<string, unknown> = { workflow: "events", eventType: "ticket_confirmation", eventName: "Concert", ticketCount: "two" };
      coerceWorkflowData(data, "events", logger, { ...ctx, workflow: "events" });
      expect(data.ticketCount).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Boolean fields — coercion
  // -------------------------------------------------------------------------

  describe("boolean fields", () => {
    it("preserves native boolean true — conversation.requiresReply", () => {
      const data: Record<string, unknown> = { workflow: "conversation", sentiment: "neutral", requiresReply: true };
      coerceWorkflowData(data, "conversation", logger, { ...ctx, workflow: "conversation" });
      expect(data.requiresReply).toBe(true);
    });

    it("preserves native boolean false — alert.requiresAction", () => {
      const data: Record<string, unknown> = { workflow: "alert", alertType: "ci_failure", service: "GitLab", requiresAction: false };
      coerceWorkflowData(data, "alert", logger, { ...ctx, workflow: "alert" });
      expect(data.requiresAction).toBe(false);
    });

    it("coerces string 'true' to boolean — conversation.requiresReply", () => {
      const data: Record<string, unknown> = { workflow: "conversation", sentiment: "neutral", requiresReply: "true" };
      coerceWorkflowData(data, "conversation", logger, { ...ctx, workflow: "conversation" });
      expect(data.requiresReply).toBe(true);
    });

    it("coerces string 'yes' to boolean — healthcare.requiresAction", () => {
      const data: Record<string, unknown> = { workflow: "healthcare", eventType: "appointment_reminder", requiresAction: "yes", provider: "Dr. Smith" };
      coerceWorkflowData(data, "healthcare", logger, { ...ctx, workflow: "healthcare" });
      expect(data.requiresAction).toBe(true);
    });

    it("coerces number 1 to boolean true — alert.requiresAction", () => {
      const data: Record<string, unknown> = { workflow: "alert", alertType: "fraud_alert", service: "Bank", requiresAction: 1 };
      coerceWorkflowData(data, "alert", logger, { ...ctx, workflow: "alert" });
      expect(data.requiresAction).toBe(true);
    });

    it("coerces number 0 to boolean false — conversation.requiresReply", () => {
      const data: Record<string, unknown> = { workflow: "conversation", sentiment: "positive", requiresReply: 0 };
      coerceWorkflowData(data, "conversation", logger, { ...ctx, workflow: "conversation" });
      expect(data.requiresReply).toBe(false);
    });

    it("nullifies ambiguous boolean-like string and logs TRACK", () => {
      const data: Record<string, unknown> = { workflow: "conversation", sentiment: "neutral", requiresReply: "maybe" };
      coerceWorkflowData(data, "conversation", logger, { ...ctx, workflow: "conversation" });
      expect(data.requiresReply).toBeNull();
      expect(logger.calls).toContainEqual(expect.objectContaining({
        method: "track",
        context: expect.objectContaining({ code: "classifier.coercion_failed", field: "requiresReply" }),
      }));
    });
  });

  // -------------------------------------------------------------------------
  // Enum fields — validation
  // -------------------------------------------------------------------------

  describe("enum fields", () => {
    it("preserves valid enum value — payments.paymentType", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "receipt", vendor: "Stripe", amount: "10" };
      coerceWorkflowData(data, "payments", logger, ctx);
      expect(data.paymentType).toBe("receipt");
    });

    it("normalizes case-insensitive enum match — travel.travelType", () => {
      const data: Record<string, unknown> = { workflow: "travel", travelType: "FLIGHT", provider: "Lufthansa" };
      coerceWorkflowData(data, "travel", logger, { ...ctx, workflow: "travel" });
      expect(data.travelType).toBe("flight");
    });

    it("nullifies invalid enum value and logs TRACK", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "barter", vendor: "Local Shop" };
      coerceWorkflowData(data, "payments", logger, ctx);
      expect(data.paymentType).toBeNull();
      expect(logger.calls).toContainEqual(expect.objectContaining({
        method: "track",
        context: expect.objectContaining({ code: "classifier.coercion_failed", field: "paymentType" }),
      }));
    });

    it("nullifies non-string enum value", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: 42, vendor: "Fake" };
      coerceWorkflowData(data, "payments", logger, ctx);
      expect(data.paymentType).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // String fields — coercion
  // -------------------------------------------------------------------------

  describe("string fields", () => {
    it("preserves valid string — payments.vendor", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "receipt", vendor: "Stripe" };
      coerceWorkflowData(data, "payments", logger, ctx);
      expect(data.vendor).toBe("Stripe");
    });

    it("coerces number to string for free-text field — auth.service", () => {
      const data: Record<string, unknown> = { workflow: "auth", authType: "verification", service: 12345, code: "ABC" };
      coerceWorkflowData(data, "auth", logger, { ...ctx, workflow: "auth" });
      expect(data.service).toBe("12345");
    });

    it("nullifies object value for string field", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "receipt", vendor: { name: "Stripe" } };
      coerceWorkflowData(data, "payments", logger, ctx);
      expect(data.vendor).toBeNull();
      expect(logger.calls).toContainEqual(expect.objectContaining({
        method: "track",
        context: expect.objectContaining({ code: "classifier.coercion_failed", field: "vendor" }),
      }));
    });

    it("nullifies array value for string field", () => {
      const data: Record<string, unknown> = { workflow: "crm", senderCompany: ["Acme", "Corp"] };
      coerceWorkflowData(data, "crm", logger, { ...ctx, workflow: "crm" });
      expect(data.senderCompany).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Array fields
  // -------------------------------------------------------------------------

  describe("array fields", () => {
    it("preserves valid array — package.items", () => {
      const items = [{ name: "Widget", quantity: 1 }];
      const data: Record<string, unknown> = { workflow: "package", packageType: "confirmation", retailer: "Amazon", items };
      coerceWorkflowData(data, "package", logger, { ...ctx, workflow: "package" });
      expect(data.items).toBe(items);
    });

    it("nullifies non-array value for array field", () => {
      const data: Record<string, unknown> = { workflow: "package", packageType: "confirmation", retailer: "Amazon", items: "Widget x2" };
      coerceWorkflowData(data, "package", logger, { ...ctx, workflow: "package" });
      expect(data.items).toBeNull();
      expect(logger.calls).toContainEqual(expect.objectContaining({
        method: "track",
        context: expect.objectContaining({ code: "classifier.coercion_failed", field: "items" }),
      }));
    });

    it("preserves empty array — content.topics", () => {
      const data: Record<string, unknown> = { workflow: "content", contentType: "newsletter", publisher: "Substack", topics: [] };
      coerceWorkflowData(data, "content", logger, { ...ctx, workflow: "content" });
      expect(data.topics).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("skips fields not present in workflowData", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "receipt", vendor: "Stripe" };
      coerceWorkflowData(data, "payments", logger, ctx);
      expect(data.amount).toBeUndefined();
      expect(logger.calls).toHaveLength(0);
    });

    it("skips null values without logging", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "receipt", vendor: "Stripe", amount: null };
      coerceWorkflowData(data, "payments", logger, ctx);
      expect(data.amount).toBeNull();
      expect(logger.calls).toHaveLength(0);
    });

    it("skips undefined values without logging", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "receipt", vendor: "Stripe", amount: undefined };
      coerceWorkflowData(data, "payments", logger, ctx);
      expect(data.amount).toBeUndefined();
      expect(logger.calls).toHaveLength(0);
    });

    it("does nothing for unknown workflow", () => {
      const data: Record<string, unknown> = { workflow: "unknown", someField: "value" };
      coerceWorkflowData(data, "unknown", logger, { ...ctx, workflow: "unknown" });
      expect(data.someField).toBe("value");
      expect(logger.calls).toHaveLength(0);
    });

    it("does not touch extra fields not in the registry", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "receipt", vendor: "Stripe", extraGarbage: { nested: true } };
      coerceWorkflowData(data, "payments", logger, ctx);
      expect(data.extraGarbage).toEqual({ nested: true });
    });
  });

  // -------------------------------------------------------------------------
  // Real-world LLM output scenarios
  // -------------------------------------------------------------------------

  describe("real-world LLM output scenarios", () => {
    it("handles the CHNUG event signal from the bug report", () => {
      const data: Record<string, unknown> = {
        workflow: "events",
        eventType: "ticket_confirmation",
        eventName: "CHNUG #4",
        totalAmount: 0,
        ticketReference: "O-UGWRW9Q",
        currency: "CHF",
        eventStartDatetime: "2026-08-26T17:00:00Z",
      };
      coerceWorkflowData(data, "events", logger, { ...ctx, workflow: "events" });
      expect(data.totalAmount).toBe("0");
      expect(data.ticketReference).toBe("O-UGWRW9Q");
      expect(data.eventType).toBe("ticket_confirmation");
      expect(logger.calls).toHaveLength(0);
    });

    it("handles Stripe invoice with numeric amount", () => {
      const data: Record<string, unknown> = {
        workflow: "payments",
        paymentType: "invoice",
        vendor: "DigitalOcean",
        amount: 12,
        currency: "USD",
        invoiceNumber: "INV-2024-5678",
        dueDate: "2024-02-15",
      };
      coerceWorkflowData(data, "payments", logger, ctx);
      expect(data.amount).toBe("12");
      expect(data.paymentType).toBe("invoice");
    });

    it("handles flight booking with amount as string '199.00'", () => {
      const data: Record<string, unknown> = {
        workflow: "travel",
        travelType: "flight",
        provider: "Swiss",
        confirmationNumber: "ABC123",
        totalAmount: "199.00",
        currency: "CHF",
        departureDate: "2024-03-15T08:30:00Z",
      };
      coerceWorkflowData(data, "travel", logger, { ...ctx, workflow: "travel" });
      expect(data.totalAmount).toBe("199");
    });

    it("handles package with items array and numeric totalAmount", () => {
      const data: Record<string, unknown> = {
        workflow: "package",
        packageType: "shipping",
        retailer: "Galaxus",
        trackingNumber: "99.12.345678.12345678",
        totalAmount: 89.9,
        items: [{ name: "USB-C Cable", quantity: 2, price: 12.95 }],
      };
      coerceWorkflowData(data, "package", logger, { ...ctx, workflow: "package" });
      expect(data.totalAmount).toBe("89.9");
    });

    it("handles auth OTP with expiresInMinutes as string '10'", () => {
      const data: Record<string, unknown> = {
        workflow: "auth",
        authType: "verification",
        service: "GitHub",
        code: "483921",
        expiresInMinutes: "10",
      };
      coerceWorkflowData(data, "auth", logger, { ...ctx, workflow: "auth" });
      expect(data.expiresInMinutes).toBe("10");
    });
  });
});
