// Feature: calendar-rsvp-reminder, Property 1: RSVP schedule creation guard and computation
//
// For any calendar_event signal with a valid ISO startTime: an RSVP reminder schedule
// is created if and only if `method` equals "REQUEST" (case-insensitive) AND
// `startTime - 24h > now`. When created, the fire time SHALL equal `startTime - 24 hours`
// and the suffix SHALL equal `rsvp.YYYYMMDD` where YYYYMMDD is the event start date
// formatted in UTC.
//
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 6.1**

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ok } from "../../src/errors.js";
import { SignalProcessor } from "../../src/processor/processor.js";
import type { ArcMatcher, InboundSignalMessage } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps, makeRuleEvaluator3 } from "../processor/_shared-new-deps.js";
import { makeArcDbMock, makeAccountDbMock, makeProcessingDbMock } from "../processor/_helpers.js";
import type { ArcDatabase } from "../../src/database/arc-database.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SchedulerClient } from "../../src/scheduler/scheduler-client.js";
import type { Alias } from "../../src/types/index.js";
import type { EmailService } from "../../src/email/email-service.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock the cluster registry with a single active cluster
// ---------------------------------------------------------------------------

vi.mock("../../src/embedding/cluster-registry.js", () => {
  const clusterA = Object.freeze({
    registryId: "cluster-a",
    clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-a",
    secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-a",
    databaseName: "signals",
    modelId: "amazon.titan-embed-text-v2:0",
    dimensions: 1024,
    active: true,
  });
  return {
    CLUSTER_REGISTRY: Object.freeze([clusterA]),
    getActiveClusters: () => [clusterA],
    getRegistryById: (id: string) => (id === "cluster-a" ? clusterA : null),
    getPrimaryArcMatcherRegistry: () => clusterA,
    getSecondaryClusters: () => [],
  };
});

vi.mock("../../src/processor/presign.js", () => ({
  generatePresignedGet: vi.fn().mockResolvedValue("https://presigned-get.example.com/test"),
  generatePresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post.example.com", fields: {} }),
}));

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-rsvp";

const DEFAULT_EMAIL_CONFIG: Alias = {
  id: "cfg-default",
  accountId: TEST_ACCOUNT_ID,
  address: "user@example.com",
  domain: "example.com",
  alias: "user",
  unknownSenderPolicy: "allow_all",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

function makeContentSanitizer(): ContentSanitizerClient {
  return {
    invoke: vi.fn().mockReturnValue(Promise.resolve(ok({
      success: true as const,
      parsed: {
        from: { address: "organizer@external.com", name: "Organizer" },
        to: [{ address: "user@example.com" }],
        cc: [],
        subject: "Calendar Invite: Meeting",
        textBody: "You are invited to a meeting",
        htmlBody: "<p>You are invited</p>",
        attachments: [{ filename: "invite.ics", mimeType: "text/calendar; method=REQUEST", sizeBytes: 512, s3Key: "content/accounts/acct-rsvp/attachments/invite.ics" }],
        headers: { "authentication-results": "spf=pass dkim=pass" },
        sentAt: "2024-01-15T09:00:00Z",
      },
      urlMapping: {},
    }))),
  };
}

function makeSchedulerClientMock(): { [K in keyof SchedulerClient]: ReturnType<typeof vi.fn> } {
  return {
    createFollowup: vi.fn().mockResolvedValue(ok(undefined)),
    deleteFollowup: vi.fn().mockResolvedValue(ok(undefined)),
    getSchedule: vi.fn().mockResolvedValue(ok(null)),
  };
}

function makeArcMatcher(): ArcMatcher {
  return {
    findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
  };
}

function makeMessage(sesMessageId: string): InboundSignalMessage {
  return {
    accountId: TEST_ACCOUNT_ID,
    s3Key: `emails/${sesMessageId}`,
    sesMessageId,
    timestamp: "2024-01-15T10:00:00Z",
    destination: ["user@example.com"],
    dkimVerdict: "PASS",
    dmarcVerdict: "PASS",
  };
}

function makeIcsContent(startTime: string, method = "REQUEST"): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//Test//EN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `DTSTART:${startTime}`,
    `DTEND:${startTime}`,
    "SUMMARY:Team Standup",
    `UID:unique-event-${startTime}@test.com`,
    "ORGANIZER;CN=Organizer:mailto:organizer@external.com",
    "ATTENDEE;CN=User:mailto:user@example.com",
    "SEQUENCE:0",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

function buildProcessor(opts: {
  mockLogger: MockLogger;
  schedulerClient: ReturnType<typeof makeSchedulerClientMock>;
  icsContent: string;
}): SignalProcessor {
  const { mockLogger, schedulerClient, icsContent } = opts;

  const s3Send = vi.fn().mockImplementation(() => {
    return Promise.resolve({
      Body: {
        transformToByteArray: () => Promise.resolve(new TextEncoder().encode(icsContent)),
      },
    });
  });

  const arcDb = makeArcDbMock();
  (arcDb.saveSignal as ReturnType<typeof vi.fn>).mockResolvedValue(ok(undefined));

  const accountDb = makeAccountDbMock();
  (accountDb.getProcessorAccountContext as ReturnType<typeof vi.fn>).mockResolvedValue(ok({
    retentionDays: 0,
    filtering: null,
    aliasConfig: DEFAULT_EMAIL_CONFIG,
    registeredDomains: [],
    userEmails: [],
    billingPlan: "Paid" as const,
  }));

  return new SignalProcessor({
    ...makeSharedNewDeps(),
    arcDb,
    accountDb,
    processingDb: makeProcessingDbMock(),
    contentSanitizer: makeContentSanitizer(),
    s3Client: { send: s3Send } as never,
    emailBucket: "test-bucket",
    contentBucket: "test-content-bucket",
    classifier: { classify: vi.fn().mockResolvedValue(ok({ workflow: "conversation", workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false }, spamScore: 0.05, summary: "A calendar event.", labels: [] })) },
    embeddingGenerator: {
      generateForModel: vi.fn().mockResolvedValue(ok({ modelId: "amazon.titan-embed-text-v2:0", vector: [0.1], dimensions: 1024 })),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([]),
    },
    auroraWriter: {
      upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    },
    arcMatcher: makeArcMatcher(),
    ruleEvaluator: makeRuleEvaluator3(mockLogger),
    logger: mockLogger,
    notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
    replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "mock-reply-id" }) },
    sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud" },
    schedulerClient: schedulerClient as unknown as SchedulerClient,
  });
}

// ---------------------------------------------------------------------------
// Property 1: RSVP schedule creation guard and computation
// ---------------------------------------------------------------------------

describe("Feature: calendar-rsvp-reminder, Property 1: RSVP schedule creation guard and computation", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  // -------------------------------------------------------------------------
  // method=REQUEST with startTime >24h → RSVP schedule IS created
  // Validates: Requirements 1.1, 6.1
  // -------------------------------------------------------------------------

  describe("method=REQUEST with startTime >24h from now → creates RSVP schedule", () => {
    const CREATES_CASES = [
      { label: "exactly 24h + 1s ahead", now: "2025-06-10T12:00:00Z", startTime: "20250611T120001Z", expectedFireAt: "2025-06-10T12:00:01.000Z", expectedSuffix: "rsvp.20250611" },
      { label: "far future (30 days)", now: "2025-01-10T12:00:00Z", startTime: "20250209T140000Z", expectedFireAt: "2025-02-08T14:00:00.000Z", expectedSuffix: "rsvp.20250209" },
      { label: "midnight UTC crossing (event at 00:30 next day)", now: "2025-03-10T00:00:00Z", startTime: "20250311T003000Z", expectedFireAt: "2025-03-10T00:30:00.000Z", expectedSuffix: "rsvp.20250311" },
      { label: "event on Dec 31 (year boundary)", now: "2025-12-29T08:00:00Z", startTime: "20251231T120000Z", expectedFireAt: "2025-12-30T12:00:00.000Z", expectedSuffix: "rsvp.20251231" },
      { label: "event on Jan 1 next year", now: "2025-12-30T08:00:00Z", startTime: "20260101T120000Z", expectedFireAt: "2025-12-31T12:00:00.000Z", expectedSuffix: "rsvp.20260101" },
    ];

    it.each(CREATES_CASES)("$label → fireAt=$expectedFireAt, suffix=$expectedSuffix", async ({ now, startTime, expectedFireAt, expectedSuffix }) => {
      vi.setSystemTime(new Date(now));

      const schedulerClient = makeSchedulerClientMock();
      const processor = buildProcessor({ mockLogger, schedulerClient, icsContent: makeIcsContent(startTime, "REQUEST") });

      await processor.processRecord(makeMessage(`msg-rsvp-create-${startTime}`), 1);

      // Find the RSVP schedule creation call (suffix starts with "rsvp.")
      const rsvpCalls = schedulerClient.createFollowup.mock.calls.filter(
        (c: Array<{ suffix: string }>) => c[0]!.suffix.startsWith("rsvp."),
      );
      expect(rsvpCalls).toHaveLength(1);

      const call = rsvpCalls[0]![0];
      expect(call.fireAt).toBe(expectedFireAt);
      expect(call.suffix).toBe(expectedSuffix);
      expect(call.sqsMessageAttributeMessageType).toBe("rsvp_reminder");
      expect(call.accountId).toBe(TEST_ACCOUNT_ID);
    });
  });

  // -------------------------------------------------------------------------
  // method=REQUEST with startTime ≤24h → RSVP schedule NOT created
  // Validates: Requirement 1.2
  // -------------------------------------------------------------------------

  describe("method=REQUEST with startTime ≤24h from now → skips RSVP schedule", () => {
    const SKIPS_CASES = [
      { label: "exactly 24h ahead (boundary — reminderTime == now)", now: "2025-06-10T12:00:00Z", startTime: "20250611T120000Z" },
      { label: "23h59m59s ahead", now: "2025-06-10T12:00:01Z", startTime: "20250611T120000Z" },
      { label: "12h ahead", now: "2025-06-10T12:00:00Z", startTime: "20250611T000000Z" },
      { label: "1h ahead", now: "2025-06-10T12:00:00Z", startTime: "20250610T130000Z" },
      { label: "event is now (0h)", now: "2025-06-10T12:00:00Z", startTime: "20250610T120000Z" },
    ];

    it.each(SKIPS_CASES)("$label → no RSVP schedule created", async ({ now, startTime }) => {
      vi.setSystemTime(new Date(now));

      const schedulerClient = makeSchedulerClientMock();
      const processor = buildProcessor({ mockLogger, schedulerClient, icsContent: makeIcsContent(startTime, "REQUEST") });

      await processor.processRecord(makeMessage(`msg-rsvp-skip-${startTime}`), 1);

      // No RSVP schedule call (may still have day-of calendar schedule)
      const rsvpCalls = schedulerClient.createFollowup.mock.calls.filter(
        (c: Array<{ suffix: string }>) => c[0]!.suffix.startsWith("rsvp."),
      );
      expect(rsvpCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // method ≠ REQUEST → RSVP schedule NOT created
  // Validates: Requirement 1.3
  // -------------------------------------------------------------------------

  describe("method ≠ REQUEST → skips RSVP schedule", () => {
    const NON_REQUEST_METHODS = [
      { method: "CANCEL", label: "CANCEL" },
      { method: "REPLY", label: "REPLY" },
      { method: "COUNTER", label: "COUNTER" },
      { method: "ADD", label: "ADD" },
    ];

    it.each(NON_REQUEST_METHODS)("method=$method → no RSVP schedule", async ({ method }) => {
      // Use a far-future event to ensure the only reason for skipping is the method
      vi.setSystemTime(new Date("2025-01-10T12:00:00Z"));

      const schedulerClient = makeSchedulerClientMock();
      const processor = buildProcessor({ mockLogger, schedulerClient, icsContent: makeIcsContent("20250715T140000Z", method) });

      await processor.processRecord(makeMessage(`msg-rsvp-method-${method}`), 1);

      const rsvpCalls = schedulerClient.createFollowup.mock.calls.filter(
        (c: Array<{ suffix: string }>) => c[0]!.suffix.startsWith("rsvp."),
      );
      expect(rsvpCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // method=REQUEST case-insensitive
  // Validates: Requirement 1.1 (case-insensitive)
  // -------------------------------------------------------------------------

  describe("method=REQUEST is case-insensitive", () => {
    it.each([
      { method: "request", label: "lowercase" },
      { method: "Request", label: "title case" },
      { method: "REQUEST", label: "uppercase" },
    ])("method=$method ($label) → RSVP schedule created", async ({ method }) => {
      vi.setSystemTime(new Date("2025-01-10T12:00:00Z"));

      const schedulerClient = makeSchedulerClientMock();
      const processor = buildProcessor({ mockLogger, schedulerClient, icsContent: makeIcsContent("20250715T140000Z", method) });

      await processor.processRecord(makeMessage(`msg-rsvp-case-${method}`), 1);

      const rsvpCalls = schedulerClient.createFollowup.mock.calls.filter(
        (c: Array<{ suffix: string }>) => c[0]!.suffix.startsWith("rsvp."),
      );
      expect(rsvpCalls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Missing startTime → skips, logs WARN
  // Validates: Requirement 1.7
  // -------------------------------------------------------------------------

  describe("missing startTime → skips and logs WARN", () => {
    it("ICS with no DTSTART → no RSVP schedule, WARN logged", async () => {
      vi.setSystemTime(new Date("2025-01-10T12:00:00Z"));

      const icsWithoutDtstart = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Test//Test//EN",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        "SUMMARY:No Start Time Event",
        "UID:no-dtstart@test.com",
        "ORGANIZER;CN=Organizer:mailto:organizer@external.com",
        "ATTENDEE;CN=User:mailto:user@example.com",
        "SEQUENCE:0",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      const schedulerClient = makeSchedulerClientMock();
      const processor = buildProcessor({ mockLogger, schedulerClient, icsContent: icsWithoutDtstart });

      await processor.processRecord(makeMessage("msg-rsvp-no-dtstart"), 1);

      const rsvpCalls = schedulerClient.createFollowup.mock.calls.filter(
        (c: Array<{ suffix: string }>) => c[0]!.suffix.startsWith("rsvp."),
      );
      expect(rsvpCalls).toHaveLength(0);

      const warnLogs = mockLogger.calls.filter(c => c.method === "warn" && c.context?.code === "processor.calendar.rsvp_missing_start_time");
      expect(warnLogs).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Suffix format: rsvp.YYYYMMDD in UTC
  // Validates: Requirement 1.4
  // -------------------------------------------------------------------------

  describe("suffix is rsvp.YYYYMMDD using UTC date of event start", () => {
    it("event at 01:00 UTC Jan 1 → suffix uses Jan 1 (not Dec 31)", async () => {
      vi.setSystemTime(new Date("2024-12-29T12:00:00Z"));

      const schedulerClient = makeSchedulerClientMock();
      const processor = buildProcessor({ mockLogger, schedulerClient, icsContent: makeIcsContent("20250101T010000Z", "REQUEST") });

      await processor.processRecord(makeMessage("msg-rsvp-suffix-utc"), 1);

      const rsvpCalls = schedulerClient.createFollowup.mock.calls.filter(
        (c: Array<{ suffix: string }>) => c[0]!.suffix.startsWith("rsvp."),
      );
      expect(rsvpCalls).toHaveLength(1);
      expect(rsvpCalls[0]![0].suffix).toBe("rsvp.20250101");
    });

    it("event at 23:59 UTC → suffix uses same day", async () => {
      vi.setSystemTime(new Date("2025-06-01T08:00:00Z"));

      const schedulerClient = makeSchedulerClientMock();
      const processor = buildProcessor({ mockLogger, schedulerClient, icsContent: makeIcsContent("20250615T235900Z", "REQUEST") });

      await processor.processRecord(makeMessage("msg-rsvp-suffix-eod"), 1);

      const rsvpCalls = schedulerClient.createFollowup.mock.calls.filter(
        (c: Array<{ suffix: string }>) => c[0]!.suffix.startsWith("rsvp."),
      );
      expect(rsvpCalls).toHaveLength(1);
      expect(rsvpCalls[0]![0].suffix).toBe("rsvp.20250615");
    });
  });
});
