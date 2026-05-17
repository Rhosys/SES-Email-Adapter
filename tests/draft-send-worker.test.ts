import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err, dbError } from "../src/errors.js";
import { DraftSendWorker } from "../src/processor/draft-send-worker.js";
import type { DraftSendStore } from "../src/processor/draft-send-worker.js";
import type { ReplySender } from "../src/processor/processor.js";
import type { DraftSendPayload } from "../src/processor/draft-send-dispatcher.js";
import type { Signal } from "../src/types/index.js";
import { createMockLogger } from "./helpers/mock-logger.js";

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "USR#signal-001",
    arcId: "arc-001",
    accountId: "acct-001",
    source: "user",
    status: "pending_send",
    sendInitiatedAt: "2024-06-01T12:00:00.000Z",
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

function makeStore(): DraftSendStore {
  return {
    getSignal: vi.fn().mockResolvedValue(ok(makeSignal())),
    updateSignalSendStatus: vi.fn().mockResolvedValue(ok(makeSignal({ status: "sent" }))),
    getArc: vi.fn().mockResolvedValue(ok({ id: "arc-001", accountId: "acct-001", status: "active" })),
    updateArcStatus: vi.fn().mockResolvedValue(ok(undefined)),
    getAccountAfterSendAction: vi.fn().mockResolvedValue(ok("keep_active" as const)),
  };
}

function makeReplySender(): ReplySender {
  return {
    sendReply: vi.fn().mockResolvedValue({ messageId: "ses-msg-001" }),
  };
}

const PAYLOAD: DraftSendPayload = {
  signalId: "USR#signal-001",
  accountId: "acct-001",
  sendInitiatedAt: "2024-06-01T12:00:00.000Z",
};

describe("DraftSendWorker", () => {
  let store: DraftSendStore;
  let replySender: ReplySender;
  let worker: DraftSendWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
    replySender = makeReplySender();
    worker = new DraftSendWorker(store, replySender, createMockLogger());
  });

  it("discards when signal not found (returns ok)", async () => {
    vi.mocked(store.getSignal).mockResolvedValueOnce(ok(null));

    const result = await worker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(replySender.sendReply).not.toHaveBeenCalled();
    expect(store.updateSignalSendStatus).not.toHaveBeenCalled();
  });

  it("discards when signal status is no longer pending_send", async () => {
    vi.mocked(store.getSignal).mockResolvedValueOnce(ok(makeSignal({ status: "draft" })));

    const result = await worker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(replySender.sendReply).not.toHaveBeenCalled();
  });

  it("discards when sendInitiatedAt does not match payload (stale message)", async () => {
    vi.mocked(store.getSignal).mockResolvedValueOnce(ok(makeSignal({ sendInitiatedAt: "2024-06-01T13:00:00.000Z" })));

    const result = await worker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(replySender.sendReply).not.toHaveBeenCalled();
  });

  it("sends email and updates status to sent on success", async () => {
    const result = await worker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(replySender.sendReply).toHaveBeenCalledWith({
      to: "recipient@example.com",
      from: "me@example.com",
      subject: "Hello",
      body: "Hi there",
      inReplyTo: "arc-001",
    });
    expect(store.updateSignalSendStatus).toHaveBeenCalledWith("acct-001", "USR#signal-001", {
      status: "sent",
      sentAt: expect.any(String),
      sesMessageId: "ses-msg-001",
    });
  });

  it("joins multiple recipients in the to field", async () => {
    vi.mocked(store.getSignal).mockResolvedValueOnce(ok(makeSignal({
      to: [{ address: "a@example.com" }, { address: "b@example.com" }],
    })));

    const result = await worker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(replySender.sendReply).toHaveBeenCalledWith(
      expect.objectContaining({ to: "a@example.com, b@example.com" }),
    );
  });

  it("reverts to draft on permanent SES error (MessageRejected)", async () => {
    const sesError = Object.assign(new Error("rejected"), { name: "MessageRejected", $metadata: { httpStatusCode: 400 } });
    vi.mocked(replySender.sendReply).mockRejectedValueOnce(sesError);

    const result = await worker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(store.updateSignalSendStatus).toHaveBeenCalledWith("acct-001", "USR#signal-001", {
      status: "draft",
      sendInitiatedAt: null,
      sendFailureReason: "ses_permanent_failure",
    });
  });

  it("reverts to draft on permanent SES error (AccountSendingPausedException)", async () => {
    const sesError = Object.assign(new Error("paused"), { name: "AccountSendingPausedException", $metadata: { httpStatusCode: 400 } });
    vi.mocked(replySender.sendReply).mockRejectedValueOnce(sesError);

    const result = await worker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(store.updateSignalSendStatus).toHaveBeenCalledWith("acct-001", "USR#signal-001", {
      status: "draft",
      sendInitiatedAt: null,
      sendFailureReason: "ses_permanent_failure",
    });
  });

  it("reverts to draft on 4xx HTTP status (permanent)", async () => {
    const sesError = Object.assign(new Error("bad request"), { name: "SomeOtherError", $metadata: { httpStatusCode: 403 } });
    vi.mocked(replySender.sendReply).mockRejectedValueOnce(sesError);

    const result = await worker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(store.updateSignalSendStatus).toHaveBeenCalledWith("acct-001", "USR#signal-001", {
      status: "draft",
      sendInitiatedAt: null,
      sendFailureReason: "ses_permanent_failure",
    });
  });

  it("returns err on transient SES error (5xx) so SQS retries", async () => {
    const sesError = Object.assign(new Error("service unavailable"), { name: "ServiceUnavailable", $metadata: { httpStatusCode: 500 } });
    vi.mocked(replySender.sendReply).mockRejectedValueOnce(sesError);

    const result = await worker.process(PAYLOAD);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("db_error");
    expect(store.updateSignalSendStatus).not.toHaveBeenCalled();
  });

  it("returns err on network error (no httpStatusCode) so SQS retries", async () => {
    const networkError = new Error("ECONNRESET");
    vi.mocked(replySender.sendReply).mockRejectedValueOnce(networkError);

    const result = await worker.process(PAYLOAD);

    expect(result.isErr()).toBe(true);
    expect(store.updateSignalSendStatus).not.toHaveBeenCalled();
  });

  it("archives arc after successful send when afterSendAction is 'archive'", async () => {
    vi.mocked(store.getAccountAfterSendAction).mockResolvedValueOnce(ok("archive" as const));

    const result = await worker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(store.getAccountAfterSendAction).toHaveBeenCalledWith("acct-001");
    expect(store.updateArcStatus).toHaveBeenCalledWith("acct-001", "arc-001", "archived");
  });

  it("does not archive arc when afterSendAction is 'keep_active'", async () => {
    vi.mocked(store.getAccountAfterSendAction).mockResolvedValueOnce(ok("keep_active" as const));

    const result = await worker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(store.updateArcStatus).not.toHaveBeenCalled();
  });

  it("propagates store error when getSignal fails", async () => {
    vi.mocked(store.getSignal).mockResolvedValueOnce(err(dbError("connection lost")));

    const result = await worker.process(PAYLOAD);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("db_error");
  });

  it("propagates store error when updateSignalSendStatus fails after send", async () => {
    vi.mocked(store.updateSignalSendStatus).mockResolvedValueOnce(err(dbError("write failed")));

    const result = await worker.process(PAYLOAD);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("db_error");
  });
});
