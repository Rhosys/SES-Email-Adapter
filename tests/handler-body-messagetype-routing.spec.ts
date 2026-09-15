import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "aws-lambda";
import { ok, err, dbError } from "../src/errors.js";

// Env vars required by handler.ts at module load time
process.env["MAIL_DOMAIN"] = "platform.email.rhosys.cloud";
process.env["SES_CONFIGURATION_SET_ARN"] = "arn:aws:ses:eu-west-1:123456789012:configuration-set/test-config-set";

// ---------------------------------------------------------------------------
// Mock heavy dependencies so the handler module can load without real AWS SDK.
// Only the four Scheduler-driven workers under test get spy-backed mocks;
// everything else is a bare stub — same pattern as handler-followup-routing.spec.ts.
// ---------------------------------------------------------------------------

const mockFollowupProcess = vi.fn();
const mockRsvpReminderProcess = vi.fn();
const mockDigestDispatch = vi.fn();
const mockEmxDispatch = vi.fn();

vi.mock("../src/scheduler/followup-handler.js", () => ({
  FollowupHandler: vi.fn().mockImplementation(() => ({ process: mockFollowupProcess })),
}));

vi.mock("../src/scheduler/rsvp-reminder-handler.js", () => ({
  RsvpReminderHandler: vi.fn().mockImplementation(() => ({ process: mockRsvpReminderProcess })),
}));

vi.mock("../src/digest/digest-dispatcher.js", () => ({
  DigestDispatcher: vi.fn().mockImplementation(() => ({ dispatch: mockDigestDispatch })),
}));

vi.mock("../src/external-exchanges/emx-dispatch-worker.js", () => ({
  EmxDispatchWorker: vi.fn().mockImplementation(() => ({ dispatch: mockEmxDispatch })),
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

vi.mock("../src/processor/incoming-email-processor.js", () => ({
  IncomingEmailProcessor: vi.fn().mockImplementation(() => ({})),
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

vi.mock("../src/database/thread-database.js", () => ({
  ThreadDatabase: vi.fn().mockImplementation(() => ({
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

vi.mock("../src/notifier/ses-feedback-processor.js", () => ({
  SesFeedbackProcessor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/jobs/domain-health-job.js", () => ({
  DomainHealthJob: vi.fn().mockImplementation(() => ({ run: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock("../src/embedding/embedding-generator.js", () => ({
  BedrockEmbeddingGenerator: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/database/thread-matcher.js", () => ({
  createSearchDatabase: () => ({ upsertEmbedding: vi.fn().mockResolvedValue({ isOk: () => true, value: undefined }) }),
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
// Helpers — EventBridge Scheduler → SQS messages never carry SQS message
// attributes (AWS limitation: SqsParameters only supports MessageGroupId), so
// these records have none. Routing must fall back to
// `body.sqsMessageAttributeMessageType`.
// ---------------------------------------------------------------------------

function makeSchedulerSqsRecord(body: unknown) {
  return {
    messageId: "msg-scheduler-1",
    receiptHandle: "handle",
    body: JSON.stringify(body),
    attributes: { ApproximateReceiveCount: "1" } as Record<string, string>,
    messageAttributes: {},
    md5OfBody: "abc",
    eventSource: "aws:sqs" as const,
    eventSourceARN: "arn:aws:sqs:eu-central-1:123:signals",
    awsRegion: "eu-central-1",
  };
}

function makeSqsEvent(records: ReturnType<typeof makeSchedulerSqsRecord>[]) {
  return { Records: records };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Handler: body.sqsMessageAttributeMessageType fallback routing (EventBridge Scheduler messages)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes body.sqsMessageAttributeMessageType 'emx_dispatch' to EmxDispatchWorker.dispatch()", async () => {
    const body = { sqsMessageAttributeMessageType: "emx_dispatch" };
    mockEmxDispatch.mockResolvedValue(ok(undefined));

    const event = makeSqsEvent([makeSchedulerSqsRecord(body)]);
    const result = await handler(event, dummyContext) as { batchItemFailures: Array<{ itemIdentifier: string }> };

    expect(mockEmxDispatch).toHaveBeenCalledOnce();
    expect(mockEmxDispatch).toHaveBeenCalledWith(body);
    expect(result.batchItemFailures).toHaveLength(0);
  });

  it("routes body.sqsMessageAttributeMessageType 'digest_dispatch' to DigestDispatcher.dispatch()", async () => {
    mockDigestDispatch.mockResolvedValue(ok(undefined));

    const event = makeSqsEvent([makeSchedulerSqsRecord({ sqsMessageAttributeMessageType: "digest_dispatch" })]);
    const result = await handler(event, dummyContext) as { batchItemFailures: Array<{ itemIdentifier: string }> };

    expect(mockDigestDispatch).toHaveBeenCalledOnce();
    expect(result.batchItemFailures).toHaveLength(0);
  });

  it("routes body.sqsMessageAttributeMessageType 'signal_followup' to FollowupHandler.process()", async () => {
    const body = { sqsMessageAttributeMessageType: "signal_followup", accountId: "acc-123", threadId: "arc-789" };
    mockFollowupProcess.mockResolvedValue(ok(undefined));

    const event = makeSqsEvent([makeSchedulerSqsRecord(body)]);
    const result = await handler(event, dummyContext) as { batchItemFailures: Array<{ itemIdentifier: string }> };

    expect(mockFollowupProcess).toHaveBeenCalledOnce();
    expect(mockFollowupProcess).toHaveBeenCalledWith(body);
    expect(result.batchItemFailures).toHaveLength(0);
  });

  it("routes body.sqsMessageAttributeMessageType 'rsvp_reminder' to RsvpReminderHandler.process()", async () => {
    const body = { sqsMessageAttributeMessageType: "rsvp_reminder", accountId: "acc-123", calendarSignalId: "sig-456", threadId: "arc-789" };
    mockRsvpReminderProcess.mockResolvedValue(ok(undefined));

    const event = makeSqsEvent([makeSchedulerSqsRecord(body)]);
    const result = await handler(event, dummyContext) as { batchItemFailures: Array<{ itemIdentifier: string }> };

    expect(mockRsvpReminderProcess).toHaveBeenCalledOnce();
    expect(mockRsvpReminderProcess).toHaveBeenCalledWith(body);
    expect(result.batchItemFailures).toHaveLength(0);
  });

  it("a message attribute takes precedence over body.sqsMessageAttributeMessageType when both are present", async () => {
    const record = makeSchedulerSqsRecord({ sqsMessageAttributeMessageType: "digest_dispatch" });
    record.messageAttributes = { messageType: { stringValue: "emx_dispatch", dataType: "String" } } as never;
    mockEmxDispatch.mockResolvedValue(ok(undefined));

    const event = makeSqsEvent([record]);
    await handler(event, dummyContext);

    expect(mockEmxDispatch).toHaveBeenCalledOnce();
    expect(mockDigestDispatch).not.toHaveBeenCalled();
  });

  it("neither a message attribute nor a recognized body field present — unrecognized body is dropped, not retried", async () => {
    // Regression guard: a body using the wrong field name (e.g. `messageType` instead
    // of `sqsMessageAttributeMessageType`) must not silently resolve — this is exactly
    // the shape that caused emx_dispatch/digest_dispatch messages to be dropped.
    const event = makeSqsEvent([makeSchedulerSqsRecord({ messageType: "emx_dispatch" })]);
    const result = await handler(event, dummyContext) as { batchItemFailures: Array<{ itemIdentifier: string }> };

    expect(mockEmxDispatch).not.toHaveBeenCalled();
    expect(mockDigestDispatch).not.toHaveBeenCalled();
    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("not a recognized SNS envelope"),
      expect.objectContaining({ code: "handler.sqs.unrecognized_body_format" }),
    );
  });

  it("worker error adds message to batchItemFailures for retry", async () => {
    mockEmxDispatch.mockResolvedValue(err(dbError("DynamoDB timeout") as never));

    const event = makeSqsEvent([makeSchedulerSqsRecord({ sqsMessageAttributeMessageType: "emx_dispatch" })]);
    const result = await handler(event, dummyContext) as { batchItemFailures: Array<{ itemIdentifier: string }> };

    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0]!.itemIdentifier).toBe("msg-scheduler-1");
  });
});
