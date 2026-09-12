import { describe, it, expect, vi } from "vitest";
import { IncomingCalendarRsvpProcessor } from "../../src/processor/incoming-calendar-rsvp-processor.js";
import type { RsvpThreadStore } from "../../src/processor/incoming-calendar-rsvp-processor.js";
import { CalendarForwarder } from "../../src/processor/calendar/calendar-forwarder.js";
import type { InboundSignalMessage } from "../../src/processor/incoming-email-processor.js";
import type { EmailContentStore } from "../../src/content-store.js";
import type { EmailService } from "../../src/email/email-service.js";
import { buildProxyUid as buildProxyUidRaw } from "../../src/processor/calendar/proxy-uid.js";
import { generateId, generateAccountId } from "../../src/utils/id.js";
import { makeHmacGeneratorFake } from "../helpers/hmac-generator-fake.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { ok } from "../../src/errors.js";
import type { Signal, CalendarResponseData } from "../../src/types/index.js";

// ---------------------------------------------------------------------------
// IncomingCalendarRsvpProcessor — the lifecycle half of the inbound calendar
// loop. Owns S3 fetch, MIME/.ics extraction, thread lookup, reply relay, and the
// calendar_response signal write. Delegates stateless validation to a real
// CalendarForwarder (fed a deterministic HMAC fake). Every non-success path must
// resolve to ok(undefined) with a WARN and write no signal.
// ---------------------------------------------------------------------------

const hmac = makeHmacGeneratorFake();
const SERVICE_DOMAIN = "platform.email.rhosys.cloud";
const VALID_ARC_ID = generateId("thr-");
const VALID_ACC_ID = generateAccountId();
const ORIGINAL_UID = "uid-original-123";
const ORGANIZER = "alice@example.com";
const RECIPIENT = `${VALID_ARC_ID}@${VALID_ACC_ID}.${SERVICE_DOMAIN}`;
const S3_KEY = "emails/rsvp.eml";

const buildProxyUid = (opts: Omit<Parameters<typeof buildProxyUidRaw>[0], "hmac">) =>
  buildProxyUidRaw({ ...opts, hmac });

/** A real RSVP email: multipart/mixed with the REPLY .ics as an attachment part. */
function rawRsvpEmail(opts: { proxyUid: string; method?: string; partstat?: string }): Uint8Array {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//Test//EN",
    `METHOD:${opts.method ?? "REPLY"}`,
    "BEGIN:VEVENT",
    `UID:${opts.proxyUid}`,
    "SEQUENCE:1",
    "DTSTART:20250315T100000Z",
    "DTEND:20250315T110000Z",
    "SUMMARY:Team Standup",
    `ORGANIZER;CN=Alice Smith:mailto:${ORGANIZER}`,
    `ATTENDEE;PARTSTAT=${opts.partstat ?? "ACCEPTED"}:mailto:${RECIPIENT}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const boundary = "mixed_boundary_001";
  const message = [
    `From: ${ORGANIZER}`,
    `To: ${RECIPIENT}`,
    "Subject: Re: Team Standup",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Alice has accepted.",
    "",
    `--${boundary}`,
    'Content-Type: text/calendar; method=REPLY; charset=UTF-8; name="invite.ics"',
    "Content-Transfer-Encoding: 7bit",
    'Content-Disposition: attachment; filename="invite.ics"',
    "",
    ics,
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return new Uint8Array(Buffer.from(message, "utf8"));
}

/** A message with no calendar part at all. */
function rawPlainEmail(): Uint8Array {
  const message = [
    `From: ${ORGANIZER}`,
    `To: ${RECIPIENT}`,
    "Subject: Just a note",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "No calendar here.",
    "",
  ].join("\r\n");
  return new Uint8Array(Buffer.from(message, "utf8"));
}

function makeForwarder(emailService?: EmailService): CalendarForwarder {
  return new CalendarForwarder({
    emailService: emailService ?? ({ sendRaw: vi.fn().mockResolvedValue(ok({ messageId: "ses-reply-001" })) } as unknown as EmailService),
    serviceDomain: SERVICE_DOMAIN,
    hmac,
  });
}

function makeThreadStore(overrides: Partial<RsvpThreadStore> = {}): RsvpThreadStore {
  return {
    getThread: vi.fn().mockResolvedValue(ok({
      id: VALID_ARC_ID,
      accountId: VALID_ACC_ID,
      status: "active",
      labels: [],
      summary: "Team Standup",
      workflow: "conversation",
      lastSignalAt: "2025-03-15T10:00:00Z",
      createdAt: "2025-03-15T09:00:00Z",
    })),
    saveSignal: vi.fn().mockResolvedValue(ok(undefined)),
    ...overrides,
  };
}

function makeContentStore(raw: Uint8Array): EmailContentStore {
  return { getRawEmail: vi.fn().mockResolvedValue(raw) } as unknown as EmailContentStore;
}

function makeMessage(): InboundSignalMessage {
  return {
    s3Key: S3_KEY,
    compositeMailMessageId: "ses-rsvp-001",
    idempotencyKey: "idem-001",
    timestamp: "2025-03-15T11:00:00Z",
    destination: [RECIPIENT],
    dkimVerdict: "PASS",
    dmarcVerdict: "PASS",
  };
}

function makeProcessor(opts: { raw: Uint8Array; threadStore?: RsvpThreadStore; forwarder?: CalendarForwarder }) {
  const logger = createMockLogger();
  const threadStore = opts.threadStore ?? makeThreadStore();
  const forwarder = opts.forwarder ?? makeForwarder();
  const processor = new IncomingCalendarRsvpProcessor({
    emailContentStore: makeContentStore(opts.raw),
    calendarForwarder: forwarder,
    threadStore,
    logger,
  });
  return { processor, logger, threadStore, forwarder };
}

describe("IncomingCalendarRsvpProcessor — happy path", () => {
  it("relays the RSVP to the organizer and records a calendar_response signal", async () => {
    const proxyUid = await buildProxyUid({ accountId: VALID_ACC_ID, threadId: VALID_ARC_ID, originalVeventUid: ORIGINAL_UID, serviceDomain: SERVICE_DOMAIN });
    const emailService = { sendRaw: vi.fn().mockResolvedValue(ok({ messageId: "ses-reply-001" })) } as unknown as EmailService;
    const { processor, threadStore } = makeProcessor({ raw: rawRsvpEmail({ proxyUid, partstat: "ACCEPTED" }), forwarder: makeForwarder(emailService) });

    const result = await processor.process(makeMessage());

    expect(result.isOk()).toBe(true);

    // Reply was relayed to the organizer, from the alias (recipient) address.
    const sendCall = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sendCall.to).toEqual([ORGANIZER]);
    expect(sendCall.fromSender).toBe(RECIPIENT);

    // calendar_response signal recorded, keyed to the HMAC-authenticated identity.
    const saved = (threadStore.saveSignal as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Signal<CalendarResponseData>;
    expect(saved.type).toBe("calendar_response");
    expect(saved.source).toBe("user");
    expect(saved.threadId).toBe(VALID_ARC_ID);
    expect(saved.accountId).toBe(VALID_ACC_ID);
    expect(saved.data.decision).toBe("accepted");
    expect(saved.data.veventUid).toBe(ORIGINAL_UID);
  });
});

describe("IncomingCalendarRsvpProcessor — drop paths (ok, no signal, WARN)", () => {
  it("drops a message with no calendar attachment", async () => {
    const { processor, logger, threadStore } = makeProcessor({ raw: rawPlainEmail() });

    const result = await processor.process(makeMessage());

    expect(result.isOk()).toBe(true);
    expect(threadStore.getThread).not.toHaveBeenCalled();
    expect(threadStore.saveSignal).not.toHaveBeenCalled();
    expect(logger.calls.some(c => c.method === "warn" && c.context?.code === "processor.calendar_response.no_ics")).toBe(true);
  });

  it("drops a forged proxy UID (HMAC mismatch) before any I/O", async () => {
    const forgedUid = `${VALID_ACC_ID}.${VALID_ARC_ID}.${ORIGINAL_UID}.AAAAAAAAAAAAAAAA@${SERVICE_DOMAIN}`;
    const { processor, logger, threadStore, forwarder } = makeProcessor({ raw: rawRsvpEmail({ proxyUid: forgedUid }) });
    const sendReplySpy = vi.spyOn(forwarder, "sendReply");

    const result = await processor.process(makeMessage());

    expect(result.isOk()).toBe(true);
    expect(threadStore.getThread).not.toHaveBeenCalled();
    expect(threadStore.saveSignal).not.toHaveBeenCalled();
    expect(sendReplySpy).not.toHaveBeenCalled();
    expect(logger.calls.some(c => c.method === "warn" && c.context?.code === "processor.calendar_response.hmac_failed")).toBe(true);
  });

  it("drops a non-REPLY method message", async () => {
    const proxyUid = await buildProxyUid({ accountId: VALID_ACC_ID, threadId: VALID_ARC_ID, originalVeventUid: ORIGINAL_UID, serviceDomain: SERVICE_DOMAIN });
    const { processor, logger, threadStore } = makeProcessor({ raw: rawRsvpEmail({ proxyUid, method: "REQUEST" }) });

    const result = await processor.process(makeMessage());

    expect(result.isOk()).toBe(true);
    expect(threadStore.saveSignal).not.toHaveBeenCalled();
    expect(logger.calls.some(c => c.method === "warn" && c.context?.code === "processor.calendar_response.no_reply_method")).toBe(true);
  });

  it("drops when the thread is not found, after HMAC passes", async () => {
    const proxyUid = await buildProxyUid({ accountId: VALID_ACC_ID, threadId: VALID_ARC_ID, originalVeventUid: ORIGINAL_UID, serviceDomain: SERVICE_DOMAIN });
    const threadStore = makeThreadStore({ getThread: vi.fn().mockResolvedValue(ok(null)) });
    const { processor, logger } = makeProcessor({ raw: rawRsvpEmail({ proxyUid }), threadStore });

    const result = await processor.process(makeMessage());

    expect(result.isOk()).toBe(true);
    expect(threadStore.getThread).toHaveBeenCalledWith(VALID_ACC_ID, VALID_ARC_ID);
    expect(threadStore.saveSignal).not.toHaveBeenCalled();
    expect(logger.calls.some(c => c.method === "warn" && c.context?.code === "processor.calendar_response.thread_not_found")).toBe(true);
  });
});
