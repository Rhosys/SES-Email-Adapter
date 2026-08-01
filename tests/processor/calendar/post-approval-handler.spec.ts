import type { IForwardingService } from "../../../src/forwarding/forwarding-service.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handlePostApprovalCalendar } from "../../../src/processor/calendar/post-approval-handler.js";
import type { PostApprovalCalendarHandlerDeps } from "../../../src/processor/calendar/post-approval-handler.js";
import type { Signal, Thread, Attachment } from "../../../src/types/index.js";
import type { ThreadDatabase } from "../../../src/database/thread-database.js";
import type { AccountDatabase } from "../../../src/database/account-database.js";
import type { CalendarForwarderDeps } from "../../../src/processor/calendar/calendar-forwarder.js";
import type { ContentStore } from "../../../src/content-store.js";
import { ok } from "../../../src/errors.js";
import { createMockLogger } from "../../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Injected deterministic HMAC generator — no real KMS.
// ---------------------------------------------------------------------------

import { makeHmacGeneratorFake } from "../../helpers/hmac-generator-fake.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Test//Test//EN",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:uid-event-001",
  "DTSTART:20250315T100000Z",
  "DTEND:20250315T110000Z",
  "SUMMARY:Team Standup",
  "ORGANIZER;CN=Alice Smith:mailto:alice@example.com",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:user@example.com",
  "SEQUENCE:1",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

function makeSignal(overrides: Partial<Signal> & { data?: Partial<Signal["data"]> } = {}): Signal {
  const { data: dataOverrides, ...baseOverrides } = overrides;
  return {
    id: "sgn-email-001",
    signalLookupId: "ses-msg-001",
    threadId: "arc-001",
    accountId: "acct-test-001",
    source: "email",
    type: "email",
    status: "active",
    createdAt: "2025-03-15T09:00:00Z",
    ...baseOverrides,
    data: {
      receivedAt: "2025-03-15T09:00:00Z",
      from: { address: "alice@example.com", name: "Alice" },
      to: [{ address: "user@alias.com" }],
      cc: [],
      subject: "Meeting invite",
      attachments: [
        { filename: "invite.ics", mimeType: "text/calendar", sizeBytes: 500, s3Key: "emails/msg-001/invite.ics" },
      ] as Attachment[],
      headers: {},
      recipientAddress: "user@alias.com",
      workflow: "conversation",
      workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
      tags: [],
      summary: "Meeting invite",
      s3Key: "emails/msg-001",
      ...dataOverrides,
    },
  } as Signal;
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "arc-001",
    accountId: "acct-test-001",
    workflow: "conversation",
    labels: [],
    status: "active",
    summary: "Test arc",
    lastSignalAt: "2025-03-15T09:00:00Z",
    createdAt: "2025-03-15T09:00:00Z",
    updatedAt: "2025-03-15T09:00:00Z",
    sender: { address: "sender@example.com" },
    recipientAddress: "user@example.com",
    subject: "Test email",
    ...overrides,
  };
}

function makeContentStore(icsContent: string = VALID_ICS): ContentStore {
  return {
    getSignedUrl: vi.fn().mockResolvedValue("https://signed-url"),
    getObject: vi.fn().mockResolvedValue(new TextEncoder().encode(icsContent)),
    putObject: vi.fn().mockResolvedValue(undefined),
    getPresignedPost: vi.fn().mockResolvedValue({ url: "https://post-url", fields: {} }),
    saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined),
  } as unknown as ContentStore;
}

function makeArcDb() {
  return {
    saveSignal: vi.fn().mockResolvedValue(ok(undefined)),
    updateThread: vi.fn().mockResolvedValue(ok(makeThread())),
  } as unknown as ThreadDatabase;
}

function makeAccountDb(calendarForwardingAddress = "user@gmail.com") {
  return {
    getAccount: vi.fn().mockResolvedValue(ok({ defaultCalendarInviteForwardingTargetId: calendarForwardingAddress })),
  } as unknown as AccountDatabase;
}

function makeCalendarForwarderDeps(): CalendarForwarderDeps {
  return {
    emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-fwd-001" })) } as never,
    serviceDomain: "platform.email.rhosys.cloud",
    hmac: makeHmacGeneratorFake(),
  };
}

function makeDeps(overrides: Partial<PostApprovalCalendarHandlerDeps> = {}): PostApprovalCalendarHandlerDeps {
  return {
    threadDb: makeArcDb(),
    accountDb: makeAccountDb(),
    contentStore: makeContentStore(),
    calendarForwarderDeps: makeCalendarForwarderDeps(),
    logger: createMockLogger(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — Requirement 16.1: Approved quarantined signal triggers forwarding
// ---------------------------------------------------------------------------

describe("handlePostApprovalCalendar — triggers forwarding on approval", () => {
  it("creates calendar signal and forwards when approved signal has .ics attachment", async () => {
    const signal = makeSignal();
    const arc = makeThread();
    const threadDb = makeArcDb();
    const accountDb = makeAccountDb();
    const calendarForwarderDeps = makeCalendarForwarderDeps();
    const deps = makeDeps({ threadDb, accountDb, calendarForwarderDeps });

    await handlePostApprovalCalendar(signal, arc, deps);

    // Calendar signal was saved
    expect(threadDb.saveSignal).toHaveBeenCalledOnce();
    const savedSignal = (threadDb.saveSignal as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(savedSignal.source).toBe("signal");
    expect(savedSignal.type).toBe("calendar_event");
    expect(savedSignal.data.linkedSignalId).toBe("sgn-email-001");
    expect(savedSignal.data.organizer).toBe("alice@example.com");
    expect(savedSignal.data.veventUid).toBe("uid-event-001");

    // Calendar invite was forwarded via email service
    const emailSend = calendarForwarderDeps.emailService.send as ReturnType<typeof vi.fn>;
    expect(emailSend).toHaveBeenCalledOnce();
  });

  it("does nothing when signal has no calendar attachment", async () => {
    const signal = makeSignal();
    (signal.data as { attachments: Attachment[] }).attachments = [];
    const arc = makeThread();
    const threadDb = makeArcDb();
    const deps = makeDeps({ threadDb });

    await handlePostApprovalCalendar(signal, arc, deps);

    expect(threadDb.saveSignal).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — Requirement 16.2: Same construction rules as normal forwarding
// ---------------------------------------------------------------------------

describe("handlePostApprovalCalendar — uses same construction rules as normal forwarding", () => {
  it("forwards to calendarForwardingAddress from account config", async () => {
    const signal = makeSignal();
    const arc = makeThread();
    const calendarForwarderDeps = makeCalendarForwarderDeps();
    const accountDb = makeAccountDb("real-calendar@gmail.com");
    const deps = makeDeps({ accountDb, calendarForwarderDeps });

    await handlePostApprovalCalendar(signal, arc, deps);

    const emailSend = calendarForwarderDeps.emailService.send as ReturnType<typeof vi.fn>;
    expect(emailSend).toHaveBeenCalledOnce();
    const sendArgs = emailSend.mock.calls[0]![0];
    expect(sendArgs.to).toBe("real-calendar@gmail.com");
  });

  it("applies system:calendar label to the arc", async () => {
    const signal = makeSignal();
    const arc = makeThread({ labels: [] });
    const threadDb = makeArcDb();
    const deps = makeDeps({ threadDb });

    await handlePostApprovalCalendar(signal, arc, deps);

    expect(threadDb.updateThread).toHaveBeenCalledOnce();
    expect(arc.labels).toContain("system:calendar");
  });

  it("creates calendar_invite_invalid signal when .ics is malformed", async () => {
    const signal = makeSignal();
    const arc = makeThread();
    const threadDb = makeArcDb();
    const contentStore = makeContentStore("NOT A VALID ICS FILE");
    const deps = makeDeps({ threadDb, contentStore });

    await handlePostApprovalCalendar(signal, arc, deps);

    expect(threadDb.saveSignal).toHaveBeenCalledOnce();
    const savedSignal = (threadDb.saveSignal as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(savedSignal.type).toBe("calendar_invite_invalid");
    expect(savedSignal.data.linkedSignalId).toBe("sgn-email-001");
    expect(savedSignal.data.reason).toBeDefined();
  });

  it("is a no-op when calendarForwardingAddress is not configured", async () => {
    const signal = makeSignal();
    const arc = makeThread();
    const accountDb = makeAccountDb("");
    const calendarForwarderDeps = makeCalendarForwarderDeps();
    const deps = makeDeps({ accountDb, calendarForwarderDeps });

    await handlePostApprovalCalendar(signal, arc, deps);

    // Calendar signal is still created (forwarding is a separate concern)
    const threadDb = deps.threadDb as unknown as { saveSignal: ReturnType<typeof vi.fn> };
    expect(threadDb.saveSignal).toHaveBeenCalledOnce();

    // But email is NOT sent (forwardCalendarInvite no-ops on empty address)
    const emailSend = calendarForwarderDeps.emailService.send as ReturnType<typeof vi.fn>;
    expect(emailSend).not.toHaveBeenCalled();
  });
});
