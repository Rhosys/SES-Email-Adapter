import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok } from "../src/errors.js";
import { FeedbackProcessor } from "../src/notifier/feedback-processor.js";
import type { FeedbackSignalStore } from "../src/notifier/feedback-processor.js";
import type { ProcessingDatabase } from "../src/database/processing-database.js";
import type { AccountDatabase } from "../src/database/account-database.js";
import type { SesFeedback, Signal } from "../src/types/index.js";
import { createMockLogger } from "./helpers/mock-logger.js";
import { TAG_ACCOUNT_ID, TAG_TYPE, TAG_SIGNAL_ID, TAG_ARC_ID } from "../src/email/ses-tags.js";

function makeSentSignal(overrides: { data?: Partial<Signal["data"]> } & Partial<Omit<Signal, "data">> = {}): Signal {
  const { data: dataOverrides, ...baseOverrides } = overrides;
  return {
    id: "sgn-signal001",
    signalLookupId: "sgn-signal001",
    arcId: "arc-001",
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
      spamScore: 0,
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
    disableForwardActions: vi.fn().mockResolvedValue(ok(undefined)),
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

describe("FeedbackProcessor — bounce handling for user-sent signals", () => {
  let processingDb: ProcessingDatabase;
  let accountDb: AccountDatabase;
  let signalStore: FeedbackSignalStore;
  let processor: FeedbackProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    processingDb = makeProcessingDb();
    accountDb = makeAccountDb();
    signalStore = makeSignalStore();
    processor = new FeedbackProcessor(processingDb, accountDb, createMockLogger(), signalStore);
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
    expect(savedSignal.id).toMatch(/^sgn-/);
    expect(savedSignal.arcId).toBe("arc-001");
    expect(savedSignal.accountId).toBe("acct-001");
    expect(savedSignal.source).toBe("ses_feedback");
    expect(savedSignal.status).toBe("active");
    expect(savedSignal.data.relatedSignalId).toBe("sgn-signal001");
    expect(savedSignal.data.bouncedRecipients).toEqual([
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
    expect(savedSignal.data.bouncedRecipients).toEqual([
      { address: "recipient@example.com", bounceType: "transient", reason: "4.2.2" },
    ]);
    // Original NOT reverted — transient bounces don't trigger revert
    expect(signalStore.updateSignalSendStatus).not.toHaveBeenCalled();
  });
});


describe("FeedbackProcessor — prefixed tag reading", () => {
  let processingDb: ProcessingDatabase;
  let accountDb: AccountDatabase;
  let signalStore: FeedbackSignalStore;
  let processor: FeedbackProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    processingDb = makeProcessingDb();
    accountDb = makeAccountDb();
    signalStore = makeSignalStore();
    processor = new FeedbackProcessor(processingDb, accountDb, createMockLogger(), signalStore);
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
    expect(accountDb.disableForwardActions).toHaveBeenCalledWith("acct-001", "recipient@example.com");
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
    expect(accountDb.disableForwardActions).not.toHaveBeenCalled();
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
        tags: { [TAG_ACCOUNT_ID]: "acct-001", [TAG_SIGNAL_ID]: "sgn-signal001" },
      },
    });

    const result = await processor.processNotification(feedback);

    expect(result.isOk()).toBe(true);
    expect(signalStore.getSignalById).toHaveBeenCalledWith("acct-001", "sgn-signal001");
    expect(signalStore.getSignalByMessageId).not.toHaveBeenCalled();
  });

  it("assigns deliverability signal to the arc from X-Numaeel-ArcId tag", async () => {
    vi.mocked(signalStore.getSignalById).mockResolvedValueOnce(ok(makeSentSignal({ arcId: "arc-original" })));

    const feedback = makeBounceFeedback({
      mail: {
        messageId: "ses-msg-abc",
        source: "me@example.com",
        tags: {
          [TAG_ACCOUNT_ID]: "acct-001",
          [TAG_SIGNAL_ID]: "sgn-signal001",
          [TAG_ARC_ID]: "arc-from-tag",
        },
      },
    });

    const result = await processor.processNotification(feedback);

    expect(result.isOk()).toBe(true);
    expect(signalStore.saveSignal).toHaveBeenCalledTimes(1);
    const savedSignal = vi.mocked(signalStore.saveSignal).mock.calls[0]![0];
    // Arc ID from the tag takes precedence over the signal's own arcId
    expect(savedSignal.arcId).toBe("arc-from-tag");
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
