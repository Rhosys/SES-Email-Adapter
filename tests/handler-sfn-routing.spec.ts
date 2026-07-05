import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "aws-lambda";

// Env vars required by handler.ts at module load time
process.env["MAIL_DOMAIN"] = "platform.email.rhosys.cloud";
process.env["SES_CONFIGURATION_SET_ARN"] = "arn:aws:ses:eu-west-1:123456789012:configuration-set/test-config-set";

// ---------------------------------------------------------------------------
// Mock heavy dependencies so the handler module can load without real AWS SDK
// ---------------------------------------------------------------------------

const mockHandleFollowup = vi.fn().mockResolvedValue({ _tag: "Ok", value: undefined });
const mockHandleCleanup = vi.fn().mockResolvedValue({ _tag: "Ok", value: undefined });
const mockHandleTrialCheck = vi.fn().mockResolvedValue({ accountIsTrial: true });

vi.mock("../src/onboarding/onboarding-task-handler.js", () => ({
  OnboardingTaskHandler: vi.fn().mockImplementation(() => ({
    handleFollowup: mockHandleFollowup,
    handleCleanup: mockHandleCleanup,
    handleTrialCheck: mockHandleTrialCheck,
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

vi.mock("../src/notifier/feedback-processor.js", () => ({
  FeedbackProcessor: vi.fn().mockImplementation(() => ({})),
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
// Helpers
// ---------------------------------------------------------------------------

function makeSfnEvent(stateName: string, input?: { accountId: string; email: string } | null) {
  return {
    context: {
      Execution: {
        Id: "arn:aws:states:eu-central-1:123456789012:execution:email-catcher-AccountCreation:acc-123",
        Input: input ?? { accountId: "acc-123", email: "user@test.com" },
        Name: "acc-123",
        StartTime: "2025-06-01T00:00:00Z",
      },
      StateMachine: {
        Id: "arn:aws:states:eu-central-1:123456789012:stateMachine:email-catcher-AccountCreation",
        Name: "email-catcher-AccountCreation",
      },
      State: {
        Name: stateName,
        EnteredTime: "2025-06-01T10:00:00Z",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Handler: Step Function event routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { label: "FirstFollowup → handleFollowup", stateName: "FirstFollowup", expectedFn: () => mockHandleFollowup },
    { label: "Cleanup → handleCleanup", stateName: "Cleanup", expectedFn: () => mockHandleCleanup },
    { label: "TrialCheck → handleTrialCheck", stateName: "TrialCheck", expectedFn: () => mockHandleTrialCheck },
  ])("$label", async ({ stateName, expectedFn }) => {
    const event = makeSfnEvent(stateName);

    await handler(event, dummyContext);

    const fn = expectedFn();
    expect(fn).toHaveBeenCalledTimes(1);
    if (stateName === "TrialCheck") {
      expect(fn).toHaveBeenCalledWith("acc-123", "2025-06-01T00:00:00Z");
    } else {
      expect(fn).toHaveBeenCalledWith("acc-123", "user@test.com");
    }
  });

  it("unknown state name → logs warning and returns empty object", async () => {
    const event = makeSfnEvent("UnknownState");

    const result = await handler(event, dummyContext);

    expect(result).toEqual({});
    expect(mockLogger.warn).toHaveBeenCalledWith("Unknown Step Function task", {
      code: "handler.sfn.unknown_task",
      processorId: "email-catcher-AccountCreation|UnknownState",
    });
    expect(mockHandleFollowup).not.toHaveBeenCalled();
    expect(mockHandleCleanup).not.toHaveBeenCalled();
    expect(mockHandleTrialCheck).not.toHaveBeenCalled();
  });

  it("missing Execution.Input fields → logs warning and returns empty object", async () => {
    const event = {
      context: {
        Execution: {
          Id: "arn:aws:states:eu-central-1:123456789012:execution:email-catcher-AccountCreation:acc-123",
          Input: null,
          Name: "acc-123",
        },
        StateMachine: {
          Id: "arn:aws:states:eu-central-1:123456789012:stateMachine:email-catcher-AccountCreation",
          Name: "email-catcher-AccountCreation",
        },
        State: {
          Name: "FirstFollowup",
          EnteredTime: "2025-06-01T10:00:00Z",
        },
      },
    };

    const result = await handler(event, dummyContext);

    expect(result).toEqual({});
    expect(mockLogger.warn).toHaveBeenCalledWith("Step Function task missing required Input fields", {
      code: "handler.sfn.missing_input",
      processorId: "email-catcher-AccountCreation|FirstFollowup",
    });
    expect(mockHandleFollowup).not.toHaveBeenCalled();
  });

  it("SQS event → not caught by Step Function check (no regression)", async () => {
    const sqsEvent = {
      Records: [{
        messageId: "msg-1",
        receiptHandle: "handle",
        body: "{}",
        attributes: { ApproximateReceiveCount: "1" } as Record<string, string>,
        messageAttributes: {},
        md5OfBody: "abc",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:eu-central-1:123:queue",
        awsRegion: "eu-central-1",
      }],
    };

    const result = await handler(sqsEvent, dummyContext);

    // SQS handler returns batchItemFailures shape
    expect(result).toHaveProperty("batchItemFailures");
    expect(mockHandleFollowup).not.toHaveBeenCalled();
    expect(mockHandleCleanup).not.toHaveBeenCalled();
    expect(mockHandleTrialCheck).not.toHaveBeenCalled();
  });

  it("EventBridge event → not caught by Step Function check (no regression)", async () => {
    const ebEvent = {
      source: "aws.events",
      "detail-type": "Scheduled Event",
      detail: { source: "domain-health-job" },
      id: "evt-1",
      version: "0",
      account: "123",
      time: "2025-06-01T10:00:00Z",
      region: "eu-central-1",
      resources: [],
    };

    const result = await handler(ebEvent, dummyContext);

    // EventBridge handler returns undefined
    expect(result).toBeUndefined();
    expect(mockHandleFollowup).not.toHaveBeenCalled();
    expect(mockHandleCleanup).not.toHaveBeenCalled();
    expect(mockHandleTrialCheck).not.toHaveBeenCalled();
  });
});
