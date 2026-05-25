import { describe, it, expect, vi } from "vitest";
import { handleCalendarResponse } from "../../../src/processor/calendar/calendar-response-handler.js";
import type { CalendarResponseHandlerDeps } from "../../../src/processor/calendar/calendar-response-handler.js";
import type { InboundSignalMessage } from "../../../src/processor/processor.js";
import type { Logger } from "../../../src/logger.js";
import { ok } from "../../../src/errors.js";
import { buildProxyUid } from "../../../src/processor/calendar/proxy-uid.js";
import { generateId, generateAccountId } from "../../../src/utils/id.js";

// ---------------------------------------------------------------------------
// Mock hmac-secret.ts — deterministic HMAC for tests without real KMS
// ---------------------------------------------------------------------------

import { createHmac } from "node:crypto";

vi.mock("../../../src/processor/calendar/hmac-secret.js", () => ({
  computeHmac16: (payload: string) =>
    Promise.resolve(createHmac("sha256", new Uint8Array(32)).update(payload).digest("base64url").slice(0, 16)),
  validateHmac16: (payload: string, hmac16: string) =>
    Promise.resolve(createHmac("sha256", new Uint8Array(32)).update(payload).digest("base64url").slice(0, 16) === hmac16),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVICE_DOMAIN = "platform.email.rhosys.cloud";

// Valid IDs generated with the real algorithm from utils/id.ts
const VALID_ARC_ID = generateId("arc-");
const VALID_ACC_ID = generateAccountId();

function makeLogger(): Logger {
  return {
    startInvocation: vi.fn(),
    getInvocationId: vi.fn(() => "inv-001"),
    trackPoint: vi.fn(),
    info: vi.fn(),
    track: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    critical: vi.fn(),
  } as unknown as Logger;
}

function makeMessage(destination: string[]): InboundSignalMessage {
  return {
    accountId: VALID_ACC_ID,
    s3Key: "emails/test.eml",
    sesMessageId: "ses-msg-001",
    timestamp: "2025-03-15T10:00:00Z",
    destination,
    dkimVerdict: "PASS",
    dmarcVerdict: "PASS",
  };
}

function makeDeps(overrides: Partial<CalendarResponseHandlerDeps> = {}): CalendarResponseHandlerDeps {
  return {
    serviceDomain: SERVICE_DOMAIN,
    arcDatabase: {
      getArc: vi.fn().mockResolvedValue(ok({
        id: VALID_ARC_ID,
        accountId: VALID_ACC_ID,
        status: "active",
        labels: [],
        summary: "Test arc",
        workflow: "conversation",
        lastSignalAt: "2025-03-15T10:00:00Z",
        createdAt: "2025-03-15T09:00:00Z",
      })),
    } as unknown as CalendarResponseHandlerDeps["arcDatabase"],
    rsvpComposer: vi.fn().mockResolvedValue(ok({ messageId: "ses-reply-001" })),
    signalStore: {
      saveSignal: vi.fn().mockResolvedValue(ok(undefined)),
    },
    emailService: {
      send: vi.fn().mockResolvedValue(ok({ messageId: "ses-msg-002" })),
      sendRaw: vi.fn(),
    } as unknown as CalendarResponseHandlerDeps["emailService"],
    ...overrides,
  };
}

/**
 * Build a minimal valid METHOD:REPLY .ics with a proxy UID as the VEVENT UID.
 */
function buildReplyIcsBytes(proxyUid: string, partstat = "ACCEPTED"): Uint8Array {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//Test//EN",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${proxyUid}`,
    "SEQUENCE:1",
    "DTSTART:20250315T100000Z",
    "DTEND:20250315T110000Z",
    "SUMMARY:Team Standup",
    `ORGANIZER;CN=Alice Smith:mailto:alice@example.com`,
    `ATTENDEE;PARTSTAT=${partstat}:mailto:${VALID_ARC_ID}@${VALID_ACC_ID}.${SERVICE_DOMAIN}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  return new TextEncoder().encode(ics);
}

// ---------------------------------------------------------------------------
// Property 16: Address pattern routing
// Validates: Requirements 13.1, 13.2
// ---------------------------------------------------------------------------

describe("validateId — address pattern routing", () => {
  it.each([
    {
      recipient: `${VALID_ARC_ID}@${VALID_ACC_ID}.${SERVICE_DOMAIN}`,
      routed: true,
      reason: "valid arcId + valid accountId + correct domain → routed",
    },
    {
      recipient: "user@example.com",
      routed: false,
      reason: "unrelated domain → not routed (domain mismatch)",
    },
    {
      recipient: `arc-badchk@${VALID_ACC_ID}.${SERVICE_DOMAIN}`,
      routed: false,
      reason: "arcId checksum fails → not routed",
    },
    {
      recipient: "me@mydomain.com",
      routed: false,
      reason: "unrelated address → not routed (domain mismatch)",
    },
  ])("$reason", async ({ recipient, routed }) => {
    const deps = makeDeps();
    const logger = makeLogger();
    const proxyUid = await buildProxyUid({
      accountId: VALID_ACC_ID,
      arcId: VALID_ARC_ID,
      originalVeventUid: "uid-original-123",
      serviceDomain: SERVICE_DOMAIN,
    });
    const icsBytes = buildReplyIcsBytes(proxyUid);
    const message = makeMessage([recipient]);

    await handleCalendarResponse(message, deps, logger, icsBytes);

    if (routed) {
      // DB was called → routing succeeded past validation
      expect(deps.arcDatabase.getArc).toHaveBeenCalled();
    } else {
      // DB was NOT called → routing rejected at validation
      expect(deps.arcDatabase.getArc).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// Property 12: Stateless validation gate — no I/O on failure
// Validates: Requirements 14.1, 14.2, 14.4, 14.5
// ---------------------------------------------------------------------------

describe("handleCalendarResponse — stateless validation gate", () => {
  it.each([
    {
      checksumValid: true,
      hmacValid: true,
      dbCalled: true,
      signalCreated: true,
      responseSent: true,
      reason: "both valid → full processing (DB + signal + RSVP sent)",
    },
    {
      checksumValid: true,
      hmacValid: false,
      dbCalled: false,
      signalCreated: false,
      responseSent: false,
      reason: "checksum valid but HMAC invalid → no I/O",
    },
    {
      checksumValid: false,
      hmacValid: false,
      dbCalled: false,
      signalCreated: false,
      responseSent: false,
      reason: "checksum invalid → no I/O (HMAC not even checked)",
    },
  ])("$reason", async ({ checksumValid, hmacValid, dbCalled, signalCreated, responseSent }) => {
    const deps = makeDeps();
    const logger = makeLogger();

    // Build recipient address based on checksum validity
    const arcId = checksumValid ? VALID_ARC_ID : "arc-badchk";
    const accId = checksumValid ? VALID_ACC_ID : VALID_ACC_ID; // accountId always valid for this table
    const recipient = `${arcId}@${accId}.${SERVICE_DOMAIN}`;

    // Build .ics with valid or tampered HMAC
    let proxyUid: string;
    if (hmacValid) {
      proxyUid = await buildProxyUid({
        accountId: accId,
        arcId,
        originalVeventUid: "uid-original-123",
        serviceDomain: SERVICE_DOMAIN,
      });
    } else {
      // Tampered HMAC — manually construct UID with wrong HMAC suffix
      const payload = `${accId}.${arcId}.uid-original-123`;
      proxyUid = `${payload}.AAAAAAAAAAAAAAAA@${SERVICE_DOMAIN}`;
    }

    const icsBytes = buildReplyIcsBytes(proxyUid);
    const message = makeMessage([recipient]);

    await handleCalendarResponse(message, deps, logger, icsBytes);

    if (dbCalled) {
      expect(deps.arcDatabase.getArc).toHaveBeenCalled();
    } else {
      expect(deps.arcDatabase.getArc).not.toHaveBeenCalled();
    }

    if (signalCreated) {
      expect(deps.signalStore.saveSignal).toHaveBeenCalled();
    } else {
      expect(deps.signalStore.saveSignal).not.toHaveBeenCalled();
    }

    if (responseSent) {
      expect(deps.rsvpComposer).toHaveBeenCalled();
    } else {
      expect(deps.rsvpComposer).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// Happy path: valid REPLY → signal created + masked REPLY sent
// Validates: Requirements 13.1, 14.1, 14.4
// ---------------------------------------------------------------------------

describe("handleCalendarResponse — happy path", () => {
  it("valid REPLY creates calendar_response signal and sends masked REPLY to organizer", async () => {
    const deps = makeDeps();
    const logger = makeLogger();

    const proxyUid = await buildProxyUid({
      accountId: VALID_ACC_ID,
      arcId: VALID_ARC_ID,
      originalVeventUid: "uid-original-123",
      serviceDomain: SERVICE_DOMAIN,
    });

    const recipient = `${VALID_ARC_ID}@${VALID_ACC_ID}.${SERVICE_DOMAIN}`;
    const icsBytes = buildReplyIcsBytes(proxyUid, "ACCEPTED");
    const message = makeMessage([recipient]);

    const result = await handleCalendarResponse(message, deps, logger, icsBytes);

    // Should succeed
    expect(result.isOk()).toBe(true);

    // RSVP_Composer was called with correct decision and original UID
    expect(deps.rsvpComposer).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "accepted",
        aliasAddress: recipient,
        organizerAddress: "alice@example.com",
        fromAddress: recipient,
      }),
      expect.objectContaining({ emailService: deps.emailService }),
    );

    // Signal was saved with calendar_response data
    const savedSignal = (deps.signalStore.saveSignal as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(savedSignal.type).toBe("calendar_response");
    expect(savedSignal.source).toBe("user");
    expect(savedSignal.arcId).toBe(VALID_ARC_ID);
    expect(savedSignal.accountId).toBe(VALID_ACC_ID);
    expect(savedSignal.data.decision).toBe("accepted");
    expect(savedSignal.data.veventUid).toBe("uid-original-123");

    // Success was logged
    expect(logger.track).toHaveBeenCalledWith(
      expect.stringContaining("Calendar REPLY processed successfully"),
      expect.objectContaining({ code: "processor.calendar_response.success" }),
    );
  });
});
