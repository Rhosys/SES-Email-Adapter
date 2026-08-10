import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SQSEvent, SQSRecord, Context } from "aws-lambda";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the handler
// ---------------------------------------------------------------------------

const mockProcess = vi.fn().mockResolvedValue({ isOk: () => true, value: undefined });

vi.mock("../../src/external-exchanges/emx-idle-worker.js", () => ({
  EmxIdleWorker: vi.fn().mockImplementation(() => ({
    process: mockProcess,
  })),
}));

vi.mock("@aws-sdk/client-kms", () => ({ KMSClient: vi.fn() }));
vi.mock("../../src/database/account-database.js", () => ({
  AccountDatabase: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("../../src/messaging/signal-queue.js", () => ({
  SignalQueue: vi.fn().mockImplementation(() => ({})),
}));

const mockEncryptionInit = vi.fn();
vi.mock("../../src/secrets/encryption-manager.js", () => ({
  EncryptionManager: vi.fn().mockImplementation(() => ({ init: mockEncryptionInit })),
}));

const mockError = vi.fn();
const mockStartInvocation = vi.fn();
vi.mock("../../src/logger.js", () => ({
  RequestLogger: vi.fn().mockImplementation(() => ({
    startInvocation: mockStartInvocation,
    getInvocationId: vi.fn().mockReturnValue("test"),
    trackPoint: vi.fn(),
    info: vi.fn(),
    track: vi.fn(),
    warn: vi.fn(),
    error: mockError,
    critical: vi.fn(),
  })),
}));

// Import handler AFTER mocks are set up
const { handler } = await import("../../src/long-poller.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSqsRecord(body: string, messageType?: string): SQSRecord {
  return {
    messageId: "msg-001",
    receiptHandle: "receipt-001",
    body,
    attributes: {} as SQSRecord["attributes"],
    messageAttributes: messageType
      ? { messageType: { stringValue: messageType, dataType: "String" } }
      : {},
    md5OfBody: "",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:eu-central-1:123456789012:long-poller",
    awsRegion: "eu-central-1",
  };
}

function makeSqsEvent(records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

const fakeContext: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: "long-poller",
  functionVersion: "$LATEST",
  invokedFunctionArn: "arn:aws:lambda:eu-central-1:123456789012:function:long-poller",
  memoryLimitInMB: "128",
  awsRequestId: "req-001",
  logGroupName: "/aws/lambda/long-poller",
  logStreamName: "2025/01/01/[$LATEST]abc123",
  getRemainingTimeInMillis: () => 900000,
  done: vi.fn(),
  fail: vi.fn(),
  succeed: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("long-poller handler", () => {
  it("valid emx_idle payload calls EmxIdleWorker.process()", async () => {
    const record = makeSqsRecord(JSON.stringify({ accountId: "acc-1" }), "emx_idle");
    const event = makeSqsEvent([record]);

    const result = await handler(event, fakeContext);

    expect(mockProcess).toHaveBeenCalledWith({ accountId: "acc-1" });
    expect(result.batchItemFailures).toHaveLength(0);
  });

  it("malformed payload (missing accountId) logs ERROR and drops message", async () => {
    const record = makeSqsRecord(JSON.stringify({}), "emx_idle");
    const event = makeSqsEvent([record]);

    const result = await handler(event, fakeContext);

    expect(mockError).toHaveBeenCalledWith(
      "Long-poller received emx_idle without accountId",
      expect.objectContaining({ code: "long_poller.missing_account_id" }),
    );
    expect(mockProcess).not.toHaveBeenCalled();
    expect(result.batchItemFailures).toHaveLength(0);
  });
});
