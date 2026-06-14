import { describe, it, expect, vi, beforeEach } from "vitest";
import { handlePostApprovalCalendar } from "../../../src/processor/calendar/post-approval-handler.js";
import type { PostApprovalCalendarHandlerDeps } from "../../../src/processor/calendar/post-approval-handler.js";
import type { Signal, Arc, Attachment } from "../../../src/types/index.js";
import type { ArcDatabase } from "../../../src/database/arc-database.js";
import type { AccountDatabase } from "../../../src/database/account-database.js";
import type { CalendarForwarderDeps } from "../../../src/processor/calendar/calendar-forwarder.js";
import type { S3Client } from "@aws-sdk/client-s3";
import { ok } from "../../../src/errors.js";
import { createMockLogger } from "../../helpers/mock-logger.js";

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
    arcId: "arc-001",
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
      spamScore: 0.01,
      summary: "Meeting invite",
      s3Key: "emails/msg-001",
      ...dataOverrides,
    },
  } as Signal;
}

function makeArc(overrides: Partial<Arc> = {}): Arc {
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
    senderAddress: "sender@example.com",
    recipientAddress: "user@example.com",
    subject: "Test email",
    ...overrides,
  };
}

function makeS3Client(icsContent: string = VALID_ICS): S3Client {
  return {
    send: vi.fn().mockResolvedValue({
      Body: { transformToByteArray: () => Promise.resolve(new TextEncoder().encode(icsContent)) },
    }),
  } as unknown as S3Client;
}

function makeArcDb() {
  return {
    saveSignal: vi.fn().mockResolvedValue(ok(undefined)),
    updateArc: vi.fn().mockResolvedValue(ok(makeArc())),
  } as unknown as ArcDatabase;
}

function makeAccountDb(calendarForwardingAddress = "user@gmail.com") {
  return {
    getAccount: vi.fn().mockResolvedValue(ok({ defaultCalendarInviteForwardingAddress: calendarForwardingAddress })),
  } as unknown as AccountDatabase;
}

function makeCalendarForwarderDeps(): CalendarForwarderDeps {
  return {
    emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-fwd-001" })) } as never,
    serviceDomain: "platform.email.rhosys.cloud",
  };
}

function makeDeps(overrides: Partial<PostApprovalCalendarHandlerDeps> = {}): PostApprovalCalendarHandlerDeps {
  return {
    arcDb: makeArcDb(),
    accountDb: makeAccountDb(),
    s3Client: makeS3Client(),
    contentBucket: "test-bucket",
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
    const arc = makeArc();
    const arcDb = makeArcDb();
    const accountDb = makeAccountDb();
    const calendarForwarderDeps = makeCalendarForwarderDeps();
    const deps = makeDeps({ arcDb, accountDb, calendarForwarderDeps });

    await handlePostApprovalCalendar(signal, arc, deps);

    // Calendar signal was saved
    expect(arcDb.saveSignal).toHaveBeenCalledOnce();
    const savedSignal = (arcDb.saveSignal as ReturnType<typeof vi.fn>).mock.calls[0]![0];
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
    const arc = makeArc();
    const arcDb = makeArcDb();
    const deps = makeDeps({ arcDb });

    await handlePostApprovalCalendar(signal, arc, deps);

    expect(arcDb.saveSignal).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — Requirement 16.2: Same construction rules as normal forwarding
// ---------------------------------------------------------------------------

describe("handlePostApprovalCalendar — uses same construction rules as normal forwarding", () => {
  it("forwards to calendarForwardingAddress from account config", async () => {
    const signal = makeSignal();
    const arc = makeArc();
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
    const arc = makeArc({ labels: [] });
    const arcDb = makeArcDb();
    const deps = makeDeps({ arcDb });

    await handlePostApprovalCalendar(signal, arc, deps);

    expect(arcDb.updateArc).toHaveBeenCalledOnce();
    expect(arc.labels).toContain("system:calendar");
  });

  it("creates calendar_invite_invalid signal when .ics is malformed", async () => {
    const signal = makeSignal();
    const arc = makeArc();
    const arcDb = makeArcDb();
    const s3Client = makeS3Client("NOT A VALID ICS FILE");
    const deps = makeDeps({ arcDb, s3Client });

    await handlePostApprovalCalendar(signal, arc, deps);

    expect(arcDb.saveSignal).toHaveBeenCalledOnce();
    const savedSignal = (arcDb.saveSignal as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(savedSignal.type).toBe("calendar_invite_invalid");
    expect(savedSignal.data.linkedSignalId).toBe("sgn-email-001");
    expect(savedSignal.data.reason).toBeDefined();
  });

  it("is a no-op when calendarForwardingAddress is not configured", async () => {
    const signal = makeSignal();
    const arc = makeArc();
    const accountDb = makeAccountDb("");
    const calendarForwarderDeps = makeCalendarForwarderDeps();
    const deps = makeDeps({ accountDb, calendarForwarderDeps });

    await handlePostApprovalCalendar(signal, arc, deps);

    // Calendar signal is still created (forwarding is a separate concern)
    const arcDb = deps.arcDb as unknown as { saveSignal: ReturnType<typeof vi.fn> };
    expect(arcDb.saveSignal).toHaveBeenCalledOnce();

    // But email is NOT sent (forwardCalendarInvite no-ops on empty address)
    const emailSend = calendarForwarderDeps.emailService.send as ReturnType<typeof vi.fn>;
    expect(emailSend).not.toHaveBeenCalled();
  });
});
