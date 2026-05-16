import type { APIGatewayProxyEventV2, SQSEvent, Context, APIGatewayProxyResultV2, EventBridgeEvent, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SQS_MESSAGE_TYPES } from "./types/index.js";

const [MSG_TYPE_REINDEX, MSG_TYPE_SIDE_EFFECT] = SQS_MESSAGE_TYPES;
import { SignalClassifier } from "./classifier/classifier.js";
import { SignalProcessor } from "./processor/processor.js";
import type { InboundSignalMessage, SideEffectPayload, SesVerdict } from "./processor/processor.js";
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
import { DynamoDeviceStore } from "./notifier/device-store.js";
import { FeedbackProcessor } from "./notifier/feedback-processor.js";
import { DomainHealthJob } from "./jobs/domain-health-job.js";
import { ok, err, dbError } from "./errors.js";
import type { DbError, Result } from "./errors.js";
import type { VerificationMailer } from "./api/app.js";
import { AuthressAuthService } from "./api/authress-auth.js";
import { AuthressAccessService } from "./api/authress-access.js";
import { createApp } from "./api/app.js";
import type { MimeParser, ParsedMime } from "./processor/mime.js";
import { BedrockEmbeddingGenerator } from "./embedding/embedding-generator.js";
import { multiClusterWriter } from "./database/multi-cluster-aurora-writer.js";
import { S3RetentionServiceImpl } from "./embedding/s3-retention-service.js";
import { ReindexWorker } from "./jobs/reindex/reindex-worker.js";
import { SesReplySender } from "./notifier/ses-reply-sender.js";
import { ReindexDispatcher } from "./jobs/reindex/reindex-dispatcher.js";
import type { ReindexSegmentMessage } from "./jobs/reindex/reindex-dispatcher.js";
import { RequestLogger } from "./logger.js";

// ---------------------------------------------------------------------------
// AWS SDK clients (reused across warm invocations)
// ---------------------------------------------------------------------------

const bedrock = new BedrockRuntimeClient({});
const s3 = new S3Client({});
const sesv2 = new SESv2Client({});
const sqs = new SQSClient({});

const S3_BUCKET = process.env["EMAIL_BUCKET"] ?? "";
const SIGNAL_QUEUE_URL = process.env["SIGNAL_QUEUE_URL"] ?? "";
const RETRY_TRACK_THRESHOLD = 30;

// ---------------------------------------------------------------------------
// S3-backed MimeParser
// ---------------------------------------------------------------------------

class S3MimeParser implements MimeParser {
  private readonly delegate = new MailparserMimeParser();
  async parse(s3Key: string): Promise<Result<ParsedMime, DbError>> {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));
      const buf = await res.Body?.transformToByteArray();
      if (!buf) return err(dbError(`Empty S3 object: ${s3Key}`));
      const parsed = await this.delegate.parse(Buffer.from(buf));
      return ok(parsed);
    } catch (e) {
      return err(dbError(e));
    }
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
const deviceStore = new DynamoDeviceStore();

const processor = new SignalProcessor({
  store: new ProcessorDatabaseAdapter(arcDb, accountDb, processingDb),
  mimeParser: new S3MimeParser(),
  classifier,
  embeddingGenerator,
  auroraWriter: multiClusterWriter,
  arcMatcher: arcDb,
  ruleEvaluator: new JsonLogicRuleEvaluator(logger),
  notifier: new SesNotifier(logger),
  forwarder: new SesForwarder(logger, sesv2, s3),
  retentionService: new S3RetentionServiceImpl(s3),
  replySender: new SesReplySender(sesv2),
  sqsDispatcher: new SqsDispatcherImpl(SIGNAL_QUEUE_URL, sqs, logger),
  logger,
});

const feedbackProcessor = new FeedbackProcessor(processingDb, accountDb, logger);

const reindexWorker = new ReindexWorker(logger);

const domainHealthJob = new DomainHealthJob(accountDb, arcDb, logger);

const NOTIFICATION_FROM = process.env["NOTIFICATION_FROM"] ?? "";
const APP_BASE_URL = process.env["APP_BASE_URL"] ?? "";
const CONFIG_SET = process.env["SES_CONFIGURATION_SET"] ?? "";

const sesVerificationMailer: VerificationMailer = {
  async sendForwardVerification(accountId: string, address: string, token: string) {
    const verifyUrl = `${APP_BASE_URL}/accounts/${accountId}/forwarding-addresses/${encodeURIComponent(address)}/verify?token=${token}`;
    try {
      await sesv2.send(new SendEmailCommand({
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
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  },
};

const authService = new AuthressAuthService();

const app = createApp({
  store: new ApiDatabaseAdapter(arcDb, accountDb, auditDb),
  auth: authService,
  access: new AuthressAccessService(),
  logger,
  verificationMailer: sesVerificationMailer,
  jobDispatcher: new ReindexDispatcher(),
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
    const failures: Array<{ itemIdentifier: string }> = [];

    for (const record of event.Records) {
      const receiveCount = Number(record.attributes?.ApproximateReceiveCount ?? "1");
      const messageType = record.messageAttributes?.["messageType"]?.stringValue;

      let body: unknown;
      try {
        body = JSON.parse(record.body);
      } catch (e) {
        logger.error("Failed to parse SQS record body as JSON.", { code: "handler.sqs.parse_failed", messageId: record.messageId, error: e });
        failures.push({ itemIdentifier: record.messageId });
        continue;
      }

      let failed: boolean;
      if (messageType === MSG_TYPE_REINDEX) {
        const result = await reindexWorker.processSegmentMessage(body as ReindexSegmentMessage);
        failed = result.isErr();
      } else if (messageType === MSG_TYPE_SIDE_EFFECT) {
        const payload = body as SideEffectPayload;
        if (!payload.signal || !payload.arc) {
          logger.error("Malformed side-effect payload — missing signal or arc. Dropping message.", { code: "handler.sqs.malformed_side_effect", messageId: record.messageId });
          continue;
        }
        const result = await processor.processSideEffect(payload);
        failed = result.isErr();
      } else {
        // SNS envelope — unwrap and route by notificationType
        const sns = body as { Message: string };
        let inner: unknown;
        try {
          inner = JSON.parse(sns.Message);
        } catch (e) {
          logger.error("Failed to parse inner SNS message.", { code: "handler.sqs.parse_failed", messageId: record.messageId, error: e });
          failures.push({ itemIdentifier: record.messageId });
          continue;
        }

        const notification = inner as { notificationType?: string; mail?: { messageId: string; timestamp: string; destination: string[] }; receipt?: { dkimVerdict: { status: SesVerdict }; dmarcVerdict: { status: SesVerdict }; action: { objectKey: string } }; accountId?: string };

        if (notification.notificationType === "Bounce" || notification.notificationType === "Complaint") {
          await feedbackProcessor.processNotification(notification);
          failed = false;
        } else {
          const mail = notification.mail!;
          const receipt = notification.receipt!;
          const message: InboundSignalMessage = {
            accountId: notification.accountId ?? mail.destination[0]!,
            s3Key: receipt.action.objectKey,
            sesMessageId: mail.messageId,
            timestamp: mail.timestamp,
            destination: mail.destination,
            dkimVerdict: receipt.dkimVerdict.status,
            dmarcVerdict: receipt.dmarcVerdict.status,
          };
          const result = await processor.processRecord(message, receiveCount);
          failed = result.isErr();
        }
      }

      if (failed) {
        if (receiveCount > RETRY_TRACK_THRESHOLD) {
          logger.error("SQS message failed after exceeding retry threshold. Message was redelivered " + receiveCount + " times without successful completion. Investigate earlier logs for this messageId.", { code: "handler.sqs.retry_threshold_exceeded", messageId: record.messageId, receiveCount });
        } else {
          logger.warn("SQS message processing failed on attempt " + receiveCount + ". Will be retried automatically.", { code: "handler.sqs.processing_failed", messageId: record.messageId, receiveCount });
        }
        failures.push({ itemIdentifier: record.messageId });
      }
    }

    return { batchItemFailures: failures };
  }
  if (isWsAuthorizerEvent(event)) {
    return handleWsAuthorizer(event as WsAuthorizerEvent);
  }
  if (isWebSocketEvent(event)) {
    return handleWebSocket(event as APIGatewayProxyWebsocketEventV2);
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

  const verifyResult = await authService.verify(token);
  if (verifyResult.isErr()) return wsDeny(event.methodArn);
  const { userId } = verifyResult.value;

  const accountId = event.queryStringParameters?.["accountId"] ?? "";
  if (!accountId) return wsDeny(event.methodArn);

  return {
    principalId: userId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: "Allow", Resource: event.methodArn }],
    },
    context: { accountId, userId },
  };
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
      await deviceStore.saveDevice({
        accountId,
        token: connectionId,
        type: "websocket",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // 2-hour TTL — API Gateway closes idle connections after 10 min anyway
        ttl: Math.floor(Date.now() / 1000) + 7200,
      });
      return { statusCode: 200 };

    case "$disconnect":
      if (accountId) await deviceStore.deleteDevice(accountId, connectionId);
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
