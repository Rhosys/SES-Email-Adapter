import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok } from "../src/errors.js";
import { SesFeedbackProcessor } from "../src/notifier/ses-feedback-processor.js";
import type { FeedbackSignalStore } from "../src/notifier/ses-feedback-processor.js";
import type { ProcessingDatabase } from "../src/database/processing-database.js";
import type { AccountDatabase } from "../src/database/account-database.js";
import type { SesFeedback, Signal } from "../src/types/index.js";
import { createMockLogger } from "./helpers/mock-logger.js";
import { TAG_ACCOUNT_ID, TAG_TYPE, TAG_SIGNAL_ID, TAG_THREAD_ID, TAG_HEALTHCHECK_ID } from "../src/email/ses-tags.js";

function makeSentSignal(overrides: { data?: Partial<Signal["data"]> } & Partial<Omit<Signal, "data">> = {}): Signal {
  const { data: dataOverrides, ...baseOverrides } = overrides;
  return {
    id: "sgn-signal001",
    signalLookupId: "sgn-signal001",
    threadId: "arc-001",
    accountId: "acct-001",
    source: "user",
    type: "email",
    status: "sent",
    createdAt: "2024-06-01T12:00:00.000Z",
    ...baseOverrides,
    data: {
      sesMessageId: "ses-msg-abc",
      from: { address: "me@example.com" },
      to: [{ address: "recipient@example.com" }],
      cc: [],
      subject: "Hello",
      textBody: "Hi there",
      attachments: [],
      headers: {},
      recipientAddress: "me@example.com",
      workflow: "conversation",
      workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
      tags: [],
      summary: "",
      s3Key: "",
      receivedAt: "2024-06-01T12:00:00.000Z",
      ...dataOverrides,
    },
  } as Signal;
}

function makeBounceFeedback(overrides: Partial<SesFeedback> = {}): SesFeedback {
  return {
    notificationType: "Bounce",
    bounce: {
      bounceType: "Permanent",
      bounceSubType: "General",
      bouncedRecipients: [{ emailAddress: "recipient@example.com", status: "5.1.1" }],
      timestamp: "2024-06-01T12:05:00.000Z",
    },
    mail: {
      messageId: "ses-msg-abc",
      source: "me@example.com",
      tags: { [TAG_ACCOUNT_ID]: "acct-001" },
    },
    ...overrides,
  };
}

function makeProcessingDb(): ProcessingDatabase {
  return {
    suppressAddress: vi.fn().mockResolvedValue(ok(undefined)),
    isAddressSuppressed: vi.fn().mockResolvedValue(ok(false)),
    updateGlobalReputation: vi.fn().mockResolvedValue(ok(undefined)),
  } as unknown as ProcessingDatabase;
}

function makeAccountDb(): AccountDatabase {
  return {
    disableRulesForwardingTo: vi.fn().mockResolvedValue(ok(["rule-fwd-001"])),
  } as unknown as AccountDatabase;
}

function makeSignalStore(): FeedbackSignalStore {
  return {
    getSignalById: vi.fn().mockResolvedValue(ok(null)),
    getSignalByMessageId: vi.fn().mockResolvedValue(ok(makeSentSignal())),
    saveSignal: vi.fn().mockResolvedValue(ok(undefined)),
    updateSignalSendStatus: vi.fn().mockResolvedValue(ok(makeSentSignal({ status: "draft" }))),
  };
}

describe("SesFeedbackProcessor — bounce handling for user-sent signals", () => {
  let processingDb: ProcessingDatabase;
  let accountDb: AccountDatabase;
  let signalStore: FeedbackSignalStore;
  let processor: SesFeedbackProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    processingDb = makeProcessingDb();
    accountDb = makeAccountDb();
    signalStore = makeSignalStore();
    processor = new SesFeedbackProcessor(processingDb, accountDb, createMockLogger(), signalStore);
  });

  it("does not create deliverability signal when bounce is for a non-user signal", async () => {
    vi.mocked(signalStore.getSignalByMessageId).mockResolvedValueOnce(ok(makeSentSignal({ source: "email" })));

    const result = await processor.processNotification(makeBounceFeedback());

    expect(result.isOk()).toBe(true);
    expect(signalStore.saveSignal).not.toHaveBeenCalled();
    expect(signalStore.updateSignalSendStatus).not.toHaveBeenCalled();
  });

  it("does not create deliverability signal when no matching signal found", async () => {
    vi.mocked(signalStore.getSignalByMessageId).mockResolvedValueOnce(ok(null));

    const result = await processor.processNotification(makeBounceFeedback());

    expect(result.isOk()).toBe(true);
    expect(signalStore.saveSignal).not.toHaveBeenCalled();
  });

  it("creates deliverability signal with correct fields on permanent bounce for user signal", async () => {
    const result = await processor.processNotification(makeBounceFeedback());

    expect(result.isOk()).toBe(true);
    expect(signalStore.saveSignal).toHaveBeenCalledTimes(1);

    const savedSignal = vi.mocked(signalStore.saveSignal).mock.calls[0]![0];
    const deliverabilityData = savedSignal.data as unknown as import("../src/types/index.js").DeliverabilitySignalData;
    expect(savedSignal.id).toMatch(/^sgn-/);
    expect(savedSignal.threadId).toBe("arc-001");
    expect(savedSignal.accountId).toBe("acct-001");
    expect(savedSignal.source).toBe("ses_feedback");
    expect(savedSignal.status).toBe("active");
    expect(deliverabilityData.linkedSignalId).toBe("sgn-signal001");
    expect(deliverabilityData.bouncedRecipients).toEqual([
      { address: "recipient@example.com", bounceType: "permanent", reason: "5.1.1" },
    ]);
    expect(savedSignal.data.subject).toBe("Delivery failure: 1 recipient(s) bounced");
  });

  it("reverts original signal to draft when ALL recipients permanently bounced", async () => {
    const result = await processor.processNotification(makeBounceFeedback());

    expect(result.isOk()).toBe(true);
    expect(signalStore.updateSignalSendStatus).toHaveBeenCalledWith("acct-001", "sgn-signal001", {
      status: "draft",
      sendFailureReason: "all_recipients_bounced",
      sendInitiatedAt: null,
    });
  });

  it("does not revert original signal when only some recipients bounced (partial bounce)", async () => {
    vi.mocked(signalStore.getSignalByMessageId).mockResolvedValueOnce(ok(makeSentSignal({
      data: { to: [{ address: "recipient@example.com" }, { address: "other@example.com" }] },
    })));

    const result = await processor.processNotification(makeBounceFeedback());

    expect(result.isOk()).toBe(true);
    // Deliverability signal still created
    expect(signalStore.saveSignal).toHaveBeenCalledTimes(1);
    // But original NOT reverted — only 1 of 2 recipients bounced
    expect(signalStore.updateSignalSendStatus).not.toHaveBeenCalled();
  });

  it("does not revert original signal on transient bounce — deliverability signal still created", async () => {
    const transientFeedback = makeBounceFeedback({
      bounce: {
        bounceType: "Transient",
        bounceSubType: "MailboxFull",
        bouncedRecipients: [{ emailAddress: "recipient@example.com", status: "4.2.2" }],
        timestamp: "2024-06-01T12:05:00.000Z",
      },
    });

    const result = await processor.processNotification(transientFeedback);

    expect(result.isOk()).toBe(true);
    // Deliverability signal created with transient bounceType
    expect(signalStore.saveSignal).toHaveBeenCalledTimes(1);
    const savedSignal = vi.mocked(signalStore.saveSignal).mock.calls[0]![0];
    const deliverabilityData2 = savedSignal.data as unknown as import("../src/types/index.js").DeliverabilitySignalData;
    expect(deliverabilityData2.bouncedRecipients).toEqual([
      { address: "recipient@example.com", bounceType: "transient", reason: "4.2.2" },
    ]);
    // Original NOT reverted — transient bounces don't trigger revert
    expect(signalStore.updateSignalSendStatus).not.toHaveBeenCalled();
  });
});


describe("SesFeedbackProcessor — prefixed tag reading", () => {
  let processingDb: ProcessingDatabase;
  let accountDb: AccountDatabase;
  let signalStore: FeedbackSignalStore;
  let processor: SesFeedbackProcessor;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    processingDb = makeProcessingDb();
    accountDb = makeAccountDb();
    signalStore = makeSignalStore();
    logger = createMockLogger();
    processor = new SesFeedbackProcessor(processingDb, accountDb, logger, signalStore);
  });

  it("disables forward rules when X-Numaeel-AccountId and X-Numaeel-Type=forward are present", async () => {
    const feedback = makeBounceFeedback({
      mail: {
        messageId: "ses-msg-abc",
        source: "me@example.com",
        tags: { [TAG_ACCOUNT_ID]: "acct-001", [TAG_TYPE]: "forward" },
      },
    });

    const result = await processor.processNotification(feedback);

    expect(result.isOk()).toBe(true);
    expect(accountDb.disableRulesForwardingTo).toHaveBeenCalledWith("acct-001", "recipient@example.com");
    expect(logger.calls).toContainEqual({
      method: "track",
      message: "Rule disabled due to permanent forward bounce",
      context: { code: "feedback.rule_disabled_on_bounce", accountId: "acct-001", ruleId: "rule-fwd-001", bouncedAddress: "recipient@example.com" },
    });
  });

  it("skips account-specific correlation when X-Numaeel-AccountId is absent — suppression only", async () => {
    const feedback = makeBounceFeedback({
      mail: {
        messageId: "ses-msg-abc",
        source: "me@example.com",
        tags: { [TAG_TYPE]: "forward" },
      },
    });

    const result = await processor.processNotification(feedback);

    expect(result.isOk()).toBe(true);
    // Address suppression still happens
    expect(processingDb.suppressAddress).toHaveBeenCalledTimes(1);
    // Forward-rule disabling skipped (no accountId)
    expect(accountDb.disableRulesForwardingTo).not.toHaveBeenCalled();
    // Signal lookup skipped (no accountId)
    expect(signalStore.getSignalById).not.toHaveBeenCalled();
    expect(signalStore.getSignalByMessageId).not.toHaveBeenCalled();
  });

  it("uses direct signal lookup via getSignalById when X-Numaeel-SignalId is present", async () => {
    vi.mocked(signalStore.getSignalById).mockResolvedValueOnce(ok(makeSentSignal()));

    const feedback = makeBounceFeedback({
      mail: {
        messageId: "ses-msg-abc",
        source: "me@example.com",
        tags: { [TAG_ACCOUNT_ID]: "acct-001", [TAG_SIGNAL_ID]: "sgn-signal001", [TAG_THREAD_ID]: "thr-abc" },
      },
    });

    const result = await processor.processNotification(feedback);

    expect(result.isOk()).toBe(true);
    expect(signalStore.getSignalById).toHaveBeenCalledWith("acct-001", "sgn-signal001", "thr-abc");
    expect(signalStore.getSignalByMessageId).not.toHaveBeenCalled();
  });

  it("assigns deliverability signal to the arc from X-Numaeel-ArcId tag", async () => {
    vi.mocked(signalStore.getSignalById).mockResolvedValueOnce(ok(makeSentSignal({ threadId: "arc-original" })));

    const feedback = makeBounceFeedback({
      mail: {
        messageId: "ses-msg-abc",
        source: "me@example.com",
        tags: {
          [TAG_ACCOUNT_ID]: "acct-001",
          [TAG_SIGNAL_ID]: "sgn-signal001",
          [TAG_THREAD_ID]: "arc-from-tag",
        },
      },
    });

    const result = await processor.processNotification(feedback);

    expect(result.isOk()).toBe(true);
    expect(signalStore.getSignalById).toHaveBeenCalledWith("acct-001", "sgn-signal001", "arc-from-tag");
    expect(signalStore.saveSignal).toHaveBeenCalledTimes(1);
    const savedSignal = vi.mocked(signalStore.saveSignal).mock.calls[0]![0];
    // Arc ID from the tag takes precedence over the signal's own arcId
    expect(savedSignal.threadId).toBe("arc-from-tag");
  });

  it("falls back to getSignalByMessageId when no prefixed tags are present", async () => {
    const feedback = makeBounceFeedback({
      mail: {
        messageId: "ses-msg-abc",
        source: "me@example.com",
        tags: { accountId: "acct-001" },
      },
    });

    const result = await processor.processNotification(feedback);

    expect(result.isOk()).toBe(true);
    expect(signalStore.getSignalById).not.toHaveBeenCalled();
    expect(signalStore.getSignalByMessageId).toHaveBeenCalledWith("acct-001", "ses-msg-abc");
  });
});

describe("SesFeedbackProcessor — origin/process logging", () => {
  let logger: ReturnType<typeof createMockLogger>;
  let processor: SesFeedbackProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
    processor = new SesFeedbackProcessor(makeProcessingDb(), makeAccountDb(), logger, makeSignalStore());
  });

  it("logs a healthcheck bounce at error level with the healthcheck process + id", async () => {
    await processor.processNotification(makeBounceFeedback({
      mail: { messageId: "ses-hc", source: "s", tags: { [TAG_HEALTHCHECK_ID]: "healthcheck-2026-07-08", purpose: "healthcheck" } },
    }));

    const log = logger.calls.find(c => (c.context as Record<string, unknown>)?.code === "feedback.system_bounce");
    expect(log).toBeDefined();
    expect(log!.method).toBe("error");
    const ctx = log!.context as Record<string, unknown>;
    const feedback = ctx.feedback as Record<string, unknown>;
    const mail = feedback.mail as Record<string, unknown>;
    const tags = mail.tags as Record<string, unknown>;
    expect(tags[TAG_HEALTHCHECK_ID]).toBe("healthcheck-2026-07-08");
  });

  it("logs a non-system (forward) bounce at track level with the forward process", async () => {
    await processor.processNotification(makeBounceFeedback({
      mail: { messageId: "ses-fwd", source: "s", tags: { [TAG_TYPE]: "forward", [TAG_ACCOUNT_ID]: "acct-001" } },
    }));

    const log = logger.calls.find(c => (c.context as Record<string, unknown>)?.code === "feedback.bounce");
    expect(log).toBeDefined();
    expect(log!.method).toBe("track");
    const ctx = log!.context as Record<string, unknown>;
    const feedback = ctx.feedback as Record<string, unknown>;
    const mail = feedback.mail as Record<string, unknown>;
    const tags = mail.tags as Record<string, unknown>;
    expect(tags[TAG_TYPE]).toBe("forward");
  });

  it("logs a healthcheck complaint at error level", async () => {
    await processor.processNotification({
      notificationType: "Complaint",
      complaint: { complainedRecipients: [{ emailAddress: "x@y.com" }], timestamp: "2024-06-01T00:00:00.000Z" },
      mail: { messageId: "ses-hc-c", source: "s", tags: { [TAG_HEALTHCHECK_ID]: "healthcheck-2026-07-08" } },
    } as SesFeedback);

    const log = logger.calls.find(c => (c.context as Record<string, unknown>)?.code === "feedback.system_complaint");
    expect(log).toBeDefined();
    expect(log!.method).toBe("error");
    const ctx = log!.context as Record<string, unknown>;
    const feedback = ctx.feedback as Record<string, unknown>;
    const mail = feedback.mail as Record<string, unknown>;
    const tags = mail.tags as Record<string, unknown>;
    expect(tags[TAG_HEALTHCHECK_ID]).toBe("healthcheck-2026-07-08");
  });
});

describe("SesFeedbackProcessor — eventType vs notificationType resolution", () => {
  // deploy/email_routing.tf wires Bounce/Complaint via aws_sesv2_configuration_set_event_destination,
  // AWS's "event publishing" API, which puts the discriminator in `eventType` rather than
  // `notificationType`. These tests lock in that the real production shape is handled,
  // not just the older `notificationType` shape used in the tests above.
  let logger: ReturnType<typeof createMockLogger>;
  let processor: SesFeedbackProcessor;
  let processingDb: ProcessingDatabase;

  beforeEach(() => {
    logger = createMockLogger();
    processingDb = makeProcessingDb();
    processor = new SesFeedbackProcessor(processingDb, makeAccountDb(), logger, makeSignalStore());
  });

  it("suppresses the address for a Bounce carried in `eventType` (real config-set shape)", async () => {
    const result = await processor.processNotification({
      eventType: "Bounce",
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [{ emailAddress: "recipient@example.com", status: "5.1.1" }],
        timestamp: "2024-06-01T12:05:00.000Z",
      },
      mail: { messageId: "ses-msg-evt", source: "me@example.com", tags: {} },
    } as unknown as SesFeedback);

    expect(result.isOk()).toBe(true);
    expect(processingDb.suppressAddress).toHaveBeenCalledTimes(1);
  });

  it("suppresses the address for a Complaint carried in `eventType`", async () => {
    const result = await processor.processNotification({
      eventType: "Complaint",
      complaint: { complainedRecipients: [{ emailAddress: "x@y.com" }], timestamp: "2024-06-01T00:00:00.000Z" },
      mail: { messageId: "ses-msg-evt-c", source: "s", tags: {} },
    } as unknown as SesFeedback);

    expect(result.isOk()).toBe(true);
    expect(processingDb.suppressAddress).toHaveBeenCalledTimes(1);
  });

  it("TRACK-logs (does not silently drop) a known-but-unactioned event type, e.g. Delivery", async () => {
    const result = await processor.processNotification({
      eventType: "Delivery",
      mail: { messageId: "ses-msg-delivery", source: "s", tags: {} },
    } as unknown as SesFeedback);

    expect(result.isOk()).toBe(true);
    const log = logger.calls.find(c => (c.context as Record<string, unknown>)?.code === "feedback.unactioned_event_type");
    expect(log).toBeDefined();
    expect(log!.method).toBe("track");
    const feedback = (log!.context as Record<string, unknown>).feedback as Record<string, unknown>;
    expect(feedback.eventType).toBe("Delivery");
  });

  it("ERROR-logs a genuinely unrecognised eventType/notificationType instead of silently dropping it", async () => {
    const result = await processor.processNotification({
      eventType: "SomeFutureSesEventType",
      mail: { messageId: "ses-msg-unknown", source: "s", tags: {} },
    } as unknown as SesFeedback);

    expect(result.isOk()).toBe(true);
    const log = logger.calls.find(c => (c.context as Record<string, unknown>)?.code === "feedback.unknown_type");
    expect(log).toBeDefined();
    expect(log!.method).toBe("error");
  });
});
