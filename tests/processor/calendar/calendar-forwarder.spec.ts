import { describe, it, expect, vi } from "vitest";
import { CalendarForwarder } from "../../../src/processor/calendar/calendar-forwarder.js";
import type { ForwardInviteOpts } from "../../../src/processor/calendar/calendar-forwarder.js";
import type { EmailService } from "../../../src/email/email-service.js";
import type { CalendarEventData } from "../../../src/types/calendar.js";
import type { Signal } from "../../../src/types/index.js";
import type { Logger } from "../../../src/logger.js";
import { ok, err } from "../../../src/errors.js";
import { createMockLogger } from "../../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Injected deterministic HMAC generator — no real KMS.
// ---------------------------------------------------------------------------

import { makeHmacGeneratorFake } from "../../helpers/hmac-generator-fake.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const PLATFORM_TENANT = "platform-tenant";

const PLATFORM_FROM = "invites@platform.email.rhosys.cloud";

function makeEmailService(overrides: Partial<EmailService> = {}): EmailService {
  return {
    send: vi.fn(),
    sendRaw: vi.fn().mockResolvedValue(ok({ messageId: "ses-msg-001" })),
    platformTenant: PLATFORM_TENANT,
    platformFrom: PLATFORM_FROM,
    ...overrides,
  } as unknown as EmailService;
}

/** Decode a raw MIME message's body and headers for assertions. */
function parseRawSend(emailService: EmailService): { headerBlock: string; icsContent: string } {
  const rawData: Uint8Array = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0].rawData;
  const message = Buffer.from(rawData).toString("utf8");
  const [headerBlock, ...rest] = message.split("\r\n\r\n");
  const icsContent = Buffer.from(rest.join("\r\n\r\n").trim(), "base64").toString("utf8");
  return { headerBlock: headerBlock!, icsContent };
}

function makeCalendarSignal(method: string): Signal<CalendarEventData> {
  return {
    id: "sgn-cal-001",
    signalLookupId: "cal-alice@example.com-uid-123",
    accountId: "acc-abc123",
    threadId: "arc-def456",
    source: "signal",
    type: "calendar_event",
    status: "active",
    labels: [],
    createdAt: "2025-03-15T09:00:00Z",
    data: {
      title: "Team Standup",
      startTime: "2025-03-15T10:00:00Z",
      endTime: "2025-03-15T11:00:00Z",
      organizer: "alice@example.com",
      organizerCn: "Alice Smith",
      attendees: [],
      veventUid: "uid-123",
      originalVeventUid: "uid-123",
      method,
      sequence: 1,
      linkedSignalId: "sgn-email-001",
    },
  } as Signal<CalendarEventData>;
}

function makeForwarder(emailService?: EmailService): CalendarForwarder {
  return new CalendarForwarder({
    emailService: emailService ?? makeEmailService(),
    serviceDomain: "platform.email.rhosys.cloud",
    hmac: makeHmacGeneratorFake(),
  });
}

function makeOpts(overrides: Partial<ForwardInviteOpts> = {}): ForwardInviteOpts {
  return {
    calendarSignal: makeCalendarSignal("REQUEST"),
    calendarForwardingAddress: "user@gmail.com",
    accountId: "acc-abc123",
    threadId: "arc-def456",
    aliasAddress: "alias@domain.com",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Property 8: All calendar methods are forwarded without filtering
// Validates: Requirements 10.7
// ---------------------------------------------------------------------------

describe("CalendarForwarder.forwardInvite — all METHOD values forwarded", () => {
  it.each([
    { method: "REQUEST", reason: "standard invite forwarded" },
    { method: "CANCEL", reason: "cancellation forwarded" },
    { method: "COUNTER", reason: "counter-proposal forwarded" },
    { method: "REPLY", reason: "reply forwarded" },
    { method: "ADD", reason: "add forwarded" },
  ])("$reason (METHOD=$method)", async ({ method }) => {
    const emailService = makeEmailService();
    const forwarder = makeForwarder(emailService);
    const opts = makeOpts({ calendarSignal: makeCalendarSignal(method) });
    const logger = makeLogger();

    const result = await forwarder.forwardInvite(opts, logger);

    expect(result.isOk()).toBe(true);
    expect(emailService.sendRaw).toHaveBeenCalledTimes(1);
    // The invite goes out as a text/calendar part carrying the METHOD — never text/plain.
    const { headerBlock } = parseRawSend(emailService);
    expect(headerBlock).toContain(`Content-Type: text/calendar; method=${method}; charset=UTF-8`);
  });
});

// ---------------------------------------------------------------------------
// Verify X-Numaeel-Calendar-Signal-Id header inclusion
// Validates: Requirements 10.9
// ---------------------------------------------------------------------------

describe("CalendarForwarder.forwardInvite — X-Numaeel-Calendar-Signal-Id header", () => {
  it("includes the calendar signal ID as a header on the forwarded email", async () => {
    const emailService = makeEmailService();
    const forwarder = makeForwarder(emailService);
    const signal = makeCalendarSignal("REQUEST");
    const opts = makeOpts({ calendarSignal: signal });
    const logger = makeLogger();

    await forwarder.forwardInvite(opts, logger);

    // The signal ID rides as a MIME header inside the raw message so it survives to the recipient,
    // and is mirrored as an SES tag for feedback correlation.
    const { headerBlock } = parseRawSend(emailService);
    expect(headerBlock).toContain("X-Numaeel-Calendar-Signal-Id: sgn-cal-001");
    const sendCall = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const signalIdTag = sendCall.tags.find(
      (t: { Name: string; Value: string }) => t.Name === "X-Numaeel-Calendar-Signal-Id",
    );
    expect(signalIdTag).toBeDefined();
    expect(signalIdTag.Value).toBe("sgn-cal-001");
  });
});

// ---------------------------------------------------------------------------
// Verify no-op when calendarForwardingAddress missing
// Validates: Requirements 10.7 (no-op path)
// ---------------------------------------------------------------------------

describe("CalendarForwarder.forwardInvite — no-op when calendarForwardingAddress missing", () => {
  it("does not send email and returns ok when calendarForwardingAddress is empty string", async () => {
    const emailService = makeEmailService();
    const forwarder = makeForwarder(emailService);
    const opts = makeOpts({ calendarForwardingAddress: "" });
    const logger = makeLogger();

    const result = await forwarder.forwardInvite(opts, logger);

    expect(result.isOk()).toBe(true);
    expect(emailService.sendRaw).not.toHaveBeenCalled();
    expect(logger.track).toHaveBeenCalledWith(
      expect.stringContaining("no calendarForwardingAddress"),
      expect.objectContaining({ code: "processor.calendar_forwarder.no_forwarding_address" }),
    );
  });
});


// ---------------------------------------------------------------------------
// Sender identity: forwarded invites are sent under the PLATFORM tenant
// ---------------------------------------------------------------------------

describe("CalendarForwarder.forwardInvite — sends under the platform tenant", () => {
  it("sends under the platform tenant, not the customer account, so every forwarded invite visibly originates from the service — recipients know who is sending (the service, on the customer's behalf) rather than having to filter by sender on the receiving side, and concentrating all sends on the platform domain builds our sending-domain reputation instead of fragmenting it across unverified customer domains", async () => {
    const emailService = makeEmailService();
    const forwarder = makeForwarder(emailService);
    // Customer account on the opts — the send must NOT use this as the SES tenant.
    const opts = makeOpts({ accountId: "acc-abc123" });
    const logger = makeLogger();

    const result = await forwarder.forwardInvite(opts, logger);

    expect(result.isOk()).toBe(true);
    const sendCall = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sendCall.accountId).toBe(PLATFORM_TENANT);
    expect(sendCall.accountId).not.toBe("acc-abc123");
    // The From is the platform address — set as fromSender and baked into the MIME From header.
    expect(sendCall.fromSender).toBe(PLATFORM_FROM);
    const { headerBlock } = parseRawSend(emailService);
    expect(headerBlock).toContain(`From: ${PLATFORM_FROM}`);
  });
});

// ---------------------------------------------------------------------------
// Permanent SES error handling
// ---------------------------------------------------------------------------

describe("CalendarForwarder.forwardInvite — permanent SES error", () => {
  it("returns ok and logs WARN on permanent SES error — no retry", async () => {
    const emailService = makeEmailService();
    vi.mocked(emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(err({ kind: "permanent_ses_error", errorName: "MessageRejected", httpStatus: 400, message: "Email address is not verified", cause: new Error("test") }));
    const forwarder = makeForwarder(emailService);
    const opts = makeOpts();
    const logger = createMockLogger();

    const result = await forwarder.forwardInvite(opts, logger);

    expect(result.isOk()).toBe(true);
    expect(logger.calls.some(c => c.method === "warn" && c.context?.code === "calendar_forwarder.send_permanent")).toBe(true);
  });
});
