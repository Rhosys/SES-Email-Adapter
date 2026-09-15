import { describe, it, expect } from "vitest";
import { CalendarForwarder } from "../../../src/processor/calendar/calendar-forwarder.js";
import { parseIcs } from "../../../src/processor/calendar/ics-parser.js";
import { buildProxyUid as buildProxyUidRaw } from "../../../src/processor/calendar/proxy-uid.js";
import { generateId, generateAccountId } from "../../../src/utils/id.js";
import { makeHmacGeneratorFake } from "../../helpers/hmac-generator-fake.js";
import type { EmailService } from "../../../src/email/email-service.js";

// ---------------------------------------------------------------------------
// CalendarForwarder.validateRsvp — the stateless half of the inbound calendar
// loop. These tests exercise pure computation over a parsed .ics plus the HMAC
// secret: METHOD:REPLY, PARTSTAT decision, proxy-UID HMAC. No I/O, no database.
// ---------------------------------------------------------------------------

const hmac = makeHmacGeneratorFake();
const SERVICE_DOMAIN = "platform.email.rhosys.cloud";
const VALID_ARC_ID = generateId("thr-");
const VALID_ACC_ID = generateAccountId();
const ORIGINAL_UID = "uid-original-123";

const buildProxyUid = (opts: Omit<Parameters<typeof buildProxyUidRaw>[0], "hmac">) =>
  buildProxyUidRaw({ ...opts, hmac });

function makeForwarder(): CalendarForwarder {
  // validateRsvp never touches emailService; a bare stub satisfies the constructor.
  return new CalendarForwarder({
    emailService: {} as unknown as EmailService,
    serviceDomain: SERVICE_DOMAIN,
    hmac,
  });
}

function icsBytes(opts: { proxyUid: string; method?: string; partstat?: string | null }): Uint8Array {
  const attendee = opts.partstat === null
    ? `ATTENDEE:mailto:${VALID_ARC_ID}@${VALID_ACC_ID}.${SERVICE_DOMAIN}`
    : `ATTENDEE;PARTSTAT=${opts.partstat ?? "ACCEPTED"}:mailto:${VALID_ARC_ID}@${VALID_ACC_ID}.${SERVICE_DOMAIN}`;
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
    "ORGANIZER;CN=Alice Smith:mailto:alice@example.com",
    attendee,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  return new TextEncoder().encode(ics);
}

async function parse(bytes: Uint8Array) {
  const result = parseIcs(bytes);
  if (result.isErr()) throw new Error(`fixture .ics failed to parse: ${result.error.reason}`);
  return result.value.calendarData;
}

describe("CalendarForwarder.validateRsvp", () => {
  it("accepts a valid REPLY and returns identity decoded from the HMAC-authenticated proxy UID", async () => {
    const proxyUid = await buildProxyUid({ accountId: VALID_ACC_ID, threadId: VALID_ARC_ID, originalVeventUid: ORIGINAL_UID, serviceDomain: SERVICE_DOMAIN });
    const calendarData = await parse(icsBytes({ proxyUid, partstat: "ACCEPTED" }));

    const result = await makeForwarder().validateRsvp(calendarData);

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.decision).toBe("accepted");
    expect(value.accountId).toBe(VALID_ACC_ID);
    expect(value.threadId).toBe(VALID_ARC_ID);
    expect(value.originalVeventUid).toBe(ORIGINAL_UID);
    expect(value.organizerAddress).toBe("alice@example.com");
  });

  it.each([
    { partstat: "ACCEPTED", decision: "accepted" },
    { partstat: "DECLINED", decision: "declined" },
    { partstat: "TENTATIVE", decision: "tentative" },
  ])("maps PARTSTAT $partstat to decision $decision", async ({ partstat, decision }) => {
    const proxyUid = await buildProxyUid({ accountId: VALID_ACC_ID, threadId: VALID_ARC_ID, originalVeventUid: ORIGINAL_UID, serviceDomain: SERVICE_DOMAIN });
    const calendarData = await parse(icsBytes({ proxyUid, partstat }));

    const result = await makeForwarder().validateRsvp(calendarData);

    expect(result._unsafeUnwrap().decision).toBe(decision);
  });

  it("rejects a non-REPLY method without checking the HMAC", async () => {
    const proxyUid = await buildProxyUid({ accountId: VALID_ACC_ID, threadId: VALID_ARC_ID, originalVeventUid: ORIGINAL_UID, serviceDomain: SERVICE_DOMAIN });
    const calendarData = await parse(icsBytes({ proxyUid, method: "REQUEST" }));

    const result = await makeForwarder().validateRsvp(calendarData);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("not_reply_method");
    expect(result._unsafeUnwrapErr().code).toBe("processor.calendar_response.no_reply_method");
  });

  it("rejects a REPLY with no recognised PARTSTAT", async () => {
    const proxyUid = await buildProxyUid({ accountId: VALID_ACC_ID, threadId: VALID_ARC_ID, originalVeventUid: ORIGINAL_UID, serviceDomain: SERVICE_DOMAIN });
    const calendarData = await parse(icsBytes({ proxyUid, partstat: null }));

    const result = await makeForwarder().validateRsvp(calendarData);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("no_partstat");
  });

  it("rejects a forged proxy UID (HMAC mismatch) — the security gate", async () => {
    // A UID an attacker could construct by guessing the format but not the secret.
    const forgedUid = `${VALID_ACC_ID}.${VALID_ARC_ID}.${ORIGINAL_UID}.AAAAAAAAAAAAAAAA@${SERVICE_DOMAIN}`;
    const calendarData = await parse(icsBytes({ proxyUid: forgedUid, partstat: "ACCEPTED" }));

    const result = await makeForwarder().validateRsvp(calendarData);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("hmac_failed");
    expect(result._unsafeUnwrapErr().code).toBe("processor.calendar_response.hmac_failed");
  });
});
