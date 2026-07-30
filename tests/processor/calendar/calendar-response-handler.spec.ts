import { describe, it, expect, vi } from "vitest";
import { handleCalendarResponse } from "../../../src/processor/calendar/calendar-response-handler.js";
import type { CalendarResponseHandlerDeps } from "../../../src/processor/calendar/calendar-response-handler.js";
import type { InboundSignalMessage } from "../../../src/processor/processor.js";
import type { Logger } from "../../../src/logger.js";
import { ok } from "../../../src/errors.js";
import { buildProxyUid as buildProxyUidRaw } from "../../../src/processor/calendar/proxy-uid.js";
import { generateId, generateAccountId } from "../../../src/utils/id.js";
import { makeHmacGeneratorFake } from "../../helpers/hmac-generator-fake.js";

// ---------------------------------------------------------------------------
// Injected deterministic HMAC generator — no real KMS. `buildProxyUid` is
// wrapped so the existing call sites (which omit hmac) inject the same
// generator the handler-under-test receives via deps.
// ---------------------------------------------------------------------------

const hmac = makeHmacGeneratorFake();

const buildProxyUid = (opts: Omit<Parameters<typeof buildProxyUidRaw>[0], "hmac">) =>
  buildProxyUidRaw({ ...opts, hmac });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVICE_DOMAIN = "platform.email.rhosys.cloud";

// Valid IDs generated with the real algorithm from utils/id.ts
const VALID_ARC_ID = generateId("thr-");
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
    s3Key: "emails/test.eml",
    compositeMailMessageId: "ses-ses-msg-001",
    idempotencyKey: "test-idempotency-key",
    timestamp: "2025-03-15T10:00:00Z",
    destination,
    dkimVerdict: "PASS",
    dmarcVerdict: "PASS",
  };
}

function makeDeps(overrides: Partial<CalendarResponseHandlerDeps> = {}): CalendarResponseHandlerDeps {
  return {
    serviceDomain: SERVICE_DOMAIN,
    threadDatabase: {
      getThread: vi.fn().mockResolvedValue(ok({
        id: VALID_ARC_ID,
        accountId: VALID_ACC_ID,
        status: "active",
        labels: [],
        summary: "Test arc",
        workflow: "conversation",
        lastSignalAt: "2025-03-15T10:00:00Z",
        createdAt: "2025-03-15T09:00:00Z",
      })),
    } as unknown as CalendarResponseHandlerDeps["threadDatabase"],
    rsvpComposer: vi.fn().mockResolvedValue(ok({ messageId: "ses-reply-001" })),
    signalStore: {
      saveSignal: vi.fn().mockResolvedValue(ok(undefined)),
    },
    emailService: {
      send: vi.fn().mockResolvedValue(ok({ messageId: "ses-msg-002" })),
      sendRaw: vi.fn(),
    } as unknown as CalendarResponseHandlerDeps["emailService"],
    hmac,
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
      threadId: VALID_ARC_ID,
      originalVeventUid: "uid-original-123",
      serviceDomain: SERVICE_DOMAIN,
    });
    const icsBytes = buildReplyIcsBytes(proxyUid);
    const message = makeMessage([recipient]);

    await handleCalendarResponse(message, deps, logger, icsBytes);

    if (routed) {
      // DB was called → routing succeeded past validation
      expect(deps.threadDatabase.getThread).toHaveBeenCalled();
    } else {
      // DB was NOT called → routing rejected at validation
      expect(deps.threadDatabase.getThread).not.toHaveBeenCalled();
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
        threadId: arcId,
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
      expect(deps.threadDatabase.getThread).toHaveBeenCalled();
    } else {
      expect(deps.threadDatabase.getThread).not.toHaveBeenCalled();
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
      threadId: VALID_ARC_ID,
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
    expect(savedSignal.threadId).toBe(VALID_ARC_ID);
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
