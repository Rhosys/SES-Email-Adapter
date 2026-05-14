import type { APIGatewayProxyEventV2, SQSEvent, Context, APIGatewayProxyResultV2, EventBridgeEvent, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SignalClassifier } from "./classifier/classifier.js";
import { SignalProcessor } from "./processor/processor.js";
import { SqsDispatcherImpl } from "./processor/sqs-dispatcher.js";
import { MailparserMimeParser } from "./processor/mime.js";
import { JsonLogicRuleEvaluator } from "./processor/rule-evaluator.js";
import { AccountDatabase } from "./database/account-database.js";
import { ArcDatabase } from "./database/arc-database.js";
import { ProcessingDatabase } from "./database/processing-database.js";
import { ProcessorDatabaseAdapter, ApiDatabaseAdapter } from "./database/adapters.js";
import { AuditDatabase } from "./database/audit-database.js";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { SesNotifier } from "./notifier/notifier.js";
import { SesForwarder } from "./notifier/ses-forwarder.js";
import { FeedbackProcessor } from "./notifier/feedback-processor.js";
import { DomainHealthJob } from "./jobs/domain-health-job.js";
import { ResultAsync } from "neverthrow";
import { dbError } from "./errors.js";
import type { VerificationMailer } from "./api/app.js";
import { AuthressAuthService } from "./api/authress-auth.js";
import { AuthressAccessService } from "./api/authress-access.js";
import { createApp } from "./api/app.js";
import type { MimeParser } from "./processor/mime.js";
import { BedrockEmbeddingGenerator } from "./embedding/embedding-generator.js";
import { multiClusterWriter } from "./database/multi-cluster-aurora-writer.js";
import { S3RetentionServiceImpl } from "./embedding/s3-retention-service.js";
import { ReindexWorker } from "./jobs/reindex/reindex-worker.js";
import { RequestLogger } from "./logger.js";
import { handleJobDispatch } from "./api/job-dispatch-handler.js";

// ---------------------------------------------------------------------------
// AWS SDK clients (reused across warm invocations)
// ---------------------------------------------------------------------------

const bedrock = new BedrockRuntimeClient({});
const s3 = new S3Client({});
const sesv2 = new SESv2Client({});
const sqs = new SQSClient({});

const S3_BUCKET = process.env["EMAIL_BUCKET"] ?? "";
const SIGNAL_QUEUE_URL = process.env["SIGNAL_QUEUE_URL"] ?? "";

// ---------------------------------------------------------------------------
// S3-backed MimeParser
// ---------------------------------------------------------------------------

class S3MimeParser implements MimeParser {
  private readonly delegate = new MailparserMimeParser();
  async parse(s3Key: string): ReturnType<MimeParser["parse"]> {
    const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));
    const buf = await res.Body?.transformToByteArray();
    if (!buf) throw new Error(`Empty S3 object: ${s3Key}`);
    return this.delegate.parse(Buffer.from(buf));
  }
}

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

const classifier = new SignalClassifier(bedrock);

const logger = new RequestLogger();

const embeddingGenerator = new BedrockEmbeddingGenerator(bedrock, logger);

const accountDb = new AccountDatabase();
const arcDb = new ArcDatabase(logger);
const processingDb = new ProcessingDatabase();
const auditDb = new AuditDatabase();

const processor = new SignalProcessor({
  store: new ProcessorDatabaseAdapter(arcDb, accountDb, processingDb),
  mimeParser: new S3MimeParser(),
  classifier,
  embeddingGenerator,
  auroraWriter: multiClusterWriter,
  arcMatcher: arcDb,
  ruleEvaluator: new JsonLogicRuleEvaluator(logger),
  notifier: new SesNotifier(),
  forwarder: new SesForwarder(logger, sesv2, s3),
  retentionService: new S3RetentionServiceImpl(s3),
  logger,
  ...(SIGNAL_QUEUE_URL ? { sqsDispatcher: new SqsDispatcherImpl(SIGNAL_QUEUE_URL, sqs, logger) } : {}),
});

const feedbackProcessor = new FeedbackProcessor(processingDb, accountDb, logger);

const reindexWorker = new ReindexWorker(logger);

const domainHealthJob = new DomainHealthJob(accountDb, arcDb, logger);

const NOTIFICATION_FROM = process.env["NOTIFICATION_FROM"] ?? "";
const APP_BASE_URL = process.env["APP_BASE_URL"] ?? "";
const CONFIG_SET = process.env["SES_CONFIGURATION_SET"] ?? "";

const sesVerificationMailer: VerificationMailer = {
  sendForwardVerification(accountId: string, address: string, token: string) {
    const verifyUrl = `${APP_BASE_URL}/accounts/${accountId}/forwarding-addresses/${encodeURIComponent(address)}/verify?token=${token}`;
    return ResultAsync.fromPromise(
      sesv2.send(new SendEmailCommand({
        FromEmailAddress: NOTIFICATION_FROM,
        Destination: { ToAddresses: [address] },
        Content: {
          Simple: {
            Subject: { Data: "Verify your forwarding address", Charset: "UTF-8" },
            Body: {
              Text: {
                Data: `Click the link below to verify that you want to receive forwarded emails at this address:\n\n${verifyUrl}\n\nIf you did not request this, you can ignore this email.`,
                Charset: "UTF-8",
              },
            },
          },
        },
        ...(CONFIG_SET ? { ConfigurationSetName: CONFIG_SET } : {}),
      })).then(() => undefined),
      (e) => dbError(e instanceof Error ? e : new Error(String(e)))
    );
  },
};

const authService = new AuthressAuthService();

const app = createApp({
  store: new ApiDatabaseAdapter(arcDb, accountDb, auditDb),
  auth: authService,
  access: new AuthressAccessService(),
  logger,
  verificationMailer: sesVerificationMailer,
});

// ---------------------------------------------------------------------------
// Lambda entry point
// ---------------------------------------------------------------------------

export async function handler(
  event: APIGatewayProxyEventV2 | APIGatewayProxyWebsocketEventV2 | SQSEvent | EventBridgeEvent<string, { source?: string }>,
  _context: Context,
): Promise<APIGatewayProxyResultV2 | WsAuthorizerResult | { statusCode: number } | { batchItemFailures: Array<{ itemIdentifier: string }> } | void> {
  logger.startInvocation();

  if (isEventBridgeEvent(event)) {
    if ((event as EventBridgeEvent<string, { source?: string }>).detail?.source === "domain-health-job") {
      await domainHealthJob.run();
    }
    return;
  }
  if (isSqsEvent(event)) {
    if (isFeedbackEvent(event)) {
      await feedbackProcessor.process(event);
    } else if (isReindexEvent(event)) {
      return reindexWorker.process(event);
    } else {
      await processor.process(event);
    }
    return;
  }
  if (isWsAuthorizerEvent(event)) {
    return handleWsAuthorizer(event as WsAuthorizerEvent);
  }
  if (isWebSocketEvent(event)) {
    return handleWebSocket(event as APIGatewayProxyWebsocketEventV2);
  }
  if (isReindexApiEvent(event as APIGatewayProxyEventV2)) {
    return handleJobDispatch(event as APIGatewayProxyEventV2);
  }
  return honoToApiGateway(app, event as APIGatewayProxyEventV2);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WebSocket authorizer  (fires on $connect; injects accountId into context)
// ---------------------------------------------------------------------------

type WsAuthorizerEvent = {
  type: "REQUEST";
  methodArn: string;
  headers?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
};

type WsAuthorizerResult = {
  principalId: string;
  policyDocument: {
    Version: string;
    Statement: Array<{ Action: string; Effect: "Allow" | "Deny"; Resource: string }>;
  };
  context: Record<string, string>;
};

function isWsAuthorizerEvent(event: unknown): event is WsAuthorizerEvent {
  const e = event as Record<string, unknown>;
  return e["type"] === "REQUEST" && typeof e["methodArn"] === "string";
}

async function handleWsAuthorizer(event: WsAuthorizerEvent): Promise<WsAuthorizerResult> {
  // Browsers can't set headers on WebSocket upgrades — token comes as ?token=
  const token =
    event.queryStringParameters?.["token"] ??
    (event.headers?.["Authorization"] ?? event.headers?.["authorization"])?.replace(/^Bearer\s+/i, "");

  if (!token) return wsDeny(event.methodArn);

  try {
    const ctx = await authService.verify(token);
    return {
      principalId: ctx.userId,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [{ Action: "execute-api:Invoke", Effect: "Allow", Resource: event.methodArn }],
      },
      context: { accountId: ctx.accountId, userId: ctx.userId },
    };
  } catch {
    return wsDeny(event.methodArn);
  }
}

function wsDeny(methodArn: string): WsAuthorizerResult {
  return {
    principalId: "anonymous",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: "Deny", Resource: methodArn }],
    },
    context: {},
  };
}

// ---------------------------------------------------------------------------
// WebSocket route handlers  ($connect / $disconnect / $default)
// ---------------------------------------------------------------------------

function isWebSocketEvent(event: unknown): event is APIGatewayProxyWebsocketEventV2 {
  const ctx = (event as { requestContext?: Record<string, unknown> }).requestContext;
  return typeof ctx === "object" && ctx !== null && "connectionId" in ctx;
}

async function handleWebSocket(event: APIGatewayProxyWebsocketEventV2): Promise<{ statusCode: number }> {
  const { routeKey, connectionId } = event.requestContext;
  // accountId is injected by the Lambda authorizer into requestContext.authorizer
  const authorizer = (event.requestContext as unknown as { authorizer?: Record<string, string> }).authorizer;
  const accountId = authorizer?.["accountId"] ?? "";

  switch (routeKey) {
    case "$connect":
      await accountDb.saveWsConnection({
        connectionId,
        accountId,
        connectedAt: new Date().toISOString(),
        // 2-hour TTL — API Gateway closes idle connections after 10 min anyway
        ttl: Math.floor(Date.now() / 1000) + 7200,
      });
      return { statusCode: 200 };

    case "$disconnect":
      if (accountId) await accountDb.deleteWsConnection(accountId, connectionId);
      return { statusCode: 200 };

    default:
      return { statusCode: 200 };
  }
}

function isEventBridgeEvent(event: unknown): event is EventBridgeEvent<string, unknown> {
  return typeof event === "object" && event !== null && "source" in event && "detail-type" in event;
}

function isSqsEvent(event: unknown): event is SQSEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    "Records" in event &&
    Array.isArray((event as SQSEvent).Records) &&
    (event as SQSEvent).Records[0]?.eventSource === "aws:sqs"
  );
}

function isFeedbackEvent(event: SQSEvent): boolean {
  return (event.Records[0]?.eventSourceARN ?? "").includes("-feedback");
}

function isReindexEvent(event: SQSEvent): boolean {
  return (event.Records[0]?.eventSourceARN ?? "").includes("-reindex");
}

function isReindexApiEvent(event: APIGatewayProxyEventV2): boolean {
  const http = (event as APIGatewayProxyEventV2).requestContext?.http;
  if (!http) return false;
  const method = http.method;
  const path = (event as APIGatewayProxyEventV2).rawPath ?? "";
  if (method === "POST" && /^\/reindex\/?$/.test(path)) return true;
  if (method === "GET" && /^\/reindex\/[^/]+\/?$/.test(path)) return true;
  return false;
}

async function honoToApiGateway(
  honoApp: typeof app,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const host = event.headers?.["host"] ?? "localhost";
  const path = event.rawPath ?? "/";
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `https://${host}${path}${qs}`;

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (v !== undefined) headers[k] = v;
  }

  const method = event.requestContext.http.method;
  const bodyInit = !["GET", "HEAD"].includes(method) && event.body
    ? (event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body)
    : null;

  const req = new Request(url, {
    method,
    headers,
    ...(bodyInit !== null ? { body: bodyInit } : {}),
  });

  const res = await honoApp.fetch(req);
  const resHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { resHeaders[k] = v; });

  return {
    statusCode: res.status,
    headers: resHeaders,
    body: await res.text(),
    isBase64Encoded: false,
  };
}
