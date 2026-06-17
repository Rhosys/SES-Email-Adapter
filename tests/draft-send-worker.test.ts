import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err, dbError } from "../src/errors.js";
import { DraftSendWorker } from "../src/processor/draft-send-worker.js";
import type { DraftSendStore } from "../src/processor/draft-send-worker.js";
import type { ReplySender } from "../src/processor/processor.js";
import type { DraftSendPayload } from "../src/processor/draft-send-dispatcher.js";
import type { Signal } from "../src/types/index.js";
import { createMockLogger } from "./helpers/mock-logger.js";

function makeSignal(overrides: { data?: Partial<Signal["data"]> } & Partial<Omit<Signal, "data">> = {}): Signal {
  const { data: dataOverrides, ...baseOverrides } = overrides;
  return {
    id: "USR#signal-001",
    signalLookupId: "USR#signal-001",
    arcId: "arc-001",
    accountId: "acct-001",
    source: "user",
    type: "email",
    status: "pending_send",
    createdAt: "2024-06-01T12:00:00.000Z",
    ...baseOverrides,
    data: {
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
      s3Key: "",
      receivedAt: "2024-06-01T12:00:00.000Z",
      ...dataOverrides,
    },
  } as Signal;
}

function makeStore(): DraftSendStore {
  return {
    getSignalById: vi.fn().mockResolvedValue(ok(makeSignal())),
    updateSignalSendStatus: vi.fn().mockResolvedValue(ok(makeSignal({ status: "sent" }))),
    getArc: vi.fn().mockResolvedValue(ok({ id: "arc-001", accountId: "acct-001", status: "active" })),
    updateArcStatus: vi.fn().mockResolvedValue(ok(undefined)),
    getAccountAfterSendAction: vi.fn().mockResolvedValue(ok("keep_active" as const)),
  };
}

function makeReplySender(): ReplySender {
  return {
    sendReply: vi.fn().mockResolvedValue(ok({ messageId: "ses-msg-001" })),
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
    vi.mocked(store.getSignalById).mockResolvedValueOnce(ok(null));

    const result = await worker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(replySender.sendReply).not.toHaveBeenCalled();
    expect(store.updateSignalSendStatus).not.toHaveBeenCalled();
  });

  it("discards when signal status is no longer pending_send", async () => {
    vi.mocked(store.getSignalById).mockResolvedValueOnce(ok(makeSignal({ status: "draft" })));

    const result = await worker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(replySender.sendReply).not.toHaveBeenCalled();
  });

  it("discards when sendInitiatedAt does not match payload (stale message)", async () => {
    vi.mocked(store.getSignalById).mockResolvedValueOnce(ok(makeSignal({ data: { sendInitiatedAt: "2024-06-01T13:00:00.000Z" } })));

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
      accountId: "acct-001",
      signalId: "USR#signal-001",
      arcId: "arc-001",
    });
    expect(store.updateSignalSendStatus).toHaveBeenCalledWith("acct-001", "USR#signal-001", {
      status: "sent",
      sentAt: expect.any(String),
      sesMessageId: "ses-msg-001",
      gsi2pk: "ACCT#acct-001#MSGID#ses-msg-001@eu-central-1.amazonses.com",
    });
  });

  it("omits arcId from sendReply opts when signal has no arcId", async () => {
    const signalWithoutArc = makeSignal();
    delete signalWithoutArc.arcId;
    vi.mocked(store.getSignalById).mockResolvedValueOnce(ok(signalWithoutArc));

    const result = await worker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(replySender.sendReply).toHaveBeenCalledWith({
      to: "recipient@example.com",
      from: "me@example.com",
      subject: "Hello",
      body: "Hi there",
      inReplyTo: "",
      accountId: "acct-001",
      signalId: "USR#signal-001",
    });
  });

  it("joins multiple recipients in the to field", async () => {
    vi.mocked(store.getSignalById).mockResolvedValueOnce(ok(makeSignal({
      data: { to: [{ address: "a@example.com" }, { address: "b@example.com" }] },
    })));

    const result = await worker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(replySender.sendReply).toHaveBeenCalledWith(
      expect.objectContaining({ to: "a@example.com, b@example.com" }),
    );
  });

  it("returns err on transient SES error so SQS retries", async () => {
    const transientError = { kind: "transient_ses_error" as const, errorName: "ServiceUnavailable", httpStatus: 500, cause: new Error("service unavailable") };
    vi.mocked(replySender.sendReply).mockResolvedValueOnce(err(transientError));

    const result = await worker.process(PAYLOAD);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("transient_ses_error");
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
    vi.mocked(store.getSignalById).mockResolvedValueOnce(err(dbError("connection lost")));

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
