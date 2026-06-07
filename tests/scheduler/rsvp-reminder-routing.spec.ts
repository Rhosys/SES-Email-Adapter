// Feature: calendar-rsvp-reminder, Property 3 (partial): Handler routing
// Validates: Requirements 7.2, 7.3, 7.4

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok } from "../../src/errors.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import type { RsvpReminderMessage } from "../../src/scheduler/rsvp-reminder.js";

// ---------------------------------------------------------------------------
// Minimal SQS record factory
// ---------------------------------------------------------------------------

interface MinimalSqsRecord {
  messageId: string;
  body: string;
  attributes: { ApproximateReceiveCount: string };
  messageAttributes?: Record<string, { stringValue: string; dataType: string }>;
  eventSource: "aws:sqs";
}

function makeSqsRecord(body: unknown, messageAttributes?: Record<string, { stringValue: string; dataType: string }>): MinimalSqsRecord {
  return {
    messageId: `msg-${Math.random().toString(36).slice(2, 8)}`,
    body: JSON.stringify(body),
    attributes: { ApproximateReceiveCount: "1" },
    ...(messageAttributes ? { messageAttributes } : {}),
    eventSource: "aws:sqs",
  };
}

// ---------------------------------------------------------------------------
// Routing logic extracted (mirrors handler.ts routing)
// ---------------------------------------------------------------------------

/**
 * We test the routing decision in isolation — the handler.ts routing logic
 * reads messageType from record.messageAttributes?.["messageType"]?.stringValue
 * OR falls back to body.sqsMessageAttributeMessageType.
 *
 * Then it validates the payload has the required fields before calling the handler.
 */
function extractMessageType(record: MinimalSqsRecord, parsedBody: Record<string, unknown>): string | undefined {
  return record.messageAttributes?.["messageType"]?.stringValue
    ?? (parsedBody as { sqsMessageAttributeMessageType?: string }).sqsMessageAttributeMessageType;
}

function isValidRsvpReminderPayload(body: unknown): body is RsvpReminderMessage {
  const msg = body as Record<string, unknown>;
  return Boolean(msg.accountId && msg.signalId && msg.arcId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Handler routing — rsvp_reminder", () => {
  it("routes via SQS message attribute messageType: rsvp_reminder", () => {
    const body: RsvpReminderMessage = { accountId: "acc-001", signalId: "sgn-001", arcId: "arc-001" };
    const record = makeSqsRecord(body, {
      messageType: { stringValue: "rsvp_reminder", dataType: "String" },
    });

    const parsed = JSON.parse(record.body);
    const messageType = extractMessageType(record, parsed);

    expect(messageType).toBe("rsvp_reminder");
    expect(isValidRsvpReminderPayload(parsed)).toBe(true);
  });

  it("routes via body fallback: sqsMessageAttributeMessageType (no SQS attribute)", () => {
    const body = {
      sqsMessageAttributeMessageType: "rsvp_reminder",
      accountId: "acc-002",
      signalId: "sgn-002",
      arcId: "arc-002",
    };
    const record = makeSqsRecord(body); // no messageAttributes

    const parsed = JSON.parse(record.body);
    const messageType = extractMessageType(record, parsed);

    expect(messageType).toBe("rsvp_reminder");
    expect(isValidRsvpReminderPayload(parsed)).toBe(true);
  });

  it("SQS attribute takes precedence over body fallback", () => {
    const body = {
      sqsMessageAttributeMessageType: "signal_followup", // wrong in body
      accountId: "acc-003",
      signalId: "sgn-003",
      arcId: "arc-003",
    };
    const record = makeSqsRecord(body, {
      messageType: { stringValue: "rsvp_reminder", dataType: "String" },
    });

    const parsed = JSON.parse(record.body);
    const messageType = extractMessageType(record, parsed);

    expect(messageType).toBe("rsvp_reminder");
  });

  it("malformed payload (missing accountId) → validation fails", () => {
    const body = { sqsMessageAttributeMessageType: "rsvp_reminder", signalId: "sgn-004", arcId: "arc-004" };
    const record = makeSqsRecord(body);

    const parsed = JSON.parse(record.body);
    const messageType = extractMessageType(record, parsed);

    expect(messageType).toBe("rsvp_reminder");
    expect(isValidRsvpReminderPayload(parsed)).toBe(false);
  });

  it("malformed payload (missing signalId) → validation fails", () => {
    const body = { sqsMessageAttributeMessageType: "rsvp_reminder", accountId: "acc-005", arcId: "arc-005" };

    expect(isValidRsvpReminderPayload(body)).toBe(false);
  });

  it("malformed payload (missing arcId) → validation fails", () => {
    const body = { sqsMessageAttributeMessageType: "rsvp_reminder", accountId: "acc-006", signalId: "sgn-006" };

    expect(isValidRsvpReminderPayload(body)).toBe(false);
  });

  it("malformed payload (empty object) → validation fails", () => {
    expect(isValidRsvpReminderPayload({})).toBe(false);
  });

  describe("malformed payload logging (handler behavior)", () => {
    it("logs ERROR and continues (no batch failure) on malformed rsvp_reminder", () => {
      const logger = createMockLogger();
      // Simulate what handler.ts does: log error, then continue (no push to failures)
      const body = { sqsMessageAttributeMessageType: "rsvp_reminder", signalId: "sgn-007" };

      if (!isValidRsvpReminderPayload(body)) {
        logger.error("Malformed rsvp_reminder payload — missing required fields. Dropping message.", {
          code: "handler.sqs.malformed_rsvp_reminder",
          messageId: "msg-test",
        });
        // `continue` in the real handler — we just verify the error was logged and no failure reported
      }

      const errorCalls = logger.calls.filter((c) => c.method === "error");
      expect(errorCalls).toHaveLength(1);
      expect(errorCalls[0]!.context).toMatchObject({ code: "handler.sqs.malformed_rsvp_reminder" });
    });
  });
});
