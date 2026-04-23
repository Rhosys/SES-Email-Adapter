import type { APIGatewayProxyEventV2, SQSEvent, Context, APIGatewayProxyResultV2 } from "aws-lambda";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SignalClassifier } from "./classifier/classifier.js";
import { SignalProcessor } from "./processor/processor.js";
import { MailparserMimeParser } from "./processor/mime.js";
import { createApp } from "./api/app.js";
import type { ProcessorStore, ArcMatcher, RuleEvaluator } from "./processor/processor.js";
import type { MimeParser } from "./processor/mime.js";
import type { ApiStore, AuthService, AuthContext } from "./api/app.js";
import type { Signal, Arc, View, Label, Rule, Domain, Page, PageParams } from "./types/index.js";
import type { ListArcsParams, UpdateArcRequest, CreateViewRequest, UpdateViewRequest, CreateLabelRequest, UpdateLabelRequest, CreateRuleRequest, UpdateRuleRequest } from "./api/app.js";

// ---------------------------------------------------------------------------
// AWS SDK clients (reused across warm invocations)
// ---------------------------------------------------------------------------

const bedrock = new BedrockRuntimeClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const S3_BUCKET = process.env["EMAIL_BUCKET"] ?? "";
const TABLE = process.env["DYNAMODB_TABLE"] ?? "ses-signals";

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
// DynamoDB-backed ProcessorStore
// ---------------------------------------------------------------------------

class DynamoProcessorStore implements ProcessorStore {
  async getSignalByMessageId(messageId: string): Promise<Pick<Signal, "id" | "messageId"> | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `SIGNAL#${messageId}`, sk: "SIGNAL" },
      ProjectionExpression: "id, messageId",
    }));
    return result.Item ? (result.Item as Pick<Signal, "id" | "messageId">) : null;
  }
  async saveSignal(signal: Signal): Promise<void> {
    await dynamo.send(new PutCommand({
      TableName: TABLE,
      Item: { ...signal, pk: `SIGNAL#${signal.messageId}`, sk: "SIGNAL" },
    }));
  }
  async getArc(id: string): Promise<Arc | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `ARC#${id}`, sk: "ARC" },
    }));
    return result.Item ? (result.Item as Arc) : null;
  }
  async saveArc(arc: Arc): Promise<void> {
    await dynamo.send(new PutCommand({
      TableName: TABLE,
      Item: { ...arc, pk: `ARC#${arc.id}`, sk: "ARC" },
    }));
  }
  async listRules(accountId: string): Promise<Rule[]> {
    const result = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `ACCOUNT#${accountId}#RULES` },
    }));
    return (result.Items ?? []) as Rule[];
  }
}

// ---------------------------------------------------------------------------
// ArcMatcher stub (pgvector via RDS Proxy — wired at deploy time)
// ---------------------------------------------------------------------------

class StubArcMatcher implements ArcMatcher {
  async findMatch(_accountId: string, _embedding: number[]): Promise<Arc | null> {
    return null;
  }
  async upsertEmbedding(_arcId: string, _embedding: number[]): Promise<void> {}
}

// ---------------------------------------------------------------------------
// JSONLogic RuleEvaluator stub
// ---------------------------------------------------------------------------

class StubRuleEvaluator implements RuleEvaluator {
  evaluate(_rule: Rule, _context: { signal: Signal; arc: Arc }): boolean {
    return false;
  }
}

// ---------------------------------------------------------------------------
// DynamoDB-backed ApiStore stub
// ---------------------------------------------------------------------------

class DynamoApiStore implements ApiStore {
  async listArcs(_accountId: string, _params: ListArcsParams): Promise<Page<Arc>> { return { items: [], total: 0 }; }
  async getArc(_accountId: string, _id: string): Promise<Arc | null> { return null; }
  async updateArc(_accountId: string, _id: string, _update: UpdateArcRequest): Promise<void> {}
  async listSignals(_accountId: string, _arcId: string, _params: PageParams): Promise<Page<Signal>> { return { items: [], total: 0 }; }
  async getSignal(_accountId: string, _id: string): Promise<Signal | null> { return null; }
  async listViews(_accountId: string): Promise<View[]> { return []; }
  async getView(_accountId: string, _id: string): Promise<View | null> { return null; }
  async createView(_accountId: string, _data: CreateViewRequest): Promise<void> {}
  async updateView(_accountId: string, _id: string, _data: UpdateViewRequest): Promise<void> {}
  async deleteView(_accountId: string, _id: string): Promise<void> {}
  async reorderViews(_accountId: string, _orderedIds: string[]): Promise<void> {}
  async listLabels(_accountId: string): Promise<Label[]> { return []; }
  async createLabel(_accountId: string, _data: CreateLabelRequest): Promise<void> {}
  async updateLabel(_accountId: string, _id: string, _data: UpdateLabelRequest): Promise<void> {}
  async deleteLabel(_accountId: string, _id: string): Promise<void> {}
  async listRules(_accountId: string): Promise<Rule[]> { return []; }
  async createRule(_accountId: string, _data: CreateRuleRequest): Promise<void> {}
  async updateRule(_accountId: string, _id: string, _data: UpdateRuleRequest): Promise<void> {}
  async deleteRule(_accountId: string, _id: string): Promise<void> {}
  async reorderRules(_accountId: string, _orderedIds: string[]): Promise<void> {}
  async listDomains(_accountId: string): Promise<Domain[]> { return []; }
  async getDomain(_accountId: string, _id: string): Promise<Domain | null> { return null; }
  async createDomain(_accountId: string, _domain: string): Promise<void> {}
  async deleteDomain(_accountId: string, _id: string): Promise<void> {}
  async searchArcs(_accountId: string, _query: string, _params: PageParams): Promise<Page<Arc>> { return { items: [], total: 0 }; }
}

// ---------------------------------------------------------------------------
// Authress stub
// ---------------------------------------------------------------------------

class AuthressAuthService implements AuthService {
  async verify(token: string): Promise<AuthContext> {
    // TODO: verify via Authress SDK
    if (!token) throw new Error("No token");
    throw new Error("Authress auth not implemented");
  }
}

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

const classifier = new SignalClassifier(bedrock);
const processor = new SignalProcessor({
  store: new DynamoProcessorStore(),
  mimeParser: new S3MimeParser(),
  classifier,
  arcMatcher: new StubArcMatcher(),
  ruleEvaluator: new StubRuleEvaluator(),
});
const app = createApp({
  store: new DynamoApiStore(),
  auth: new AuthressAuthService(),
});

// ---------------------------------------------------------------------------
// Lambda entry point
// ---------------------------------------------------------------------------

export async function handler(
  event: APIGatewayProxyEventV2 | SQSEvent,
  _context: Context,
): Promise<APIGatewayProxyResultV2 | void> {
  if (isSqsEvent(event)) {
    await processor.process(event);
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

  const req = new Request(url, {
    method: event.requestContext.http.method,
    headers,
    body: ["GET", "HEAD"].includes(event.requestContext.http.method)
      ? undefined
      : event.body
        ? event.isBase64Encoded
          ? Buffer.from(event.body, "base64")
          : event.body
        : undefined,
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
