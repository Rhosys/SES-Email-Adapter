import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "aws-lambda";
import { ok, err, dbError } from "../src/errors.js";

// Env vars required by handler.ts at module load time
process.env["MAIL_DOMAIN"] = "platform.email.rhosys.cloud";
process.env["SES_CONFIGURATION_SET_ARN"] = "arn:aws:ses:eu-west-1:123456789012:configuration-set/test-config-set";

// ---------------------------------------------------------------------------
// Mock heavy dependencies so the handler module can load without real AWS SDK
// ---------------------------------------------------------------------------

const mockFollowupProcess = vi.fn();

vi.mock("../src/scheduler/followup-handler.js", () => ({
  FollowupHandler: vi.fn().mockImplementation(() => ({
    process: mockFollowupProcess,
  })),
}));

vi.mock("../src/onboarding/onboarding-task-handler.js", () => ({
  OnboardingTaskHandler: vi.fn().mockImplementation(() => ({
    handleFollowup: vi.fn(),
    handleCleanup: vi.fn(),
    handleTrialCheck: vi.fn(),
  })),
}));

vi.mock("../src/onboarding/account-creation-starter.js", () => ({
  SfnAccountCreationStarter: vi.fn().mockImplementation(() => ({ start: vi.fn() })),
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({})),
  GetObjectCommand: vi.fn(),
}));

vi.mock("@aws-sdk/client-sfn", () => ({
  SFNClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  SendEmailCommand: vi.fn(),
}));

vi.mock("@aws-sdk/client-apigatewaymanagementapi", () => ({
  ApiGatewayManagementApiClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/classifier/classifier.js", () => ({
  SignalClassifier: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/processor/processor.js", () => ({
  SignalProcessor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/processor/sqs-dispatcher.js", () => ({
  SqsDispatcherImpl: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/processor/mime.js", () => ({
  MailparserMimeParser: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/processor/rule-evaluator.js", () => ({
  JsonLogicRuleEvaluator: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/database/account-database.js", () => ({
  AccountDatabase: vi.fn().mockImplementation(() => ({
    getAccount: vi.fn(),
    updateAccount: vi.fn(),
    listDomains: vi.fn(),
  })),
}));

vi.mock("../src/database/arc-database.js", () => ({
  ArcDatabase: vi.fn().mockImplementation(() => ({
    hasSignals: vi.fn(),
    getSignalById: vi.fn(),
    getSignalByMessageId: vi.fn(),
    saveSignal: vi.fn(),
    updateSignalSendStatus: vi.fn(),
    getArc: vi.fn(),
    updateArc: vi.fn(),
  })),
}));

vi.mock("../src/database/processing-database.js", () => ({
  ProcessingDatabase: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/database/audit-database.js", () => ({
  AuditDatabase: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/notifier/device-notifier.js", () => ({
  DeviceNotifier: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/notifier/ws-deliverer.js", () => ({
  WsDeliverer: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/notifier/fcm-deliverer.js", () => ({
  FcmDeliverer: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/notifier/fcm-client.js", () => ({
  HttpFcmClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/notifier/device-store.js", () => ({
  DynamoDeviceStore: vi.fn().mockImplementation(() => ({
    saveDevice: vi.fn(),
    deleteDevice: vi.fn(),
  })),
}));

vi.mock("../src/notifier/feedback-processor.js", () => ({
  FeedbackProcessor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/jobs/domain-health-job.js", () => ({
  DomainHealthJob: vi.fn().mockImplementation(() => ({ run: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock("../src/embedding/embedding-generator.js", () => ({
  BedrockEmbeddingGenerator: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/database/multi-cluster-aurora-writer.js", () => ({
  multiClusterWriter: {},
}));

vi.mock("../src/embedding/s3-retention-service.js", () => ({
  S3RetentionServiceImpl: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/jobs/reindex/reindex-worker.js", () => ({
  ReindexWorker: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/jobs/reindex/reindex-dispatcher.js", () => ({
  ReindexDispatcher: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/api/authress-auth.js", () => ({
  AuthressAuthService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/api/authress-access.js", () => ({
  AuthressAccessService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/api/app.js", () => ({
  createApp: vi.fn().mockReturnValue({ fetch: vi.fn() }),
}));

const mockLogger = {
  startInvocation: vi.fn(),
  getInvocationId: vi.fn().mockReturnValue("test-invocation-id"),
  trackPoint: vi.fn(),
  info: vi.fn(),
  track: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  critical: vi.fn(),
};

vi.mock("../src/logger.js", () => ({
  RequestLogger: vi.fn().mockImplementation(() => mockLogger),
}));

// ---------------------------------------------------------------------------
// Import handler AFTER mocks are set up
// ---------------------------------------------------------------------------

const { handler } = await import("../src/handler.js");

const dummyContext: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: "test",
  functionVersion: "1",
  invokedFunctionArn: "arn:aws:lambda:eu-central-1:123:function:test",
  memoryLimitInMB: "128",
  awsRequestId: "req-1",
  logGroupName: "/aws/lambda/test",
  logStreamName: "stream",
  getRemainingTimeInMillis: () => 30000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSqsRecord(body: unknown, messageType?: string) {
  return {
    messageId: "msg-followup-1",
    receiptHandle: "handle",
    body: JSON.stringify(body),
    attributes: { ApproximateReceiveCount: "1" } as Record<string, string>,
    messageAttributes: messageType
      ? { messageType: { stringValue: messageType, dataType: "String" } }
      : {},
    md5OfBody: "abc",
    eventSource: "aws:sqs" as const,
    eventSourceARN: "arn:aws:sqs:eu-central-1:123:signals",
    awsRegion: "eu-central-1",
  };
}

function makeSqsEvent(records: ReturnType<typeof makeSqsRecord>[]) {
  return { Records: records };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Handler: signal_followup SQS routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes messageType signal_followup to FollowupHandler.process()", async () => {
    const body = { accountId: "acc-123", signalId: "sgn-456", arcId: "arc-789" };
    mockFollowupProcess.mockResolvedValue(ok(undefined));

    const event = makeSqsEvent([makeSqsRecord(body, "signal_followup")]);
    const result = await handler(event, dummyContext) as { batchItemFailures: Array<{ itemIdentifier: string }> };

    expect(mockFollowupProcess).toHaveBeenCalledOnce();
    expect(mockFollowupProcess).toHaveBeenCalledWith(body);
    expect(result.batchItemFailures).toHaveLength(0);
  });

  it("malformed body (missing required fields) is discarded without adding to batchItemFailures", async () => {
    const malformedBody = { accountId: "acc-123" }; // missing signalId and arcId
    mockFollowupProcess.mockResolvedValue(ok(undefined));

    const event = makeSqsEvent([makeSqsRecord(malformedBody, "signal_followup")]);
    const result = await handler(event, dummyContext) as { batchItemFailures: Array<{ itemIdentifier: string }> };

    // Handler detects missing fields and discards — does NOT call followupHandler.process()
    expect(mockFollowupProcess).not.toHaveBeenCalled();
    // Discarded = not added to batchItemFailures (no retry)
    expect(result.batchItemFailures).toHaveLength(0);
    // Should log ERROR about malformed payload
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("Malformed signal_followup"),
      expect.objectContaining({ code: "handler.sqs.malformed_followup" }),
    );
  });

  it("handler error adds message to batchItemFailures for retry", async () => {
    const body = { accountId: "acc-123", signalId: "sgn-456", arcId: "arc-789" };
    mockFollowupProcess.mockResolvedValue(err(dbError("DynamoDB timeout")));

    const event = makeSqsEvent([makeSqsRecord(body, "signal_followup")]);
    const result = await handler(event, dummyContext) as { batchItemFailures: Array<{ itemIdentifier: string }> };

    expect(mockFollowupProcess).toHaveBeenCalledOnce();
    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0]!.itemIdentifier).toBe("msg-followup-1");
  });
});
