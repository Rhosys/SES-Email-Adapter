import type { SESHandler } from "aws-lambda";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { Email } from "@ses-adapter/shared";
import { EmailProcessor } from "./processor.js";
import { MailparserMimeParser } from "./mime.js";
import type { EmailStore } from "./store.js";
import type { MimeParser } from "./mime.js";

// ---------------------------------------------------------------------------
// S3-backed MIME parser
// ---------------------------------------------------------------------------

class S3MimeParser implements MimeParser {
  private readonly s3: S3Client;
  private readonly bucketName: string;
  private readonly delegate: MailparserMimeParser;

  constructor(s3: S3Client, bucketName: string) {
    this.s3 = s3;
    this.bucketName = bucketName;
    this.delegate = new MailparserMimeParser();
  }

  async parse(objectKey: string): ReturnType<MimeParser["parse"]> {
    const response = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucketName, Key: objectKey }),
    );
    const body = await response.Body?.transformToByteArray();
    if (!body) throw new Error(`Empty S3 object: ${objectKey}`);
    return this.delegate.parse(Buffer.from(body));
  }
}

// ---------------------------------------------------------------------------
// DynamoDB-backed email store
// ---------------------------------------------------------------------------

const TABLE_NAME = process.env["EMAIL_TABLE_NAME"] ?? "ses-emails";

class DynamoEmailStore implements EmailStore {
  private readonly ddb: DynamoDBDocumentClient;

  constructor(client: DynamoDBClient) {
    this.ddb = DynamoDBDocumentClient.from(client);
  }

  async saveEmail(email: Email): Promise<void> {
    await this.ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: email }));
  }

  async getEmailByMessageId(messageId: string): Promise<Pick<Email, "id" | "messageId"> | null> {
    const result = await this.ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { messageId },
        ProjectionExpression: "id, messageId",
      }),
    );
    if (!result.Item) return null;
    return result.Item as Pick<Email, "id" | "messageId">;
  }
}

// ---------------------------------------------------------------------------
// Lambda handler (singleton clients reused across warm invocations)
// ---------------------------------------------------------------------------

const s3 = new S3Client({});
const dynamo = new DynamoDBClient({});

const bucketName = process.env["EMAIL_BUCKET_NAME"];
if (!bucketName) throw new Error("EMAIL_BUCKET_NAME env var is required");

const processor = new EmailProcessor({
  store: new DynamoEmailStore(dynamo),
  mimeParser: new S3MimeParser(s3, bucketName),
});

export const handler: SESHandler = async (event) => {
  await processor.process(event);
};
