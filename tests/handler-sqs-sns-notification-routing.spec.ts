/**
 * Regression test for handler.ts processSqsRecord's SNS envelope routing.
 *
 * Bug: SES "Delivery" notifications (sent to the same SNS topic as Bounce/Complaint
 * feedback, see SesFeedback.notificationType) were not matched by the
 * Bounce/Complaint check, so they fell through to the inbound-receipt unwrap path
 * which assumes `receipt.action.objectKey` exists. Delivery notifications have no
 * `receipt` field at all, so `receipt.action` threw:
 *   TypeError: Cannot read properties of undefined (reading 'action')
 *
 * Fix: route "Delivery" through feedbackProcessor like Bounce/Complaint, and guard
 * the inbound-receipt path against any other unrecognised notification shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "aws-lambda";

// Env vars required by handler.ts at module load time
process.env["MAIL_DOMAIN"] = "platform.email.rhosys.cloud";
process.env["SES_CONFIGURATION_SET_ARN"] = "arn:aws:ses:eu-west-1:123456789012:configuration-set/test-config-set";

// ---------------------------------------------------------------------------
// Mock heavy dependencies so the handler module can load without real AWS SDK
// ---------------------------------------------------------------------------

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

const mockProcessRecord = vi.fn().mockResolvedValue({ isOk: () => true, isErr: () => false, value: undefined });
vi.mock("../src/processor/processor.js", () => ({
  SignalProcessor: vi.fn().mockImplementation(() => ({
    processRecord: mockProcessRecord,
  })),
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

const mockProcessNotification = vi.fn().mockResolvedValue({ isOk: () => true, isErr: () => false, value: undefined });
vi.mock("../src/notifier/feedback-processor.js", () => ({
  FeedbackProcessor: vi.fn().mockImplementation(() => ({
    processNotification: mockProcessNotification,
  })),
}));

vi.mock("../src/jobs/domain-health-job.js", () => ({
  DomainHealthJob: vi.fn().mockImplementation(() => ({ run: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock("../src/jobs/healthcheck-job.js", () => ({
  HealthcheckJob: vi.fn().mockImplementation(() => ({ run: vi.fn().mockResolvedValue(undefined) })),
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
// Helpers
// ---------------------------------------------------------------------------

function makeSqsEvent(snsMessage: unknown) {
  return {
    Records: [{
      messageId: "msg-1",
      receiptHandle: "handle",
      body: JSON.stringify({ Message: JSON.stringify(snsMessage) }),
      attributes: { ApproximateReceiveCount: "1" } as Record<string, string>,
      messageAttributes: {},
      md5OfBody: "abc",
      eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:eu-central-1:123:queue",
      awsRegion: "eu-central-1",
    }],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Handler: SQS/SNS notificationType routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Delivery notification → routed to feedbackProcessor, no crash", async () => {
    const event = makeSqsEvent({
      notificationType: "Delivery",
      mail: { messageId: "ses-msg-1", source: "user@example.com", tags: {} },
      delivery: { timestamp: "2026-07-11T00:00:00Z", recipients: ["dest@example.com"] },
    });

    const result = await handler(event, dummyContext);

    expect(mockProcessNotification).toHaveBeenCalledTimes(1);
    expect(mockProcessRecord).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it("Bounce notification → routed to feedbackProcessor (no regression)", async () => {
    const event = makeSqsEvent({
      notificationType: "Bounce",
      mail: { messageId: "ses-msg-2", source: "user@example.com", tags: {} },
      bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [], timestamp: "2026-07-11T00:00:00Z" },
    });

    const result = await handler(event, dummyContext);

    expect(mockProcessNotification).toHaveBeenCalledTimes(1);
    expect(mockProcessRecord).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it("inbound Received notification → routed to processor.processRecord", async () => {
    const event = makeSqsEvent({
      notificationType: "Received",
      mail: { messageId: "ses-msg-3", timestamp: "2026-07-11T00:00:00Z", destination: ["dest@example.com"] },
      receipt: {
        dkimVerdict: { status: "PASS" },
        dmarcVerdict: { status: "PASS" },
        action: { objectKey: "inbound/ses-msg-3" },
      },
    });

    const result = await handler(event, dummyContext);

    expect(mockProcessRecord).toHaveBeenCalledTimes(1);
    expect(mockProcessNotification).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it("unrecognised notification with no mail/receipt → dropped without crashing", async () => {
    const event = makeSqsEvent({ notificationType: "Subscription" });

    const result = await handler(event, dummyContext);

    expect(mockProcessRecord).not.toHaveBeenCalled();
    expect(mockProcessNotification).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      "Unrecognised SNS notification — missing mail/receipt fields. Dropping message.",
      expect.objectContaining({ code: "handler.sqs.unrecognised_notification" }),
    );
    expect(result).toEqual({ batchItemFailures: [] });
  });
});
