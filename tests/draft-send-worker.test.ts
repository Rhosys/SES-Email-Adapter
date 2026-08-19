import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err, dbError } from "../src/errors.js";
import { DraftSendWorker } from "../src/processor/draft-send-worker.js";
import type { IDraftSendThreadDb } from "../src/processor/draft-send-worker.js";
import type { ReplySender } from "../src/processor/processor.js";
import type { DraftSendPayload } from "../src/processor/draft-send-dispatcher.js";
import type { Signal } from "../src/types/index.js";
import { createMockLogger } from "./helpers/mock-logger.js";

function makeSignal(overrides: { data?: Partial<Signal["data"]> } & Partial<Omit<Signal, "data">> = {}): Signal {
  const { data: dataOverrides, ...baseOverrides } = overrides;
  return {
    id: "USR#signal-001",
    signalLookupId: "USR#signal-001",
    threadId: "thr-001",
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
      tags: [],
      summary: "",
      s3Key: "",
      receivedAt: "2024-06-01T12:00:00.000Z",
      ...dataOverrides,
    },
  } as Signal;
}

function makeThreadDb(): IDraftSendThreadDb {
  return {
    getSignalById: vi.fn().mockResolvedValue(ok(makeSignal())),
    updateSignalSendStatus: vi.fn().mockResolvedValue(ok(makeSignal({ status: "sent" }))),
  };
}

function makeReplySender(): ReplySender {
  return {
    sendReply: vi.fn().mockResolvedValue(ok({ messageId: "ses-msg-001", outboundMsgId: "ses-msg-001@eu-central-1.amazonses.com" })),
  };
}

const PAYLOAD: DraftSendPayload = {
  signalId: "USR#signal-001",
  accountId: "acct-001",
  threadId: "thr-001",
  sendInitiatedAt: "2024-06-01T12:00:00.000Z",
};

describe("DraftSendWorker", () => {
  let threadDb: IDraftSendThreadDb;
  let replySender: ReplySender;
  let worker: DraftSendWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    threadDb = makeThreadDb();
    replySender = makeReplySender();
    worker = new DraftSendWorker(threadDb, replySender, createMockLogger());
  });

  it("discards when signal not found (returns ok)", async () => {
    vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(null));

    const result = await worker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(replySender.sendReply).not.toHaveBeenCalled();
    expect(threadDb.updateSignalSendStatus).not.toHaveBeenCalled();
  });

  it("discards when signal status is no longer pending_send", async () => {
    vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(makeSignal({ status: "draft" })));

    const result = await worker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(replySender.sendReply).not.toHaveBeenCalled();
  });

  it("discards when sendInitiatedAt does not match payload (stale message)", async () => {
    vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(makeSignal({ data: { sendInitiatedAt: "2024-06-01T13:00:00.000Z" } })));

    const result = await worker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(replySender.sendReply).not.toHaveBeenCalled();
  });

  it("sends email and updates status to sent on success (no linkedSignalId — no In-Reply-To)", async () => {
    const result = await worker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(replySender.sendReply).toHaveBeenCalledWith({
      to: "recipient@example.com",
      from: "me@example.com",
      subject: "Hello",
      body: "Hi there",
      accountId: "acct-001",
      signalId: "USR#signal-001",
      threadId: "thr-001",
    });
    expect(threadDb.updateSignalSendStatus).toHaveBeenCalledWith("acct-001", "USR#signal-001", {
      status: "sent",
      sentAt: expect.any(String),
      sesMessageId: "ses-msg-001",
      gsi3pk: "ACCT#acct-001#MSGID#ses-msg-001@eu-central-1.amazonses.com",
      threadId: "thr-001",
    });
  });

  // threadId now always comes from the dispatch payload (DraftSendPayload.threadId: string,
  // required — it's the DynamoDB GSI1 partition key getSignalById queried with, so the
  // returned signal can only ever belong to that threadId). There is no longer a code path
  // where it's omitted; the old "signal has no threadId" branch was dead defensive code
  // reading a weaker, coincidentally-optional field off the fetched signal instead of the
  // value already guaranteed non-empty by the payload's type.

  describe("In-Reply-To resolution from linkedSignalId", () => {
    it("resolves In-Reply-To from the linked signal's Message-ID header", async () => {
      vi.mocked(threadDb.getSignalById)
        .mockResolvedValueOnce(ok(makeSignal({ data: { linkedSignalId: "USR#linked-001" } })))
        .mockResolvedValueOnce(ok(makeSignal({
          id: "USR#linked-001",
          data: { headers: { "message-id": "<abc123@mail.example.com>" } },
        })));

      const result = await worker.process(PAYLOAD);

      expect(result.isOk()).toBe(true);
      expect(threadDb.getSignalById).toHaveBeenNthCalledWith(2, "acct-001", "USR#linked-001", "thr-001");
      expect(replySender.sendReply).toHaveBeenCalledWith(expect.objectContaining({
        inReplyTo: "<abc123@mail.example.com>",
      }));
    });

    it("omits In-Reply-To and logs an error when the linked signal is not found", async () => {
      const logger = createMockLogger();
      const localWorker = new DraftSendWorker(threadDb, replySender, logger);
      vi.mocked(threadDb.getSignalById)
        .mockResolvedValueOnce(ok(makeSignal({ data: { linkedSignalId: "USR#missing-001" } })))
        .mockResolvedValueOnce(ok(null));

      const result = await localWorker.process(PAYLOAD);

      expect(result.isOk()).toBe(true);
      expect(replySender.sendReply).toHaveBeenCalledWith(expect.not.objectContaining({ inReplyTo: expect.anything() }));
      expect(logger.calls.some(c => c.method === "error" && c.context?.code === "draft_send.linked_signal_not_found")).toBe(true);
    });

    it("omits In-Reply-To and logs a warning when the linked signal has no Message-ID header", async () => {
      const logger = createMockLogger();
      const localWorker = new DraftSendWorker(threadDb, replySender, logger);
      vi.mocked(threadDb.getSignalById)
        .mockResolvedValueOnce(ok(makeSignal({ data: { linkedSignalId: "USR#linked-001" } })))
        .mockResolvedValueOnce(ok(makeSignal({ id: "USR#linked-001", data: { headers: {} } })));

      const result = await localWorker.process(PAYLOAD);

      expect(result.isOk()).toBe(true);
      expect(replySender.sendReply).toHaveBeenCalledWith(expect.not.objectContaining({ inReplyTo: expect.anything() }));
      expect(logger.calls.some(c => c.method === "warn" && c.context?.code === "draft_send.linked_signal_no_message_id")).toBe(true);
    });
  });

  it("joins multiple recipients in the to field", async () => {
    vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(makeSignal({
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
    expect(threadDb.updateSignalSendStatus).not.toHaveBeenCalled();
  });

  it("propagates store error when getSignal fails", async () => {
    vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(err(dbError("connection lost")));

    const result = await worker.process(PAYLOAD);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("db_error");
  });

  it("propagates store error when updateSignalSendStatus fails after send", async () => {
    vi.mocked(threadDb.updateSignalSendStatus).mockResolvedValueOnce(err(dbError("write failed")));

    const result = await worker.process(PAYLOAD);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("db_error");
  });

  it("returns ok and logs WARN on permanent SES error — no retry", async () => {
    const logger = createMockLogger();
    const localWorker = new DraftSendWorker(threadDb, replySender, logger);
    vi.mocked(replySender.sendReply).mockResolvedValueOnce(err({ kind: "permanent_ses_error", errorName: "MessageRejected", httpStatus: 400, message: "Email address is not verified", cause: new Error("test") }));

    const result = await localWorker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(logger.calls.some(c => c.method === "warn" && c.context?.code === "draft_send.send_permanent")).toBe(true);
    // Parked back as a draft with the reason, rather than left stuck in pending_send —
    // the send will never succeed on retry, so the user has to be able to see and fix it.
    expect(threadDb.updateSignalSendStatus).toHaveBeenCalledWith("acct-001", "USR#signal-001", expect.objectContaining({
      status: "draft",
      sendInitiatedAt: null,
      sendFailureReason: expect.stringContaining("MessageRejected"),
    }));
  });

  it("parks the draft with a reconnect prompt when the mailbox lacks the send scope", async () => {
    const logger = createMockLogger();
    const localWorker = new DraftSendWorker(threadDb, replySender, logger);
    vi.mocked(replySender.sendReply).mockResolvedValueOnce(err({ kind: "provider_send_scope_missing", cause: "insufficient permissions" }));

    const result = await localWorker.process(PAYLOAD);

    expect(result.isOk()).toBe(true);
    expect(threadDb.updateSignalSendStatus).toHaveBeenCalledWith("acct-001", "USR#signal-001", expect.objectContaining({
      status: "draft",
      sendFailureReason: expect.stringContaining("Reconnect the mailbox"),
    }));
  });

  it("retries a transient provider failure rather than parking the draft", async () => {
    const localWorker = new DraftSendWorker(threadDb, replySender, createMockLogger());
    vi.mocked(replySender.sendReply).mockResolvedValueOnce(err({ kind: "provider_send_failed", cause: "503" }));

    const result = await localWorker.process(PAYLOAD);

    expect(result.isErr()).toBe(true);
    expect(threadDb.updateSignalSendStatus).not.toHaveBeenCalled();
  });
});
