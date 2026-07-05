import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "aws-lambda";
import { ok, err } from "neverthrow";

// Env vars required by handler.ts at module load time
process.env["MAIL_DOMAIN"] = "platform.email.rhosys.cloud";
process.env["SES_CONFIGURATION_SET_ARN"] = "arn:aws:ses:eu-west-1:123456789012:configuration-set/test-config-set";

// ---------------------------------------------------------------------------
// Mock heavy dependencies so the handler module can load without real AWS SDK
// ---------------------------------------------------------------------------

const mockVerify = vi.fn();

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
  AuthressAuthService: vi.fn().mockImplementation(() => ({ verify: mockVerify })),
}));

vi.mock("../src/api/authress-access.js", () => ({
  AuthressAccessService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/api/app.js", () => ({
  createApp: vi.fn().mockReturnValue({ fetch: vi.fn().mockImplementation(() => Promise.resolve(new Response("ok", { status: 200 }))) }),
}));

vi.mock("../src/logger.js", () => ({
  RequestLogger: vi.fn().mockImplementation(() => ({
    startInvocation: vi.fn(),
    getInvocationId: vi.fn().mockReturnValue("test-invocation-id"),
    trackPoint: vi.fn(),
    info: vi.fn(),
    track: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    critical: vi.fn(),
  })),
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

function makeHttpAuthorizerEvent(headers: Record<string, string> = {}) {
  return {
    version: "2.0" as const,
    type: "REQUEST" as const,
    routeArn: "arn:aws:execute-api:eu-central-1:123456789012:abc123/prod/GET/api/accounts",
    routeKey: "GET /api/accounts/{accountId}",
    rawPath: "/api/accounts/acc-123",
    headers,
    requestContext: {
      accountId: "123456789012",
      apiId: "abc123",
      domainName: "api.example.com",
      http: { method: "GET", path: "/api/accounts/acc-123" },
      requestId: "req-1",
      routeKey: "GET /api/accounts/{accountId}",
      stage: "prod",
      time: "01/Jan/2025:00:00:00 +0000",
      timeEpoch: 1735689600000,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: handleHttpAuthorizer
// ---------------------------------------------------------------------------

describe("HTTP Authorizer: handleHttpAuthorizer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("valid Bearer token → returns isAuthorized true with userId", async () => {
    mockVerify.mockResolvedValue(ok({ userId: "test-user" }));

    const event = makeHttpAuthorizerEvent({ authorization: "Bearer valid-jwt-token" });
    const result = await handler(event, dummyContext);

    expect(result).toEqual({ isAuthorized: true, context: { userId: "test-user" } });
    expect(mockVerify).toHaveBeenCalledWith("valid-jwt-token");
  });

  it("missing authorization header → returns isAuthorized false", async () => {
    const event = makeHttpAuthorizerEvent({});
    const result = await handler(event, dummyContext);

    expect(result).toEqual({ isAuthorized: false, context: {} });
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("authorization header without Bearer prefix → returns isAuthorized false", async () => {
    const event = makeHttpAuthorizerEvent({ authorization: "Basic dXNlcjpwYXNz" });
    const result = await handler(event, dummyContext);

    expect(result).toEqual({ isAuthorized: false, context: {} });
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("Bearer prefix with only whitespace after → returns isAuthorized false", async () => {
    const event = makeHttpAuthorizerEvent({ authorization: "Bearer    " });
    const result = await handler(event, dummyContext);

    expect(result).toEqual({ isAuthorized: false, context: {} });
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("AuthService returns error → returns isAuthorized false", async () => {
    mockVerify.mockResolvedValue(err(new Error("token expired")));

    const event = makeHttpAuthorizerEvent({ authorization: "Bearer expired-token" });
    const result = await handler(event, dummyContext);

    expect(result).toEqual({ isAuthorized: false, context: {} });
    expect(mockVerify).toHaveBeenCalledWith("expired-token");
  });
});

// ---------------------------------------------------------------------------
// Tests: Event discrimination (isHttpAuthorizerEvent / isWsAuthorizerEvent)
// ---------------------------------------------------------------------------

describe("HTTP Authorizer: event discrimination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("event with version 2.0, type REQUEST, and routeArn → routes to HTTP authorizer", async () => {
    mockVerify.mockResolvedValue(ok({ userId: "usr-1" }));

    const event = makeHttpAuthorizerEvent({ authorization: "Bearer tok" });
    const result = await handler(event, dummyContext);

    // HTTP authorizer response shape (not Hono, not WS authorizer)
    expect(result).toEqual({ isAuthorized: true, context: { userId: "usr-1" } });
  });

  it("event without routeArn → does NOT route to HTTP authorizer", async () => {
    const event = {
      version: "2.0",
      type: "REQUEST",
      // no routeArn — this is NOT an HTTP authorizer event
      rawPath: "/api/accounts/acc-1",
      headers: { authorization: "Bearer tok" },
      requestContext: {
        http: { method: "GET", path: "/api/accounts/acc-1" },
        requestId: "req-1",
        routeKey: "GET /api/accounts/{accountId}",
        stage: "prod",
        time: "01/Jan/2025:00:00:00 +0000",
        timeEpoch: 1735689600000,
      },
      rawQueryString: "",
    };

    const result = await handler(event, dummyContext);

    // Falls through to Hono — returns an API Gateway proxy response shape
    expect(result).toHaveProperty("statusCode");
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("event without type REQUEST → does NOT route to HTTP authorizer", async () => {
    // Regular HTTP API event (no type field) — should go to Hono
    const event = {
      version: "2.0",
      // no type: "REQUEST" — regular HTTP request
      rawPath: "/api/accounts/acc-1",
      headers: { authorization: "Bearer tok" },
      requestContext: {
        http: { method: "GET", path: "/api/accounts/acc-1" },
        requestId: "req-1",
        routeKey: "GET /api/accounts/{accountId}",
        stage: "prod",
        time: "01/Jan/2025:00:00:00 +0000",
        timeEpoch: 1735689600000,
      },
      rawQueryString: "",
    };

    const result = await handler(event, dummyContext);

    // Falls through to Hono
    expect(result).toHaveProperty("statusCode");
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("event with type REQUEST and methodArn → routes to WS authorizer (no regression)", async () => {
    mockVerify.mockResolvedValue(ok({ userId: "ws-user" }));

    const event = {
      type: "REQUEST",
      methodArn: "arn:aws:execute-api:eu-central-1:123456789012:ws-api/prod/$connect",
      requestContext: { path: "/api/accounts/acc-ws" },
      headers: {},
      queryStringParameters: { token: "ws-jwt-token", accountId: "acc-ws" },
    };

    const result = await handler(event, dummyContext);

    // WS authorizer response shape — has policyDocument, not isAuthorized
    expect(result).toHaveProperty("policyDocument");
    expect(result).toHaveProperty("principalId", "ws-user");
    expect((result as { context: Record<string, string> }).context).toEqual({ accountId: "acc-ws", userId: "ws-user" });
  });
});
