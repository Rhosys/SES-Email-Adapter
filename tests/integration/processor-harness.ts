import type { IForwardingService } from "../../src/forwarding/forwarding-service.js";
// Processor integration harness.
//
// Extends the base harness with real S3, SQS, and SignalProcessor wired to
// MiniStack. Provides helpers to upload a raw MIME email, send an SNS-wrapped
// SQS message, poll the queue, and call processInbound().
//
// Required env vars (in addition to those in harness.ts):
//   PROCESSING_TABLE      — DynamoDB processing table name
//   EMAIL_BUCKET          — S3 bucket for raw MIME emails (ses-it-email)
//   CONTENT_BUCKET        — S3 bucket for extracted content (ses-it-content)
//   SIGNAL_QUEUE_URL      — SQS queue URL (http://localhost:4566/.../ses-it-signals)
//   CONTENT_CDN_BASE_URL  — CDN base for attachment URLs

import { S3Client, CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { EmailContentStore, ContentStore } from "../../src/content-store.js";
import { SQSClient, CreateQueueCommand, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { AccountDatabase } from '../../src/database/account-database.js';
import { ThreadDatabase } from '../../src/database/thread-database.js';
import { AuditDatabase } from '../../src/database/audit-database.js';
import { ProcessingDatabase } from '../../src/database/processing-database.js';
import { SignalProcessor } from '../../src/processor/processor.js';
import type { InboundSignalMessage, SideEffectPayload, SesVerdictStatus } from '../../src/processor/processor.js';
import { JsonLogicRuleEvaluator } from '../../src/processor/rule-evaluator.js';
import { createApp } from '../../src/api/app.js';
import { makeAppDeps } from '../helpers/app-deps.js';
import { makeHmacGeneratorFake } from '../helpers/hmac-generator-fake.js';
import { AuthressAuthService } from '../../src/api/authress-auth.js';
import { startMockAuthressServer } from './mock-authress.js';
import type { MockAuthressServer } from './mock-authress.js';
import { InProcessContentSanitizer } from './in-process-content-sanitizer.js';
import { createConsoleLogger } from './logger.js';
import { ok } from '../../src/errors.js';
import type { AccessService } from '../../src/api/app.js';
import type { EmailService } from '../../src/email/email-service.js';
import type { sendRsvp } from '../../src/processor/calendar/rsvp-composer.js';
import type { PostApprovalCalendarHandlerDeps } from '../../src/processor/calendar/post-approval-handler.js';
import type { EmbeddingGenerator } from '../../src/embedding/embedding-generator.js';
import type { MultiClusterAuroraWriter } from '../../src/database/thread-matcher.js';
import type { WorkflowData } from '../../src/types/index.js';
import { BillingHandler } from '../../src/billing/billing-handler.js';
import type { UserCodeExecutorClient } from '../../src/processor/user-code-client.js';
import type { HandlerRegistry } from '../../src/workflow/registry.js';
import type { SchedulerClient } from '../../src/scheduler/scheduler-client.js';

const ENDPOINT = process.env['AWS_ENDPOINT_URL'] ?? 'http://localhost:4566';
const EMAIL_BUCKET = process.env['EMAIL_BUCKET'] ?? 'ses-it-email';
const CONTENT_BUCKET = process.env['CONTENT_BUCKET'] ?? 'ses-it-content';
const QUEUE_URL = process.env['SIGNAL_QUEUE_URL'] ?? `${ENDPOINT}/000000000000/ses-it-signals`;
const CONTENT_CDN_BASE_URL = process.env['CONTENT_CDN_BASE_URL'] ?? `${ENDPOINT}/ses-it-content`;

// ---------------------------------------------------------------------------
// Harness interface
// ---------------------------------------------------------------------------

export interface ProcessorHarness {
  app: ReturnType<typeof createApp>;
  mockAuthress: MockAuthressServer;
  accountId: string;
  access: AccessService;
  sideEffects: SideEffectPayload[];
  sendEmail(messageId: string, rawMime: string | Buffer): Promise<void>;
  consumeAndProcess(): Promise<void>;
  teardown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const stubEmbeddingGenerator: EmbeddingGenerator = {
  async generateForModel(_text, modelId) {
    return ok({ modelId, vector: [], dimensions: 0 });
  },
  async generateForSecondaryClusters(_text) {
    return [];
  },
};

const stubAuroraWriter: MultiClusterAuroraWriter = {
  async upsertEmbedding(_opts) { return ok(undefined); },
  async findMatch(_opts) { return ok(null); },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createProcessorHarness(): Promise<ProcessorHarness> {
  const authressUrl = process.env['AUTHRESS_API_URL'] ?? 'http://localhost:4500';
  const authressPort = parseInt(new URL(authressUrl).port, 10) || 4500;
  const mockAuthress = await startMockAuthressServer(authressPort);

  const logger = createConsoleLogger();

  // forcePathStyle is required for MiniStack/LocalStack so presigned URLs use
  // http://localhost:4566/{bucket}/... rather than http://{bucket}.localhost:4566/...
  const isLocal = ENDPOINT.includes('localhost') || ENDPOINT.includes('127.0.0.1');
  const s3 = new S3Client(isLocal ? { forcePathStyle: true } : {});
  const sqs = new SQSClient({});

  // Provision S3 buckets and SQS queue (idempotent — CreateBucket is a no-op if it exists)
  const region = process.env['AWS_REGION'] ?? 'eu-central-1';
  const bucketConfig = region !== 'us-east-1' ? { CreateBucketConfiguration: { LocationConstraint: region as 'eu-central-1' } } : {};
  await s3.send(new CreateBucketCommand({ Bucket: EMAIL_BUCKET, ...bucketConfig })).catch(() => undefined);
  await s3.send(new CreateBucketCommand({ Bucket: CONTENT_BUCKET, ...bucketConfig })).catch(() => undefined);
  await sqs.send(new CreateQueueCommand({ QueueName: 'ses-it-signals' })).catch(() => undefined);

  const accountDb = new AccountDatabase(logger);
  const threadDb = new ThreadDatabase(logger);
  const auditDb = new AuditDatabase();
  const processingDb = new ProcessingDatabase();

  const sideEffects: SideEffectPayload[] = [];

  const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never,
    threadDb,
    accountDb,
    processingDb,
    contentSanitizer: new InProcessContentSanitizer(),
    classifier: {
      classify: async () => ok({ workflow: 'conversation' as const, workflowData: { workflow: 'conversation', sentiment: 'neutral', requiresReply: false } satisfies WorkflowData, tags: [], summary: '', labels: [] as string[], actions: [] }),
    },
    embeddingGenerator: stubEmbeddingGenerator,
    auroraWriter: stubAuroraWriter,
    threadMatcher: {
      findMatch: async () => ok(null),
      upsertEmbedding: async () => ok(undefined),
    },
    ruleEvaluator: new JsonLogicRuleEvaluator(logger, { invoke: async () => ({ success: true, result: undefined }) as never, validateAst: async () => ({ success: true }) as never, validateAstBatch: async () => ({ success: true }) as never } as unknown as UserCodeExecutorClient, { annotateRuleError: async () => ok(undefined) }),
    notifier: { notify: async () => ok(undefined) },
    forwardingService: { forward: async () => ok(undefined), sendVerification: async () => ok(undefined) },
    retentionService: { applyPlanRetention: async (s3Key, _input) => ({ s3Key }) },
    replySender: { sendReply: async () => ok({ messageId: 'stub-reply' }) },
    sqsDispatcher: { sendMessage: async (payload) => { sideEffects.push(payload); return ok(undefined); } },
    draftSendDispatcher: { dispatch: async () => ok(undefined) },
    userCodeExecutor: { invoke: async () => ({ success: true, result: undefined }) as never, validateAst: async () => ({ success: true }) as never, validateAstBatch: async () => ({ success: true }) as never } as unknown as UserCodeExecutorClient,
    billingHandler: new BillingHandler(),
    handlerRegistry: { dispatch: async () => ok(undefined) } as unknown as HandlerRegistry,
    schedulerClient: { createFollowup: async () => ok(undefined), deleteFollowup: async () => ok(undefined) } as unknown as SchedulerClient,
    calendarForwarderDeps: {
      emailService: { send: async () => ok({ messageId: 'stub-cal' }), sendRaw: async () => {} } as unknown as EmailService,
      serviceDomain: 'platform.email.rhosys.cloud',
      hmac: makeHmacGeneratorFake(),
    },
    logger,
    emailContentStore: new EmailContentStore(s3, EMAIL_BUCKET),
    contentStore: new ContentStore(s3, CONTENT_BUCKET),
  });

  const access: AccessService = {
    listUsers: async () => ok([]),
    getUserProfile: async () => ok({}),
    listAccountsForUser: async () => ok([]),
    addUser: async () => ok(undefined),
    updateUserRole: async () => ok(undefined),
    removeUser: async () => ok(undefined),
    checkAccess: async () => { /* noop */ },
    createInvite: async () => ok({ inviteId: 'mock-invite' }),
  };

  const app = createApp(makeAppDeps({
    threadDb,
    accountDb,
    auditDb,
    auth: new AuthressAuthService(),
    access,
    logger,
    forwardingService: { sendVerification: async () => ok(undefined), forward: async () => ok(undefined) },
    jobDispatcher: { dispatchReindex: async () => {}, dispatchSegment: async () => {} } as never,
    draftSendDispatcher: { dispatch: async () => ok(undefined) } as never,
    accountCreationStarter: { start: async () => {} },
    contentCdnBaseUrl: CONTENT_CDN_BASE_URL,
    astValidator: { validateAstBatch: async () => ({ success: true, purpose: 'validate_ast_batch', results: [] }) } as never,
    billingHandler: new BillingHandler(),
    emailService: { send: async () => ok({ messageId: 'stub' }), sendRaw: async () => {} } as unknown as EmailService,
    domainIdentityService: { register: async () => ok(undefined), deregister: async () => ok(undefined) },
    rsvpComposer: (async () => ok(undefined)) as unknown as typeof sendRsvp,
    postApprovalCalendarDeps: { accountDb: {} as never, emailService: {} as never, serviceDomain: 'platform.email.rhosys.cloud' } as unknown as PostApprovalCalendarHandlerDeps,
    schedulerClient: { scheduleMessage: async () => ok(undefined), deleteSchedule: async () => ok(undefined) } as never,
  }));

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
  // Helpers
  // ---------------------------------------------------------------------------

  async function sendEmail(messageId: string, rawMime: string | Buffer): Promise<void> {
    const s3Key = `emails/${messageId}`;
    const body = typeof rawMime === 'string' ? Buffer.from(rawMime) : rawMime;

    await s3.send(new PutObjectCommand({
      Bucket: EMAIL_BUCKET,
      Key: s3Key,
      Body: body,
      ContentType: 'message/rfc822',
    }));

    const inner = JSON.stringify({
      notificationType: 'Received',
      mail: {
        messageId,
        timestamp: new Date().toISOString(),
        destination: [`recipient@${accountId}.example.com`],
      },
      receipt: {
        dkimVerdict: { status: 'PASS' },
        dmarcVerdict: { status: 'PASS' },
        action: { objectKey: s3Key },
      },
      accountId,
    });

    await sqs.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({ Message: inner }),
    }));
  }

  async function consumeAndProcess(): Promise<void> {
    const { Messages } = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: QUEUE_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 5,
    }));

    if (!Messages?.length) throw new Error('No SQS message received within timeout');

    const record = Messages[0]!;
    const outer = JSON.parse(record.Body!) as { Message: string };
    const inner = JSON.parse(outer.Message) as {
      notificationType: string;
      mail: { messageId: string; timestamp: string; destination: string[] };
      receipt: { dkimVerdict: { status: SesVerdictStatus }; dmarcVerdict: { status: SesVerdictStatus }; action: { objectKey: string } };
      accountId?: string;
    };

    const message: InboundSignalMessage = {
      s3Key: inner.receipt.action.objectKey,
      compositeMailMessageId: `ses-${inner.mail.messageId}`,
      idempotencyKey: inner.mail.messageId,
      timestamp: inner.mail.timestamp,
      destination: inner.mail.destination,
      dkimVerdict: inner.receipt.dkimVerdict.status,
      dmarcVerdict: inner.receipt.dmarcVerdict.status,
    };

    const result = await processor.processInbound(message, 1);
    if (result.isErr()) throw new Error(`processInbound failed: ${JSON.stringify(result.error, null, 2)}`);

    await sqs.send(new DeleteMessageCommand({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: record.ReceiptHandle!,
    }));
  }

  return {
    app,
    mockAuthress,
    accountId,
    access,
    sideEffects,
    sendEmail,
    consumeAndProcess,
    async teardown() {
      mockAuthress.close();
    },
  };
}
