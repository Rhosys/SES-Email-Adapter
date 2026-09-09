import { describe, it, expect, vi, beforeEach } from "vitest";
import { coerceWorkflowData, coerceNumericToString, coerceBoolean, coerceString, isAmbiguousSlashSkip } from "../../src/classifier/coerce-workflow-data.js";
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
  const receivedAt = "2025-01-15T12:00:00Z";

  beforeEach(() => {
    logger = createMockLogger();
  });

  // -------------------------------------------------------------------------
  // Number fields → string coercion
  // -------------------------------------------------------------------------

  describe("number fields (stored as string)", () => {
    it("coerces numeric amount to string — payments.amount", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "receipt", vendor: "Stripe", amount: 149.99, currency: "USD" };
      const result = coerceWorkflowData(data, "payments", logger, ctx, receivedAt);
      expect(result.amount).toBe("149.99");
    });

    it("coerces string numeric amount to string — payments.amount", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "receipt", vendor: "Stripe", amount: "49.00", currency: "USD" };
      const result = coerceWorkflowData(data, "payments", logger, ctx, receivedAt);
      expect(result.amount).toBe("49");
    });

    it("coerces zero to '0' — events.totalAmount", () => {
      const data: Record<string, unknown> = { workflow: "events", eventType: "ticket_confirmation", eventName: "CHNUG", totalAmount: 0, currency: "CHF" };
      const result = coerceWorkflowData(data, "events", logger, { ...ctx, workflow: "events" }, receivedAt);
      expect(result.totalAmount).toBe("0");
    });

    it("coerces string zero to '0' — events.totalAmount", () => {
      const data: Record<string, unknown> = { workflow: "events", eventType: "ticket_confirmation", eventName: "CHNUG", totalAmount: "0", currency: "CHF" };
      const result = coerceWorkflowData(data, "events", logger, { ...ctx, workflow: "events" }, receivedAt);
      expect(result.totalAmount).toBe("0");
    });

    it("coerces comma-separated string — package.totalAmount", () => {
      const data: Record<string, unknown> = { workflow: "package", packageType: "confirmation", retailer: "Amazon", totalAmount: "1,234.56" };
      const result = coerceWorkflowData(data, "package", logger, { ...ctx, workflow: "package" }, receivedAt);
      expect(result.totalAmount).toBe("1234.56");
    });

    it("nullifies non-numeric string and logs TRACK — package.totalAmount", () => {
      const data: Record<string, unknown> = { workflow: "package", packageType: "confirmation", retailer: "Amazon", totalAmount: "free" };
      const result = coerceWorkflowData(data, "package", logger, { ...ctx, workflow: "package" }, receivedAt);
      expect(result.totalAmount).toBeNull();
      expect(logger.calls).toContainEqual(expect.objectContaining({
        method: "track",
        context: expect.objectContaining({ code: "classifier.coercion_failed", field: "totalAmount" }),
      }));
    });

    it("nullifies currency-prefixed amount — travel.totalAmount", () => {
      const data: Record<string, unknown> = { workflow: "travel", travelType: "flight", provider: "Swiss", totalAmount: "CHF 250" };
      const result = coerceWorkflowData(data, "travel", logger, { ...ctx, workflow: "travel" }, receivedAt);
      expect(result.totalAmount).toBeNull();
      expect(logger.calls.some(c => c.method === "track" && c.context?.field === "totalAmount")).toBe(true);
    });

    it("coerces auth.expiresInMinutes number to string", () => {
      const data: Record<string, unknown> = { workflow: "auth", authType: "verification", service: "GitHub", code: "123456", expiresInMinutes: 15 };
      const result = coerceWorkflowData(data, "auth", logger, { ...ctx, workflow: "auth" }, receivedAt);
      expect(result.expiresInMinutes).toBe("15");
    });

    it("coerces events.ticketCount number to string", () => {
      const data: Record<string, unknown> = { workflow: "events", eventType: "ticket_confirmation", eventName: "Concert", ticketCount: 2 };
      const result = coerceWorkflowData(data, "events", logger, { ...ctx, workflow: "events" }, receivedAt);
      expect(result.ticketCount).toBe("2");
    });

    it("coerces events.ticketCount string '3' to string", () => {
      const data: Record<string, unknown> = { workflow: "events", eventType: "ticket_confirmation", eventName: "Concert", ticketCount: "3" };
      const result = coerceWorkflowData(data, "events", logger, { ...ctx, workflow: "events" }, receivedAt);
      expect(result.ticketCount).toBe("3");
    });

    it("nullifies word-number ticketCount", () => {
      const data: Record<string, unknown> = { workflow: "events", eventType: "ticket_confirmation", eventName: "Concert", ticketCount: "two" };
      const result = coerceWorkflowData(data, "events", logger, { ...ctx, workflow: "events" }, receivedAt);
      expect(result.ticketCount).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Boolean fields — coercion
  // -------------------------------------------------------------------------

  describe("boolean fields", () => {
    it("preserves native boolean true — conversation.requiresReply", () => {
      const data: Record<string, unknown> = { workflow: "conversation", sentiment: "neutral", requiresReply: true };
      const result = coerceWorkflowData(data, "conversation", logger, { ...ctx, workflow: "conversation" }, receivedAt);
      expect(result.requiresReply).toBe(true);
    });

    it("preserves native boolean false — alert.requiresAction", () => {
      const data: Record<string, unknown> = { workflow: "alert", alertType: "ci_failure", service: "GitLab", requiresAction: false };
      const result = coerceWorkflowData(data, "alert", logger, { ...ctx, workflow: "alert" }, receivedAt);
      expect(result.requiresAction).toBe(false);
    });

    it("coerces string 'true' to boolean — conversation.requiresReply", () => {
      const data: Record<string, unknown> = { workflow: "conversation", sentiment: "neutral", requiresReply: "true" };
      const result = coerceWorkflowData(data, "conversation", logger, { ...ctx, workflow: "conversation" }, receivedAt);
      expect(result.requiresReply).toBe(true);
    });

    it("coerces string 'yes' to boolean — healthcare.requiresAction", () => {
      const data: Record<string, unknown> = { workflow: "healthcare", eventType: "appointment_reminder", requiresAction: "yes", provider: "Dr. Smith" };
      const result = coerceWorkflowData(data, "healthcare", logger, { ...ctx, workflow: "healthcare" }, receivedAt);
      expect(result.requiresAction).toBe(true);
    });

    it("coerces number 1 to boolean true — alert.requiresAction", () => {
      const data: Record<string, unknown> = { workflow: "alert", alertType: "fraud_alert", service: "Bank", requiresAction: 1 };
      const result = coerceWorkflowData(data, "alert", logger, { ...ctx, workflow: "alert" }, receivedAt);
      expect(result.requiresAction).toBe(true);
    });

    it("coerces number 0 to boolean false — conversation.requiresReply", () => {
      const data: Record<string, unknown> = { workflow: "conversation", sentiment: "positive", requiresReply: 0 };
      const result = coerceWorkflowData(data, "conversation", logger, { ...ctx, workflow: "conversation" }, receivedAt);
      expect(result.requiresReply).toBe(false);
    });

    it("nullifies ambiguous boolean-like string and logs TRACK", () => {
      const data: Record<string, unknown> = { workflow: "conversation", sentiment: "neutral", requiresReply: "maybe" };
      const result = coerceWorkflowData(data, "conversation", logger, { ...ctx, workflow: "conversation" }, receivedAt);
      expect(result.requiresReply).toBeNull();
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
      const result = coerceWorkflowData(data, "payments", logger, ctx, receivedAt);
      expect(result.paymentType).toBe("receipt");
    });

    it("normalizes case-insensitive enum match — travel.travelType", () => {
      const data: Record<string, unknown> = { workflow: "travel", travelType: "FLIGHT", provider: "Lufthansa" };
      const result = coerceWorkflowData(data, "travel", logger, { ...ctx, workflow: "travel" }, receivedAt);
      expect(result.travelType).toBe("flight");
    });

    it("nullifies invalid enum value and logs TRACK", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "barter", vendor: "Local Shop" };
      const result = coerceWorkflowData(data, "payments", logger, ctx, receivedAt);
      expect(result.paymentType).toBeNull();
      expect(logger.calls).toContainEqual(expect.objectContaining({
        method: "track",
        context: expect.objectContaining({ code: "classifier.coercion_failed", field: "paymentType" }),
      }));
    });

    it("nullifies non-string enum value", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: 42, vendor: "Fake" };
      const result = coerceWorkflowData(data, "payments", logger, ctx, receivedAt);
      expect(result.paymentType).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // String fields — coercion
  // -------------------------------------------------------------------------

  describe("string fields", () => {
    it("preserves valid string — payments.vendor", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "receipt", vendor: "Stripe" };
      const result = coerceWorkflowData(data, "payments", logger, ctx, receivedAt);
      expect(result.vendor).toBe("Stripe");
    });

    it("coerces number to string for free-text field — auth.service", () => {
      const data: Record<string, unknown> = { workflow: "auth", authType: "verification", service: 12345, code: "ABC" };
      const result = coerceWorkflowData(data, "auth", logger, { ...ctx, workflow: "auth" }, receivedAt);
      expect(result.service).toBe("12345");
    });

    it("nullifies object value for string field", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "receipt", vendor: { name: "Stripe" } };
      const result = coerceWorkflowData(data, "payments", logger, ctx, receivedAt);
      expect(result.vendor).toBeNull();
      expect(logger.calls).toContainEqual(expect.objectContaining({
        method: "track",
        context: expect.objectContaining({ code: "classifier.coercion_failed", field: "vendor" }),
      }));
    });

    it("nullifies array value for string field", () => {
      const data: Record<string, unknown> = { workflow: "crm", senderCompany: ["Acme", "Corp"] };
      const result = coerceWorkflowData(data, "crm", logger, { ...ctx, workflow: "crm" }, receivedAt);
      expect(result.senderCompany).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Array fields
  // -------------------------------------------------------------------------

  describe("array fields", () => {
    it("preserves valid array — package.items", () => {
      const items = [{ name: "Widget", quantity: 1 }];
      const data: Record<string, unknown> = { workflow: "package", packageType: "confirmation", retailer: "Amazon", items };
      const result = coerceWorkflowData(data, "package", logger, { ...ctx, workflow: "package" }, receivedAt);
      expect(result.items).toBe(items);
    });

    it("nullifies non-array value for array field", () => {
      const data: Record<string, unknown> = { workflow: "package", packageType: "confirmation", retailer: "Amazon", items: "Widget x2" };
      const result = coerceWorkflowData(data, "package", logger, { ...ctx, workflow: "package" }, receivedAt);
      expect(result.items).toBeNull();
      expect(logger.calls).toContainEqual(expect.objectContaining({
        method: "track",
        context: expect.objectContaining({ code: "classifier.coercion_failed", field: "items" }),
      }));
    });

    it("preserves empty array — content.topics", () => {
      const data: Record<string, unknown> = { workflow: "content", contentType: "newsletter", publisher: "Substack", topics: [] };
      const result = coerceWorkflowData(data, "content", logger, { ...ctx, workflow: "content" }, receivedAt);
      expect(result.topics).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("skips fields not present in workflowData", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "receipt", vendor: "Stripe" };
      const result = coerceWorkflowData(data, "payments", logger, ctx, receivedAt);
      expect(result.amount).toBeUndefined();
      expect(logger.calls).toHaveLength(0);
    });

    it("skips null values without logging", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "receipt", vendor: "Stripe", amount: null };
      const result = coerceWorkflowData(data, "payments", logger, ctx, receivedAt);
      expect(result.amount).toBeNull();
      expect(logger.calls).toHaveLength(0);
    });

    it("skips undefined values without logging", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "receipt", vendor: "Stripe", amount: undefined };
      const result = coerceWorkflowData(data, "payments", logger, ctx, receivedAt);
      expect(result.amount).toBeUndefined();
      expect(logger.calls).toHaveLength(0);
    });

    it("does nothing for unknown workflow", () => {
      const data: Record<string, unknown> = { workflow: "unknown", someField: "value" };
      const result = coerceWorkflowData(data, "unknown", logger, { ...ctx, workflow: "unknown" }, receivedAt);
      expect(result.someField).toBe("value");
      expect(logger.calls).toHaveLength(0);
    });

    it("does not touch extra fields not in the registry", () => {
      const data: Record<string, unknown> = { workflow: "payments", paymentType: "receipt", vendor: "Stripe", extraGarbage: { nested: true } };
      const result = coerceWorkflowData(data, "payments", logger, ctx, receivedAt);
      expect(result.extraGarbage).toEqual({ nested: true });
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
      const result = coerceWorkflowData(data, "events", logger, { ...ctx, workflow: "events" }, receivedAt);
      expect(result.totalAmount).toBe("0");
      expect(result.ticketReference).toBe("O-UGWRW9Q");
      expect(result.eventType).toBe("ticket_confirmation");
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
      const result = coerceWorkflowData(data, "payments", logger, ctx, receivedAt);
      expect(result.amount).toBe("12");
      expect(result.paymentType).toBe("invoice");
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
      const result = coerceWorkflowData(data, "travel", logger, { ...ctx, workflow: "travel" }, receivedAt);
      expect(result.totalAmount).toBe("199");
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
      const result = coerceWorkflowData(data, "package", logger, { ...ctx, workflow: "package" }, receivedAt);
      expect(result.totalAmount).toBe("89.9");
    });

    it("handles auth OTP with expiresInMinutes as string '10'", () => {
      const data: Record<string, unknown> = {
        workflow: "auth",
        authType: "verification",
        service: "GitHub",
        code: "483921",
        expiresInMinutes: "10",
      };
      const result = coerceWorkflowData(data, "auth", logger, { ...ctx, workflow: "auth" }, receivedAt);
      expect(result.expiresInMinutes).toBe("10");
    });
  });

  // -------------------------------------------------------------------------
  // Date fields — slash-date disambiguation + logging branch
  // -------------------------------------------------------------------------

  describe("date fields — slash-date logging branch", () => {
    const travelCtx = { ...ctx, workflow: "travel" };
    const base = { workflow: "travel", travelType: "flight", provider: "Swiss" };

    it("parses unambiguous slash date (component > 12) with no log", () => {
      const data: Record<string, unknown> = { ...base, departureDate: "15/03/2025" };
      const result = coerceWorkflowData(data, "travel", logger, travelCtx, receivedAt, [], "skip");
      expect(result.departureDate).toBe("2025-03-15");
      expect(logger.calls).toHaveLength(0);
    });

    it("ambiguous slash date under skip → WARN without the raw date, value nullified", () => {
      const data: Record<string, unknown> = { ...base, departureDate: "03/02/2027 | 18:30" };
      const result = coerceWorkflowData(data, "travel", logger, travelCtx, receivedAt, [], "skip");
      expect(result.departureDate).toBeNull();

      const warn = logger.calls.find(c => c.method === "warn");
      expect(warn).toBeDefined();
      expect(warn!.context).toEqual(expect.objectContaining({
        code: "classifier.date_ambiguous_skipped",
        field: "departureDate",
      }));
      // The raw ambiguous date must not leak into the message or context.
      expect(warn!.message).not.toContain("03/02/2027");
      expect(warn!.context).not.toHaveProperty("value");
      // And it must not be logged as a TRACK parse failure.
      expect(logger.calls.some(c => c.method === "track")).toBe(false);
    });

    it("ambiguous slash date under month_then_day → parses, no log", () => {
      const data: Record<string, unknown> = { ...base, departureDate: "03/02/2027" };
      const result = coerceWorkflowData(data, "travel", logger, travelCtx, receivedAt, [], "month_then_day");
      expect(result.departureDate).toBe("2027-03-02");
      expect(logger.calls).toHaveLength(0);
    });

    it("ambiguous slash date under day_then_month → parses, no log", () => {
      const data: Record<string, unknown> = { ...base, departureDate: "03/02/2027" };
      const result = coerceWorkflowData(data, "travel", logger, travelCtx, receivedAt, [], "day_then_month");
      expect(result.departureDate).toBe("2027-02-03");
      expect(logger.calls).toHaveLength(0);
    });

    it("genuinely unparseable date → TRACK with the raw value (not a WARN)", () => {
      const data: Record<string, unknown> = { ...base, departureDate: "not a date at all" };
      const result = coerceWorkflowData(data, "travel", logger, travelCtx, receivedAt, [], "skip");
      expect(result.departureDate).toBeNull();

      const track = logger.calls.find(c => c.method === "track");
      expect(track).toBeDefined();
      expect(track!.context).toEqual(expect.objectContaining({
        code: "classifier.date_parse_failed",
        field: "departureDate",
        value: "not a date at all",
      }));
      expect(logger.calls.some(c => c.method === "warn")).toBe(false);
    });

    it("defaults to skip when ambiguousDateFormat arg is omitted", () => {
      const data: Record<string, unknown> = { ...base, departureDate: "03/02/2027" };
      const result = coerceWorkflowData(data, "travel", logger, travelCtx, receivedAt);
      expect(result.departureDate).toBeNull();
      expect(logger.calls.some(c => c.method === "warn" && c.context?.code === "classifier.date_ambiguous_skipped")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // isAmbiguousSlashSkip predicate
  // -------------------------------------------------------------------------

  describe("isAmbiguousSlashSkip", () => {
    it.each([
      { value: "03/02/2027", label: "ambiguous full date" },
      { value: "3/2/27", label: "ambiguous short date" },
      { value: "03/02/2027 | 18:30", label: "ambiguous date with time" },
      { value: "01/12", label: "ambiguous year-free date" },
    ])("true for $label under skip", ({ value }) => {
      expect(isAmbiguousSlashSkip(value, "skip")).toBe(true);
    });

    it.each([
      { value: "15/03/2027", label: "first component > 12 (unambiguous)" },
      { value: "03/15/2027", label: "second component > 12 (unambiguous)" },
      { value: "15/16/2027", label: "both components > 12 (not a date)" },
      { value: "not a date", label: "non-slash string" },
      { value: "2025-03-15", label: "ISO date" },
      { value: 42, label: "non-string" },
      { value: null, label: "null" },
    ])("false for $label under skip", ({ value }) => {
      expect(isAmbiguousSlashSkip(value, "skip")).toBe(false);
    });

    it("false when setting is month_then_day even for an ambiguous date", () => {
      expect(isAmbiguousSlashSkip("03/02/2027", "month_then_day")).toBe(false);
    });

    it("false when setting is day_then_month even for an ambiguous date", () => {
      expect(isAmbiguousSlashSkip("03/02/2027", "day_then_month")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Instant siblings — the display -> instant computation now happens here,
  // once, at coercion time, storing a "<field>Instant" sibling next to the
  // display string. deriveResourceInfo reads this instead of reparsing.
  // -------------------------------------------------------------------------

  describe("instant siblings", () => {
    const eventsCtx = { ...ctx, workflow: "events" };
    const eventsBase = { workflow: "events", eventType: "reminder", eventName: "Concert" };

    it("stores an instant sibling next to a date field, applying account tz to an offset-free display", () => {
      const data: Record<string, unknown> = { ...eventsBase, eventStartDatetime: "2027-02-03T18:00" };
      const result = coerceWorkflowData(data, "events", logger, eventsCtx, receivedAt, [], "skip", "Europe/Zurich");
      // Feb is CET (+01:00): 18:00 Zurich -> 17:00 UTC.
      expect(result.eventStartDatetime).toBe("2027-02-03T18:00");
      expect(result.eventStartDatetimeInstant).toBe("2027-02-03T17:00:00.000Z");
    });

    it("ignores account tz when the display already carries an offset", () => {
      const data: Record<string, unknown> = { ...eventsBase, eventStartDatetime: "2027-02-03T18:00:00+02:00" };
      const result = coerceWorkflowData(data, "events", logger, eventsCtx, receivedAt, [], "skip", "America/New_York");
      expect(result.eventStartDatetime).toBe("2027-02-03T18:00+02:00");
      expect(result.eventStartDatetimeInstant).toBe("2027-02-03T16:00:00.000Z");
    });

    it("date-only display -> midnight in account tz", () => {
      const data: Record<string, unknown> = { ...eventsBase, eventStartDatetime: "2027-02-03" };
      const result = coerceWorkflowData(data, "events", logger, eventsCtx, receivedAt, [], "skip", "Europe/Zurich");
      // Midnight Feb 3 Zurich (CET, +01:00) -> 23:00 Feb 2 UTC.
      expect(result.eventStartDatetime).toBe("2027-02-03");
      expect(result.eventStartDatetimeInstant).toBe("2027-02-02T23:00:00.000Z");
    });

    it("defaults to Europe/London when no account tz is supplied", () => {
      const data: Record<string, unknown> = { ...eventsBase, eventStartDatetime: "2027-01-15T09:00" };
      const result = coerceWorkflowData(data, "events", logger, eventsCtx, receivedAt);
      // January in London is GMT: 09:00 -> 09:00 UTC.
      expect(result.eventStartDatetimeInstant).toBe("2027-01-15T09:00:00.000Z");
    });

    it("stores a null instant sibling when the date is unparseable", () => {
      const data: Record<string, unknown> = { ...eventsBase, eventStartDatetime: "not-a-date" };
      const result = coerceWorkflowData(data, "events", logger, eventsCtx, receivedAt, [], "skip", "Europe/Zurich");
      expect(result.eventStartDatetime).toBeNull();
      expect(result.eventStartDatetimeInstant).toBeNull();
    });

    it("computes an instant sibling for every date field on a multi-date workflow (travel)", () => {
      const data: Record<string, unknown> = {
        workflow: "travel", travelType: "flight", provider: "Swiss",
        departureDate: "2027-03-15T08:00", returnDate: "2027-03-20T20:00", boardingTime: "2027-03-15T07:30",
      };
      const result = coerceWorkflowData(data, "travel", logger, { ...ctx, workflow: "travel" }, receivedAt, [], "skip", "Europe/Zurich");
      // March 15/20 Zurich is CET (+01:00) -> subtract 1h for UTC.
      expect(result.departureDateInstant).toBe("2027-03-15T07:00:00.000Z");
      expect(result.returnDateInstant).toBe("2027-03-20T19:00:00.000Z");
      expect(result.boardingTimeInstant).toBe("2027-03-15T06:30:00.000Z");
    });
  });
});
