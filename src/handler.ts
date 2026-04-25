import type { APIGatewayProxyEventV2, SQSEvent, Context, APIGatewayProxyResultV2 } from "aws-lambda";
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
import { SesNotifier } from "./notifier/ses-notifier.js";
import { FeedbackProcessor } from "./notifier/feedback-processor.js";
import { AuthressAuthService } from "./api/authress-auth.js";
import { AuthressAccessService } from "./api/authress-access.js";
import { createApp } from "./api/app.js";
import type { MimeParser } from "./processor/mime.js";

// ---------------------------------------------------------------------------
// AWS SDK clients (reused across warm invocations)
// ---------------------------------------------------------------------------

const bedrock = new BedrockRuntimeClient({});
const s3 = new S3Client({});

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

const processor = new SignalProcessor({
  store: new ProcessorDatabaseAdapter(arcDb, accountDb, processingDb),
  mimeParser: new S3MimeParser(),
  classifier,
  arcMatcher: arcDb,
  ruleEvaluator: new JsonLogicRuleEvaluator(),
  notifier: new SesNotifier(),
});

const feedbackProcessor = new FeedbackProcessor();

const app = createApp({
  store: new ApiDatabaseAdapter(arcDb, accountDb),
  auth: new AuthressAuthService(),
  access: new AuthressAccessService(),
});

// ---------------------------------------------------------------------------
// Lambda entry point
// ---------------------------------------------------------------------------

export async function handler(
  event: APIGatewayProxyEventV2 | SQSEvent,
  _context: Context,
): Promise<APIGatewayProxyResultV2 | void> {
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
