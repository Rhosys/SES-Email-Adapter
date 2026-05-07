import type { APIGatewayProxyEventV2, SQSEvent, Context, APIGatewayProxyResultV2, EventBridgeEvent } from "aws-lambda";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SignalClassifier } from "./classifier/classifier.js";
import { SignalProcessor } from "./processor/processor.js";
import { MailparserMimeParser } from "./processor/mime.js";
import { JsonLogicRuleEvaluator } from "./processor/rule-evaluator.js";
import { AccountDatabase } from "./database/account-database.js";
import { ArcDatabase } from "./database/arc-database.js";
import { ProcessingDatabase } from "./database/processing-database.js";
import { ProcessorDatabaseAdapter, ApiDatabaseAdapter } from "./database/adapters.js";
import { AuditDatabase } from "./database/audit-database.js";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { SesNotifier } from "./notifier/ses-notifier.js";
import { SesForwarder } from "./notifier/ses-forwarder.js";
import { FeedbackProcessor } from "./notifier/feedback-processor.js";
import { handler as domainHealthHandler } from "./jobs/domain-health-job.js";
import type { VerificationMailer } from "./api/app.js";
import { AuthressAuthService } from "./api/authress-auth.js";
import { AuthressAccessService } from "./api/authress-access.js";
import { createApp } from "./api/app.js";
import type { MimeParser } from "./processor/mime.js";

// ---------------------------------------------------------------------------
// AWS SDK clients (reused across warm invocations)
// ---------------------------------------------------------------------------

const bedrock = new BedrockRuntimeClient({});
const s3 = new S3Client({});
const sesv2 = new SESv2Client({});

const S3_BUCKET = process.env["EMAIL_BUCKET"] ?? "";

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

const accountDb = new AccountDatabase();
const arcDb = new ArcDatabase();
const processingDb = new ProcessingDatabase();
const auditDb = new AuditDatabase();

const processor = new SignalProcessor({
  store: new ProcessorDatabaseAdapter(arcDb, accountDb, processingDb),
  mimeParser: new S3MimeParser(),
  classifier,
  arcMatcher: arcDb,
  ruleEvaluator: new JsonLogicRuleEvaluator(),
  notifier: new SesNotifier(),
  forwarder: new SesForwarder(sesv2, s3),
});

const feedbackProcessor = new FeedbackProcessor(processingDb, accountDb);

const NOTIFICATION_FROM = process.env["NOTIFICATION_FROM"] ?? "";
const APP_BASE_URL = process.env["APP_BASE_URL"] ?? "";
const CONFIG_SET = process.env["SES_CONFIGURATION_SET"] ?? "";

const sesVerificationMailer: VerificationMailer = {
  async sendForwardVerification(accountId: string, address: string, token: string): Promise<void> {
    const verifyUrl = `${APP_BASE_URL}/accounts/${accountId}/forwarding-addresses/${encodeURIComponent(address)}/verify?token=${token}`;
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
  },
};

const app = createApp({
  store: new ApiDatabaseAdapter(arcDb, accountDb, auditDb),
  auth: new AuthressAuthService(),
  access: new AuthressAccessService(),
  verificationMailer: sesVerificationMailer,
});

// ---------------------------------------------------------------------------
// Lambda entry point
// ---------------------------------------------------------------------------

export async function handler(
  event: APIGatewayProxyEventV2 | SQSEvent | EventBridgeEvent<string, { source?: string }>,
  _context: Context,
): Promise<APIGatewayProxyResultV2 | void> {
  if (isEventBridgeEvent(event)) {
    if ((event as EventBridgeEvent<string, { source?: string }>).detail?.source === "domain-health-job") {
      await domainHealthHandler();
    }
    return;
  }
  if (isSqsEvent(event)) {
    if (isFeedbackEvent(event)) {
      await feedbackProcessor.process(event);
    } else {
      await processor.process(event);
    }
    return;
  }
  return honoToApiGateway(app, event as APIGatewayProxyEventV2);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
