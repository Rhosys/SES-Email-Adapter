// Integration-test composition root.
//
// Mirrors src/composite-root.ts — same exposed shape (HandlerDependencies), so the real
// Lambda dispatch logic in src/create-handler.ts runs against it unchanged — but only wires
// the dependencies the integration suites actually exercise:
//
//   - Real: DynamoDB databases, S3 email/content stores (MiniStack), the content sanitizer
//     (in-process), the IncomingEmailProcessor and the Hono app.
//   - Stubbed: services MiniStack cannot serve or the suites don't assert on (Bedrock
//     classifier/embeddings, Aurora search, notifications, outbound email, scheduler).
//   - Not wired: every other handler dependency. Touching one throws, naming it, so a test
//     that starts depending on it fails loudly instead of silently running against a stub.
//
// Env vars (CI sets these from /tmp/integration-env.sh; defaults in parentheses):
//   AWS_ENDPOINT_URL (http://localhost:4566), EMAIL_BUCKET (ses-it-email),
//   CONTENT_BUCKET (ses-it-content), CONTENT_CDN_BASE_URL, plus the table names the
//   database classes read (ACCOUNTS_TABLE, SIGNALS_TABLE, PROCESSING_TABLE, AUDIT_TABLE).

import { S3Client } from '@aws-sdk/client-s3';
import type { HandlerDependencies } from '../src/create-handler.js';
import type { Logger } from '../src/logger.js';
import { AccountDatabase } from '../src/database/account-database.js';
import { ThreadDatabase } from '../src/database/thread-database.js';
import { AuditDatabase } from '../src/database/audit-database.js';
import { ProcessingDatabase } from '../src/database/processing-database.js';
import { EmailContentStore, ContentStore } from '../src/content-store.js';
import { IncomingEmailProcessor } from '../src/processor/incoming-email-processor.js';
import { JsonLogicRuleEvaluator } from '../src/processor/rule-evaluator.js';
import { CalendarForwarder } from '../src/processor/calendar/calendar-forwarder.js';
import { BillingHandler } from '../src/billing/billing-handler.js';
import { AuthressAuthService } from '../src/api/authress-auth.js';
import { createApp } from '../src/api/app.js';
import type { AccessService } from '../src/api/app.js';
import { ok } from '../src/errors.js';
import type { WorkflowData } from '../src/types/index.js';
import type { EmailService } from '../src/email/email-service.js';
import type { PostApprovalCalendarHandlerDeps } from '../src/processor/calendar/post-approval-handler.js';
import type { UserCodeExecutorClient } from '../src/processor/user-code-client.js';
import type { HandlerRegistry } from '../src/workflow/registry.js';
import type { SchedulerClient } from '../src/scheduler/scheduler-client.js';
import type { EmbeddingGenerator } from '../src/embedding/embedding-generator.js';
import type { MultiClusterAuroraWriter } from '../src/database/thread-matcher.js';
import { makeAppDeps } from '../tests/helpers/app-deps.js';
import { makeHmacGeneratorFake } from '../tests/helpers/hmac-generator-fake.js';
import { createConsoleLogger } from '../tests/helpers/console-logger.js';
import { InProcessContentSanitizer } from './in-process-content-sanitizer.js';

const ENDPOINT = process.env['AWS_ENDPOINT_URL'] ?? 'http://localhost:4566';
export const EMAIL_BUCKET = process.env['EMAIL_BUCKET'] ?? 'ses-it-email';
export const CONTENT_BUCKET = process.env['CONTENT_BUCKET'] ?? 'ses-it-content';
const CONTENT_CDN_BASE_URL = process.env['CONTENT_CDN_BASE_URL'] ?? `${ENDPOINT}/ses-it-content`;
const MAIL_DOMAIN = 'platform.email.rhosys.cloud';

/** A dependency the integration suites are not expected to reach. Any property access throws. */
function notWired<T>(name: string): T {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return undefined; // not a thenable, so `await`-ing it is harmless
      throw new Error(`IntegrationCompositeRoot.${name}.${String(prop)} was used but is not wired — wire it in tests-integration/integration-composite-root.ts if the test needs it.`);
    },
  }) as T;
}

export class IntegrationCompositeRoot implements HandlerDependencies {
  // Wired
  public readonly logger: Logger;
  public readonly processor: IncomingEmailProcessor;
  public readonly mailDomain = MAIL_DOMAIN;
  public readonly app: ReturnType<typeof createApp>;
  /** S3 client signed for MiniStack, for suites that seed the email bucket directly. */
  public readonly s3: S3Client;
  /** Mutable stub — suites may reassign individual methods between calls. */
  public readonly access: AccessService;

  // Not wired — no integration suite reaches these yet.
  public readonly rsvpProcessor = notWired<HandlerDependencies['rsvpProcessor']>('rsvpProcessor');
  public readonly onboardingHandler = notWired<HandlerDependencies['onboardingHandler']>('onboardingHandler');
  public readonly domainHealthJob = notWired<HandlerDependencies['domainHealthJob']>('domainHealthJob');
  public readonly healthcheckJob = notWired<HandlerDependencies['healthcheckJob']>('healthcheckJob');
  public readonly reindexWorker = notWired<HandlerDependencies['reindexWorker']>('reindexWorker');
  public readonly draftSendWorker = notWired<HandlerDependencies['draftSendWorker']>('draftSendWorker');
  public readonly followupHandler = notWired<HandlerDependencies['followupHandler']>('followupHandler');
  public readonly rsvpReminderHandler = notWired<HandlerDependencies['rsvpReminderHandler']>('rsvpReminderHandler');
  public readonly digestDispatcher = notWired<HandlerDependencies['digestDispatcher']>('digestDispatcher');
  public readonly digestWorker = notWired<HandlerDependencies['digestWorker']>('digestWorker');
  public readonly sesFeedbackProcessor = notWired<HandlerDependencies['sesFeedbackProcessor']>('sesFeedbackProcessor');
  public readonly authService = notWired<HandlerDependencies['authService']>('authService');
  public readonly deviceStore = notWired<HandlerDependencies['deviceStore']>('deviceStore');
  public readonly emxInboundWorker = notWired<HandlerDependencies['emxInboundWorker']>('emxInboundWorker');
  public readonly emxDispatchWorker = notWired<HandlerDependencies['emxDispatchWorker']>('emxDispatchWorker');
  public readonly emxIdleWorker = notWired<HandlerDependencies['emxIdleWorker']>('emxIdleWorker');
  public readonly wsDeliverer = notWired<HandlerDependencies['wsDeliverer']>('wsDeliverer');

  constructor() {
    // -----------------------------------------------------------------------
    // AWS SDK clients
    // -----------------------------------------------------------------------

    // forcePathStyle is required for MiniStack so presigned URLs use
    // http://localhost:4566/{bucket}/... rather than http://{bucket}.localhost:4566/...
    // Explicit test/test credentials are mandatory: a presigned URL embeds the access
    // key id as a query param that MiniStack validates, and it only recognises test/test
    // (any other key — including an ambient ~/.aws/SSO key — returns InvalidAccessKeyId
    // on a presigned GET). Direct SDK calls accept any key, so only the presigned path
    // (content sanitizer MIME fetch) exposes this.
    const isLocal = ENDPOINT.includes('localhost') || ENDPOINT.includes('127.0.0.1');
    const s3 = new S3Client(isLocal
      ? { forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }
      : {});

    // -----------------------------------------------------------------------
    // Singletons
    // -----------------------------------------------------------------------

    const logger = createConsoleLogger();

    const accountDb = new AccountDatabase(logger);
    const threadDb = new ThreadDatabase(logger);
    const processingDb = new ProcessingDatabase();
    const auditDb = new AuditDatabase();

    // Stubs for services MiniStack cannot serve (Bedrock, Aurora) or outbound side effects.
    const embeddingGenerator: EmbeddingGenerator = {
      async generateForModel(_text, modelId) { return ok({ modelId, vector: [], dimensions: 0 }); },
      async generateForSecondaryClusters(_text) { return []; },
    };
    const auroraWriter: MultiClusterAuroraWriter = {
      async upsertEmbedding(_opts) { return ok(undefined); },
      async findMatch(_opts) { return ok(null); },
    };
    const userCodeExecutor = {
      invoke: async () => ({ success: true, result: undefined }) as never,
      validateAst: async () => ({ success: true }) as never,
      validateAstBatch: async () => ({ success: true }) as never,
    } as unknown as UserCodeExecutorClient;
    const emailService = { send: async () => ok({ messageId: 'stub' }), sendRaw: async () => ok({ messageId: 'stub' }) } as unknown as EmailService;
    const forwardingService = { forward: async () => ok(undefined), sendVerification: async () => ok(undefined) };
    const draftSendDispatcher = { dispatch: async () => ok(undefined) };
    const calendarForwarder = new CalendarForwarder({ emailService, serviceDomain: MAIL_DOMAIN, hmac: makeHmacGeneratorFake() });

    const access: AccessService = {
      listUsers: async () => ok([]),
      getUserProfile: async () => ok({}),
      listAccountsForUser: async () => ok([]),
      addUser: async () => ok(undefined),
      updateUserRole: async () => ok(undefined),
      removeUser: async () => ok(undefined),
      checkAccess: async () => { /* noop */ },
      createInvite: async () => ok({ inviteId: 'mock-invite' }),
      getLinkedIdentity: async () => ok({ connectionUserId: 'google-sub-12345' }),
    };

    // -----------------------------------------------------------------------
    // Inbound email processor
    // -----------------------------------------------------------------------

    const processor = new IncomingEmailProcessor({
      threadDb,
      resourceDb: { saveResource: async () => ok(undefined) } as never,
      accountDb,
      processingDb,
      contentSanitizer: new InProcessContentSanitizer(),
      userCodeExecutor,
      classifier: {
        classify: async () => ok({ workflow: 'conversation' as const, workflowData: { workflow: 'conversation', sentiment: 'neutral', requiresReply: false } satisfies WorkflowData, tags: [], summary: '', labels: [] as string[], actions: [] }),
      },
      embeddingGenerator,
      auroraWriter,
      threadMatcher: {
        findMatch: async () => ok(null),
        upsertEmbedding: async () => ok(undefined),
        deleteEmbeddingsForThread: async () => ok(undefined),
      },
      ruleEvaluator: new JsonLogicRuleEvaluator(logger, userCodeExecutor, { annotateRuleError: async () => ok(undefined) }),
      notifier: { notifySignal: async () => ok(undefined), notifyThread: async () => ok(undefined), notifyBlocked: async () => ok(undefined) },
      forwardingService,
      retentionService: { applyPlanRetention: async (s3Key, _input) => ({ s3Key }) },
      replySender: { sendReply: async () => ok({ messageId: 'stub-reply' }) },
      sqsDispatcher: { sendMessage: async () => ok(undefined) },
      draftSendDispatcher,
      billingHandler: new BillingHandler(),
      handlerRegistry: { dispatch: async () => ok(undefined) } as unknown as HandlerRegistry,
      calendarForwarder,
      schedulerClient: { createFollowup: async () => ok(undefined), deleteFollowup: async () => ok(undefined) } as unknown as SchedulerClient,
      logger,
      emailContentStore: new EmailContentStore(s3, EMAIL_BUCKET),
      contentStore: new ContentStore(s3, CONTENT_BUCKET),
      accessService: { listUsers: async () => ok([]), getUserProfile: async () => ok({}) },
      platformTenantName: 'test-platform',
    });

    // -----------------------------------------------------------------------
    // API
    // -----------------------------------------------------------------------

    const app = createApp(makeAppDeps({
      threadDb,
      accountDb,
      auditDb,
      auth: new AuthressAuthService(),
      access,
      logger,
      forwardingService,
      jobDispatcher: { dispatchReindex: async () => {}, dispatchSegment: async () => {} } as never,
      draftSendDispatcher: draftSendDispatcher as never,
      accountCreationStarter: { start: async () => {} },
      contentCdnBaseUrl: CONTENT_CDN_BASE_URL,
      astValidator: { validateAstBatch: async () => ({ success: true, purpose: 'validate_ast_batch', results: [] }) } as never,
      billingHandler: new BillingHandler(),
      emailService,
      domainIdentityService: { register: async () => ok(undefined), deregister: async () => ok(undefined) },
      calendarForwarder,
      postApprovalCalendarDeps: { accountDb: {} as never, emailService: {} as never, serviceDomain: MAIL_DOMAIN } as unknown as PostApprovalCalendarHandlerDeps,
      schedulerClient: { scheduleMessage: async () => ok(undefined), deleteSchedule: async () => ok(undefined) } as never,
    }));

    // -----------------------------------------------------------------------
    // Expose the wired instances.
    // -----------------------------------------------------------------------

    this.logger = logger;
    this.processor = processor;
    this.app = app;
    this.s3 = s3;
    this.access = access;
  }
}
