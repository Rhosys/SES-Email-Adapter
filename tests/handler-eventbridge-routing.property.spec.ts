/**
 * Property 1: Unrecognized EventBridge rules are rejected
 *
 * For any EventBridge event whose rule name does not end with `-healthcheck` or
 * `-domain-health` (including empty/missing resources), the handler SHALL log an
 * error with code `handler.eventbridge.unknown_rule` and SHALL NOT invoke any job.
 *
 * Validates: Requirements 2.2, 2.3
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "aws-lambda";

// Env vars required by handler.ts at module load time
process.env["MAIL_DOMAIN"] = "platform.email.rhosys.cloud";
process.env["SES_CONFIGURATION_SET_ARN"] = "arn:aws:ses:eu-west-1:123456789012:configuration-set/test-config-set";

// ---------------------------------------------------------------------------
// Mock heavy dependencies so the handler module can load
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

vi.mock("../src/notifier/ses-feedback-processor.js", () => ({
  SesFeedbackProcessor: vi.fn().mockImplementation(() => ({})),
}));

const mockDomainHealthRun = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/jobs/domain-health-job.js", () => ({
  DomainHealthJob: vi.fn().mockImplementation(() => ({ run: mockDomainHealthRun })),
}));

const mockHealthcheckRun = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/jobs/healthcheck-job.js", () => ({
  HealthcheckJob: vi.fn().mockImplementation(() => ({ run: mockHealthcheckRun })),
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

function makeEventBridgeEvent(resources: string[]) {
  return {
    source: "aws.events",
    "detail-type": "Scheduled Event",
    detail: {},
    id: "evt-1",
    version: "0",
    account: "123456789012",
    time: "2025-07-01T06:00:00Z",
    region: "eu-central-1",
    resources,
  };
}

// ---------------------------------------------------------------------------
// Property 1: Unrecognized EventBridge rules are rejected
// ---------------------------------------------------------------------------

describe("Property 1: Unrecognized EventBridge rules are rejected", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const UNKNOWN_SUFFIX_CASES = [
    { label: "suffix -unknown-job", resources: ["arn:aws:events:eu-central-1:123456789012:rule/email-catcher-unknown-job"] },
    { label: "suffix -deploy", resources: ["arn:aws:events:eu-central-1:123456789012:rule/email-catcher-deploy"] },
    { label: "arbitrary rule name", resources: ["arn:aws:events:eu-central-1:123456789012:rule/some-arbitrary-rule"] },
    { label: "suffix -health (not -domain-health)", resources: ["arn:aws:events:eu-central-1:123456789012:rule/email-catcher-health"] },
    { label: "suffix -healthcheck-old (extra after -healthcheck)", resources: ["arn:aws:events:eu-central-1:123456789012:rule/email-catcher-healthcheck-old"] },
    { label: "suffix -domain-health-v2 (extra after -domain-health)", resources: ["arn:aws:events:eu-central-1:123456789012:rule/email-catcher-domain-health-v2"] },
  ];

  it.each(UNKNOWN_SUFFIX_CASES)("$label → logs error with code handler.eventbridge.unknown_rule and invokes no jobs", async ({ resources }) => {
    const event = makeEventBridgeEvent(resources);

    const result = await handler(event, dummyContext);

    expect(result).toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "handler.eventbridge.unknown_rule" }),
    );
    expect(mockDomainHealthRun).not.toHaveBeenCalled();
    expect(mockHealthcheckRun).not.toHaveBeenCalled();
  });

  const EMPTY_RESOURCES_CASES = [
    { label: "empty resources array", resources: [] as string[] },
    { label: "resources with empty string", resources: [""] },
  ];

  it.each(EMPTY_RESOURCES_CASES)("$label → logs error with code handler.eventbridge.unknown_rule and invokes no jobs", async ({ resources }) => {
    const event = makeEventBridgeEvent(resources);

    const result = await handler(event, dummyContext);

    expect(result).toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "handler.eventbridge.unknown_rule" }),
    );
    expect(mockDomainHealthRun).not.toHaveBeenCalled();
    expect(mockHealthcheckRun).not.toHaveBeenCalled();
  });

  it("undefined resources → logs error with code handler.eventbridge.unknown_rule and invokes no jobs", async () => {
    const event = {
      source: "aws.events",
      "detail-type": "Scheduled Event",
      detail: {},
      id: "evt-1",
      version: "0",
      account: "123456789012",
      time: "2025-07-01T06:00:00Z",
      region: "eu-central-1",
      // resources deliberately omitted
    };

    const result = await handler(event, dummyContext);

    expect(result).toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "handler.eventbridge.unknown_rule" }),
    );
    expect(mockDomainHealthRun).not.toHaveBeenCalled();
    expect(mockHealthcheckRun).not.toHaveBeenCalled();
  });

  // Boundary: recognized suffixes DO invoke their respective jobs
  it("-domain-health suffix → invokes domainHealthJob, NOT unknown_rule", async () => {
    const event = makeEventBridgeEvent(["arn:aws:events:eu-central-1:123456789012:rule/email-catcher-domain-health"]);

    await handler(event, dummyContext);

    expect(mockDomainHealthRun).toHaveBeenCalledOnce();
    expect(mockHealthcheckRun).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "handler.eventbridge.unknown_rule" }),
    );
  });

  it("-healthcheck suffix → invokes healthcheckJob, NOT unknown_rule", async () => {
    const event = makeEventBridgeEvent(["arn:aws:events:eu-central-1:123456789012:rule/email-catcher-healthcheck"]);

    await handler(event, dummyContext);

    expect(mockHealthcheckRun).toHaveBeenCalledOnce();
    expect(mockDomainHealthRun).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "handler.eventbridge.unknown_rule" }),
    );
  });
});
