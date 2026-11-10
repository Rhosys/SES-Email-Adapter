// Processor integration harness.
//
// Extends the base harness: seeds an account + receiving domain through the API, and
// delivers inbound email the way production receives it — the raw MIME lands in the
// email bucket (SES's S3 receipt action), and the SES "Received" notification, wrapped
// in its SNS envelope, wrapped in an SQS record, is handed to the real Lambda handler
// (src/create-handler.ts) built over the IntegrationCompositeRoot. Results are then
// read back through the API by the suites.
//
// Required env vars (in addition to those in harness.ts):
//   PROCESSING_TABLE      — DynamoDB processing table name
//   EMAIL_BUCKET          — S3 bucket for raw MIME emails (ses-it-email)
//   CONTENT_BUCKET        — S3 bucket for extracted content (ses-it-content)
//   CONTENT_CDN_BASE_URL  — CDN base for attachment URLs

import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { Context, SESMessage, SNSMessage, SQSEvent } from 'aws-lambda';
import { createHandler } from '../src/create-handler.js';
import { createHarness } from './harness.js';
import type { IntegrationHarness } from './harness.js';
import { EMAIL_BUCKET, CONTENT_BUCKET } from './integration-composite-root.js';

const REGION = process.env['AWS_REGION'] ?? 'eu-central-1';
const SES_TOPIC_ARN = `arn:aws:sns:${REGION}:000000000000:SES-Email-Adapter-ses-notifications`;
const SIGNAL_QUEUE_ARN = `arn:aws:sqs:${REGION}:000000000000:SES-Email-Adapter-signals`;

// ---------------------------------------------------------------------------
// Harness interface
// ---------------------------------------------------------------------------

export interface ProcessorHarness extends IntegrationHarness {
  accountId: string;
  /** Deliver a raw MIME email to the seeded account through the real Lambda handler. */
  receiveEmail(messageId: string, rawMime: string | Buffer): Promise<void>;
}

// ---------------------------------------------------------------------------
// Production event shapes: SQS record ⊃ SNS envelope ⊃ SES "Received" notification
// ---------------------------------------------------------------------------

function sesReceivedNotification(messageId: string, recipient: string, objectKey: string): SESMessage & { notificationType: 'Received' } {
  const timestamp = new Date().toISOString();
  return {
    notificationType: 'Received',
    mail: {
      timestamp,
      source: 'sender@example.com',
      messageId,
      destination: [recipient],
      headersTruncated: false,
      headers: [],
      commonHeaders: { returnPath: 'sender@example.com', date: timestamp, messageId: `<${messageId}>`, to: [recipient] },
    },
    receipt: {
      timestamp,
      processingTimeMillis: 1,
      recipients: [recipient],
      spamVerdict: { status: 'PASS' },
      virusVerdict: { status: 'PASS' },
      spfVerdict: { status: 'PASS' },
      dkimVerdict: { status: 'PASS' },
      dmarcVerdict: { status: 'PASS' },
      action: { type: 'S3', topicArn: SES_TOPIC_ARN, bucketName: EMAIL_BUCKET, objectKey },
    },
  };
}

function snsEnvelope(message: unknown): SNSMessage {
  return {
    Type: 'Notification',
    MessageId: randomUUID(),
    TopicArn: SES_TOPIC_ARN,
    Subject: 'Amazon SES Email Receipt Notification',
    Message: JSON.stringify(message),
    Timestamp: new Date().toISOString(),
    SignatureVersion: '1',
    Signature: 'integration-test',
    SigningCertUrl: 'https://sns.example.invalid/cert.pem',
    UnsubscribeUrl: 'https://sns.example.invalid/unsubscribe',
    MessageAttributes: {},
  };
}

function sqsEvent(body: unknown): SQSEvent {
  const now = String(Date.now());
  return {
    Records: [{
      messageId: randomUUID(),
      receiptHandle: `integration-${randomUUID()}`,
      body: JSON.stringify(body),
      attributes: { ApproximateReceiveCount: '1', SentTimestamp: now, SenderId: 'integration-test', ApproximateFirstReceiveTimestamp: now },
      messageAttributes: {},
      md5OfBody: '',
      eventSource: 'aws:sqs',
      eventSourceARN: SIGNAL_QUEUE_ARN,
      awsRegion: REGION,
    }],
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createProcessorHarness(): Promise<ProcessorHarness> {
  const base = await createHarness();
  const { root, app, mockAuthress } = base;
  const handler = createHandler(root);

  // The email bucket is provisioned by Tofu; the content bucket is integration-only.
  // CreateBucket is idempotent here — an existing bucket is fine.
  const bucketConfig = REGION !== 'us-east-1' ? { CreateBucketConfiguration: { LocationConstraint: REGION as 'eu-central-1' } } : {};
  await root.s3.send(new CreateBucketCommand({ Bucket: EMAIL_BUCKET, ...bucketConfig })).catch(() => undefined);
  await root.s3.send(new CreateBucketCommand({ Bucket: CONTENT_BUCKET, ...bucketConfig })).catch(() => undefined);

  // ---------------------------------------------------------------------------
  // Seed account + domain via the API (never call DB directly in integration tests)
  // ---------------------------------------------------------------------------

  const seedUserId = `user-processor-harness-${Date.now()}`;
  const seedToken = await mockAuthress.createToken(seedUserId);

  const createAccountRes = await app.request('/accounts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${seedToken}`, 'Content-Type': 'application/json' },
  });
  if (createAccountRes.status !== 201) {
    throw new Error(`POST /accounts failed: ${createAccountRes.status} ${await createAccountRes.text()}`);
  }
  const { accountId } = await createAccountRes.json() as { accountId: string };

  const recipientDomain = `${accountId}.example.com`;
  const createDomainRes = await app.request(`/accounts/${accountId}/domains`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${seedToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: recipientDomain }),
  });
  if (createDomainRes.status !== 201) {
    throw new Error(`POST /accounts/${accountId}/domains failed: ${createDomainRes.status} ${await createDomainRes.text()}`);
  }

  // This harness exercises content round-tripping (attachments, CID images, calendar
  // invites), not the unknown-sender quarantine policy — allow_all keeps scenario emails
  // out of quarantine so they land in an active arc the way the assertions below expect.
  const updateFilteringRes = await app.request(`/accounts/${accountId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${seedToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filtering: { defaultUnknownSenderPolicy: 'allow_all' } }),
  });
  if (updateFilteringRes.status !== 200) {
    throw new Error(`PATCH /accounts/${accountId} failed: ${updateFilteringRes.status} ${await updateFilteringRes.text()}`);
  }

  // ---------------------------------------------------------------------------
  // Inbound delivery
  // ---------------------------------------------------------------------------

  async function receiveEmail(messageId: string, rawMime: string | Buffer): Promise<void> {
    const objectKey = `emails/${messageId}`;
    await root.s3.send(new PutObjectCommand({
      Bucket: EMAIL_BUCKET,
      Key: objectKey,
      Body: typeof rawMime === 'string' ? Buffer.from(rawMime) : rawMime,
      ContentType: 'message/rfc822',
    }));

    const event = sqsEvent(snsEnvelope(sesReceivedNotification(messageId, `recipient@${recipientDomain}`, objectKey)));
    const result = await handler(event, { awsRequestId: `integration-${messageId}` } as Context) as { batchItemFailures?: Array<{ itemIdentifier: string }> };
    if (!result?.batchItemFailures || result.batchItemFailures.length > 0) {
      throw new Error(`Handler did not process the SQS record cleanly (see logs above): ${JSON.stringify(result)}`);
    }
  }

  return { ...base, accountId, receiveEmail };
}
