// Processor integration harness.
//
// Extends the base harness with real S3, SQS, and SignalProcessor wired to
// MiniStack. Provides helpers to upload a raw MIME email, send an SNS-wrapped
// SQS message, poll the queue, and call processRecord().
//
// Required env vars (in addition to those in harness.ts):
//   PROCESSING_TABLE      — DynamoDB processing table name
//   EMAIL_BUCKET          — S3 bucket for raw MIME emails (ses-it-email)
//   CONTENT_BUCKET        — S3 bucket for extracted content (ses-it-content)
//   SIGNAL_QUEUE_URL      — SQS queue URL (http://localhost:4566/.../ses-it-signals)
//   CONTENT_CDN_BASE_URL  — CDN base for attachment URLs

import { S3Client, CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, CreateQueueCommand, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { AccountDatabase } from '../../src/database/account-database.js';
import { ArcDatabase } from '../../src/database/arc-database.js';
import { AuditDatabase } from '../../src/database/audit-database.js';
import { ProcessingDatabase } from '../../src/database/processing-database.js';
import { SignalProcessor } from '../../src/processor/processor.js';
import type { InboundSignalMessage, SideEffectPayload, SesVerdict } from '../../src/processor/processor.js';
import { JsonLogicRuleEvaluator } from '../../src/processor/rule-evaluator.js';
import { createApp } from '../../src/api/app.js';
import { makeAppDeps } from '../helpers/app-deps.js';
import { AuthressAuthService } from '../../src/api/authress-auth.js';
import { startMockAuthressServer } from './mock-authress.js';
import type { MockAuthressServer } from './mock-authress.js';
import { InProcessContentSanitizer } from './in-process-content-sanitizer.js';
import { createConsoleLogger } from './logger.js';
import { ok } from '../../src/errors.js';
import { generateId } from '../../src/utils/id.js';
import type { AccessService } from '../../src/api/app.js';
import type { EmailService } from '../../src/email/email-service.js';
import type { sendRsvp } from '../../src/processor/calendar/rsvp-composer.js';
import type { PostApprovalCalendarHandlerDeps } from '../../src/processor/calendar/post-approval-handler.js';
import type { EmbeddingGenerator } from '../../src/embedding/embedding-generator.js';
import type { MultiClusterAuroraWriter } from '../../src/database/arc-matcher.js';
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
  sendEmail(sesMessageId: string, rawMime: string | Buffer): Promise<void>;
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

  const accountDb = new AccountDatabase();
  const arcDb = new ArcDatabase(logger);
  const auditDb = new AuditDatabase();
  const processingDb = new ProcessingDatabase();

  // Seed a test account
  const accountId = generateId('acc-');
  await accountDb.createAccount({
    id: accountId,
    name: 'Integration Test Account',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const sideEffects: SideEffectPayload[] = [];

  const processor = new SignalProcessor({
    arcDb,
    accountDb,
    processingDb,
    contentSanitizer: new InProcessContentSanitizer(),
    classifier: {
      classify: async () => ok({ workflow: 'conversation' as const, workflowData: { workflow: 'conversation', sentiment: 'neutral', requiresReply: false } satisfies WorkflowData, tags: [], summary: '', labels: [] as string[] }),
    },
    embeddingGenerator: stubEmbeddingGenerator,
    auroraWriter: stubAuroraWriter,
    arcMatcher: {
      findMatch: async () => ok(null),
      upsertEmbedding: async () => ok(undefined),
    },
    ruleEvaluator: new JsonLogicRuleEvaluator(logger, { invoke: async () => ({ success: true, result: undefined }) as never, validateAst: async () => ({ success: true }) as never, validateAstBatch: async () => ({ success: true }) as never } as unknown as UserCodeExecutorClient, { annotateRuleError: async () => ok(undefined) }),
    notifier: { notify: async () => ok(undefined) },
    forwarder: { forward: async () => ok(undefined) },
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
    },
    logger,
    s3Client: s3,
    emailBucket: EMAIL_BUCKET,
    contentBucket: CONTENT_BUCKET,
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
    arcDb,
    accountDb,
    auditDb,
    auth: new AuthressAuthService(),
    access,
    logger,
    verificationMailer: { sendForwardVerification: async () => ok(undefined), sendCalendarForwardVerification: async () => ok(undefined) },
    jobDispatcher: { dispatchReindex: async () => {}, dispatchSegment: async () => {} } as never,
    draftSendDispatcher: { dispatch: async () => ok(undefined) } as never,
    accountCreationStarter: { start: async () => {} },
    appBaseUrl: 'http://localhost:3000',
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
  // Helpers
  // ---------------------------------------------------------------------------

  async function sendEmail(sesMessageId: string, rawMime: string | Buffer): Promise<void> {
    const s3Key = `emails/${sesMessageId}`;
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
        messageId: sesMessageId,
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
      receipt: { dkimVerdict: { status: SesVerdict }; dmarcVerdict: { status: SesVerdict }; action: { objectKey: string } };
      accountId?: string;
    };

    const message: InboundSignalMessage = {
      accountId: inner.accountId ?? inner.mail.destination[0]!,
      s3Key: inner.receipt.action.objectKey,
      sesMessageId: inner.mail.messageId,
      timestamp: inner.mail.timestamp,
      destination: inner.mail.destination,
      dkimVerdict: inner.receipt.dkimVerdict.status,
      dmarcVerdict: inner.receipt.dmarcVerdict.status,
    };

    const result = await processor.processRecord(message, 1);
    if (result.isErr()) throw new Error(`processRecord failed: ${JSON.stringify(result.error, null, 2)}`);

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
