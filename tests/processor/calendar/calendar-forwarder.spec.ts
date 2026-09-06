import type { IForwardingService } from "../../../src/forwarding/forwarding-service.js";
import { describe, it, expect, vi } from "vitest";
import { forwardCalendarInvite } from "../../../src/processor/calendar/calendar-forwarder.js";
import type { CalendarForwarderDeps, ForwardCalendarInviteOpts } from "../../../src/processor/calendar/calendar-forwarder.js";
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

function makeEmailService(overrides: Partial<EmailService> = {}): EmailService {
  return {
    send: vi.fn().mockResolvedValue(ok({ messageId: "ses-msg-001" })),
    sendRaw: vi.fn(),
    platformTenant: PLATFORM_TENANT,
    ...overrides,
  } as unknown as EmailService;
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

function makeDeps(emailService?: EmailService): CalendarForwarderDeps {
  return {
    emailService: emailService ?? makeEmailService(),
    serviceDomain: "platform.email.rhosys.cloud",
    hmac: makeHmacGeneratorFake(),
  };
}

function makeOpts(overrides: Partial<ForwardCalendarInviteOpts> = {}): ForwardCalendarInviteOpts {
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

describe("forwardCalendarInvite — all METHOD values forwarded", () => {
  it.each([
    { method: "REQUEST", reason: "standard invite forwarded" },
    { method: "CANCEL", reason: "cancellation forwarded" },
    { method: "COUNTER", reason: "counter-proposal forwarded" },
    { method: "REPLY", reason: "reply forwarded" },
    { method: "ADD", reason: "add forwarded" },
  ])("$reason (METHOD=$method)", async ({ method }) => {
    const emailService = makeEmailService();
    const deps = makeDeps(emailService);
    const opts = makeOpts({ calendarSignal: makeCalendarSignal(method) });
    const logger = makeLogger();

    const result = await forwardCalendarInvite(opts, deps, logger);

    expect(result.isOk()).toBe(true);
    expect(emailService.send).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Verify X-Numaeel-Calendar-Signal-Id header inclusion
// Validates: Requirements 10.9
// ---------------------------------------------------------------------------

describe("forwardCalendarInvite — X-Numaeel-Calendar-Signal-Id header", () => {
  it("includes the calendar signal ID as a header on the forwarded email", async () => {
    const emailService = makeEmailService();
    const deps = makeDeps(emailService);
    const signal = makeCalendarSignal("REQUEST");
    const opts = makeOpts({ calendarSignal: signal });
    const logger = makeLogger();

    await forwardCalendarInvite(opts, deps, logger);

    const sendCall = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const signalIdHeader = sendCall.headers.find(
      (h: { Name: string; Value: string }) => h.Name === "X-Numaeel-Calendar-Signal-Id",
    );
    expect(signalIdHeader).toBeDefined();
    expect(signalIdHeader.Value).toBe("sgn-cal-001");
  });
});

// ---------------------------------------------------------------------------
// Verify no-op when calendarForwardingAddress missing
// Validates: Requirements 10.7 (no-op path)
// ---------------------------------------------------------------------------

describe("forwardCalendarInvite — no-op when calendarForwardingAddress missing", () => {
  it("does not send email and returns ok when calendarForwardingAddress is empty string", async () => {
    const emailService = makeEmailService();
    const deps = makeDeps(emailService);
    const opts = makeOpts({ calendarForwardingAddress: "" });
    const logger = makeLogger();

    const result = await forwardCalendarInvite(opts, deps, logger);

    expect(result.isOk()).toBe(true);
    expect(emailService.send).not.toHaveBeenCalled();
    expect(logger.track).toHaveBeenCalledWith(
      expect.stringContaining("no calendarForwardingAddress"),
      expect.objectContaining({ code: "processor.calendar_forwarder.no_forwarding_address" }),
    );
  });
});


// ---------------------------------------------------------------------------
// Sender identity: forwarded invites are sent under the PLATFORM tenant
// ---------------------------------------------------------------------------

describe("forwardCalendarInvite — sends under the platform tenant", () => {
  it("sends under the platform tenant, not the customer account, so every forwarded invite visibly originates from the service — recipients know who is sending (the service, on the customer's behalf) rather than having to filter by sender on the receiving side, and concentrating all sends on the platform domain builds our sending-domain reputation instead of fragmenting it across unverified customer domains", async () => {
    const emailService = makeEmailService();
    const deps = makeDeps(emailService);
    // Customer account on the opts — the send must NOT use this as the SES tenant.
    const opts = makeOpts({ accountId: "acc-abc123" });
    const logger = makeLogger();

    const result = await forwardCalendarInvite(opts, deps, logger);

    expect(result.isOk()).toBe(true);
    const sendCall = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sendCall.accountId).toBe(PLATFORM_TENANT);
    expect(sendCall.accountId).not.toBe("acc-abc123");
    // No fromSender override — the platform default `from` is used, keeping the
    // From aligned with the platform tenant.
    expect(sendCall.fromSender).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Permanent SES error handling
// ---------------------------------------------------------------------------

describe("forwardCalendarInvite — permanent SES error", () => {
  it("returns ok and logs WARN on permanent SES error — no retry", async () => {
    const emailService = makeEmailService();
    vi.mocked(emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(err({ kind: "permanent_ses_error", errorName: "MessageRejected", httpStatus: 400, message: "Email address is not verified", cause: new Error("test") }));
    const deps = makeDeps(emailService);
    const opts = makeOpts();
    const logger = createMockLogger();

    const result = await forwardCalendarInvite(opts, deps, logger);

    expect(result.isOk()).toBe(true);
    expect(logger.calls.some(c => c.method === "warn" && c.context?.code === "calendar_forwarder.send_permanent")).toBe(true);
  });
});
