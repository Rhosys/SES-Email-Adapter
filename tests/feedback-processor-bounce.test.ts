import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok } from "../src/errors.js";
import { FeedbackProcessor } from "../src/notifier/feedback-processor.js";
import type { FeedbackSignalStore } from "../src/notifier/feedback-processor.js";
import type { ProcessingDatabase } from "../src/database/processing-database.js";
import type { AccountDatabase } from "../src/database/account-database.js";
import type { SesFeedback, Signal } from "../src/types/index.js";
import { createMockLogger } from "./helpers/mock-logger.js";

function makeSentSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "USR#signal-001",
    signalLookupId: "USR#signal-001",
    arcId: "arc-001",
    accountId: "acct-001",
    source: "user",
    status: "sent",
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
    classificationModelId: "",
    s3Key: "",
    receivedAt: "2024-06-01T12:00:00.000Z",
    createdAt: "2024-06-01T12:00:00.000Z",
    ...overrides,
  };
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
      tags: { accountId: "acct-001" },
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
    expect(savedSignal.id).toMatch(/^SYS#/);
    expect(savedSignal.arcId).toBe("arc-001");
    expect(savedSignal.accountId).toBe("acct-001");
    expect(savedSignal.source).toBe("deliverability");
    expect(savedSignal.status).toBe("active");
    expect(savedSignal.from).toEqual({ address: "system@deliverability" });
    expect(savedSignal.relatedSignalId).toBe("USR#signal-001");
    expect(savedSignal.bouncedRecipients).toEqual([
      { address: "recipient@example.com", bounceType: "permanent", reason: "5.1.1" },
    ]);
    expect(savedSignal.subject).toBe("Delivery failure: 1 recipient(s) bounced");
    expect(savedSignal.workflow).toBe("conversation");
    expect(savedSignal.recipientAddress).toBe("me@example.com");
  });

  it("reverts original signal to draft when ALL recipients permanently bounced", async () => {
    const result = await processor.processNotification(makeBounceFeedback());

    expect(result.isOk()).toBe(true);
    expect(signalStore.updateSignalSendStatus).toHaveBeenCalledWith("acct-001", "USR#signal-001", {
      status: "draft",
      sendFailureReason: "all_recipients_bounced",
      sendInitiatedAt: null,
    });
  });

  it("does not revert original signal when only some recipients bounced (partial bounce)", async () => {
    vi.mocked(signalStore.getSignalByMessageId).mockResolvedValueOnce(ok(makeSentSignal({
      to: [{ address: "recipient@example.com" }, { address: "other@example.com" }],
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
    expect(savedSignal.bouncedRecipients).toEqual([
      { address: "recipient@example.com", bounceType: "transient", reason: "4.2.2" },
    ]);
    // Original NOT reverted — transient bounces don't trigger revert
    expect(signalStore.updateSignalSendStatus).not.toHaveBeenCalled();
  });
});
