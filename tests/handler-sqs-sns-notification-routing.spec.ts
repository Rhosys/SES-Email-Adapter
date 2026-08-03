/**
 * Regression test for handler.ts processSqsRecord's SNS envelope routing.
 *
 * Bug 1: SES "Delivery" notifications (sent to the same SNS topic as Bounce/Complaint
 * feedback) were not matched by the Bounce/Complaint check, so they fell through to the
 * inbound-receipt unwrap path which assumes `receipt.action.objectKey` exists. Delivery
 * notifications have no `receipt` field at all, so `receipt.action` threw:
 *   TypeError: Cannot read properties of undefined (reading 'action')
 *
 * Bug 2: the sending configuration set's feedback destination is wired via
 * aws_sesv2_configuration_set_event_destination (deploy/email_routing.tf), which is
 * AWS's "event publishing" API — those messages carry the type in an `eventType` field,
 * not `notificationType`. `notificationType` is only correct for SES's own inbound
 * receiving notifications ("Received") and the older identity-level notification format.
 * A real Bounce/Complaint from this deployment's config set would therefore never have
 * matched a `notificationType === "Bounce"` check either, and would have fallen into
 * the same crash as Delivery above.
 *
 * Fix (final shape): handler.ts only knows about the one type it itself needs to act on
 * — "Received", the inbound-receipt notification. Every other notificationType/eventType
 * — known feedback types, or anything else — is delegated unconditionally to
 * SesFeedbackProcessor, which owns the full SES event vocabulary (see
 * ses-feedback-processor-bounce.test.ts for how it resolves eventType vs notificationType
 * and handles known-but-unactioned / genuinely-unrecognised types). The handler itself
 * never needs to enumerate SES event types.
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
    processInbound: mockProcessRecord,
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
vi.mock("../src/notifier/ses-feedback-processor.js", () => ({
  SesFeedbackProcessor: vi.fn().mockImplementation(() => ({
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
      body: JSON.stringify({ Type: "Notification", Message: JSON.stringify(snsMessage) }),
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

describe("Handler: SQS/SNS envelope routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inbound Received notification → routed to processor.processInbound, not delegated", async () => {
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

  it("Received notification missing receipt.action → delegated to sesFeedbackProcessor (structural routing)", async () => {
    const payload = { notificationType: "Received" };
    const event = makeSqsEvent(payload);

    const result = await handler(event, dummyContext);

    expect(mockProcessRecord).not.toHaveBeenCalled();
    expect(mockProcessNotification).toHaveBeenCalledTimes(1);
    expect(mockProcessNotification).toHaveBeenCalledWith(payload);
    expect(result).toEqual({ batchItemFailures: [] });
  });

  // The handler doesn't inspect or enumerate SES event types at all — anything that
  // isn't notificationType: "Received" is unconditionally handed to sesFeedbackProcessor,
  // which is the one place that knows the SES event vocabulary. Covers both the classic
  // `notificationType` shape and the real production `eventType` shape (see Bug 2 above),
  // known-but-unactioned types, and even a made-up type — the handler treats them all
  // identically.
  it.each([
    {
      label: "Delivery (notificationType shape — the original crash)",
      payload: { notificationType: "Delivery", mail: { messageId: "ses-msg-1", source: "user@example.com", tags: {} }, delivery: { timestamp: "2026-07-11T00:00:00Z", recipients: ["dest@example.com"] } },
    },
    {
      label: "Bounce (notificationType shape)",
      payload: { notificationType: "Bounce", mail: { messageId: "ses-msg-2", source: "user@example.com", tags: {} }, bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [], timestamp: "2026-07-11T00:00:00Z" } },
    },
    {
      label: "Bounce (real eventType shape from the SESv2 configuration-set destination)",
      payload: { eventType: "Bounce", mail: { messageId: "ses-msg-2b", source: "user@example.com", tags: {} }, bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [], timestamp: "2026-07-11T00:00:00Z" } },
    },
    {
      label: "Subscription (a known-but-unactioned SES event type)",
      payload: { eventType: "Subscription", mail: { messageId: "ses-msg-2c", source: "user@example.com", tags: {} } },
    },
    {
      label: "a wholly made-up type the handler has never heard of",
      payload: { notificationType: "SomeFutureSesEventType" },
    },
  ])("$label → delegated to sesFeedbackProcessor.processNotification, no crash", async ({ payload }) => {
    const event = makeSqsEvent(payload);

    const result = await handler(event, dummyContext);

    expect(mockProcessNotification).toHaveBeenCalledTimes(1);
    expect(mockProcessNotification).toHaveBeenCalledWith(payload);
    expect(mockProcessRecord).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });
});
