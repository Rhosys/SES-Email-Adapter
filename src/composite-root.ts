import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { S3Client } from "@aws-sdk/client-s3";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SFNClient } from "@aws-sdk/client-sfn";
import { KMSClient } from "@aws-sdk/client-kms";
import { OnboardingTaskHandler } from "./onboarding/onboarding-task-handler.js";
import { SfnAccountCreationStarter } from "./onboarding/account-creation-starter.js";
import type { AccountCreationStarter } from "./onboarding/account-creation-starter.js";
import { SignalClassifier } from "./classifier/classifier.js";
import { SignalProcessor } from "./processor/processor.js";
import { SqsDispatcherImpl } from "./processor/sqs-dispatcher.js";
import { LambdaContentSanitizer } from "./processor/content-sanitizer-client.js";
import { JsonLogicRuleEvaluator } from "./processor/rule-evaluator.js";
import { LambdaUserCodeExecutor } from "./processor/user-code-client.js";
import { AccountDatabase } from "./database/account-database.js";
import { ThreadDatabase } from "./database/thread-database.js";
import { ResourceDatabase } from "./database/resource-database.js";
import { ProcessingDatabase } from "./database/processing-database.js";
import { AuditDatabase } from "./database/audit-database.js";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import { DeviceNotifier } from "./notifier/device-notifier.js";
import { WsDeliverer } from "./notifier/ws-deliverer.js";
import { FcmDeliverer } from "./notifier/fcm-deliverer.js";
import { HttpFcmClient } from "./notifier/fcm-client.js";
import { ReplySenderService } from "./notifier/reply-sender.js";
import { DynamoDeviceStore } from "./notifier/device-store.js";
import { SesFeedbackProcessor } from "./notifier/ses-feedback-processor.js";
import { DomainHealthJob } from "./jobs/domain-health-job.js";
import { HealthcheckJob } from "./jobs/healthcheck-job.js";
import { HealthcheckValidator } from "./jobs/healthcheck-validator.js";
import { SesIdentityChecker } from "./email/ses-identity-checker.js";
import { checkDomain } from "./dns/dns-checker.js";
import { AuthressAuthService } from "./api/authress-auth.js";
import { AuthressAccessService } from "./api/authress-access.js";
import { createApp } from "./api/app.js";
import { EmailContentStore, ContentStore } from "./content-store.js";
import { BedrockEmbeddingGenerator } from "./embedding/embedding-generator.js";
import { createSearchDatabase } from "./database/thread-matcher.js";
import { S3RetentionServiceImpl } from "./embedding/s3-retention-service.js";
import { ReindexWorker } from "./jobs/reindex/reindex-worker.js";
import { AuthWorkflowHandler } from "./workflow/auth-handler.js";
import { HandlerRegistry } from "./workflow/registry.js";
import { FollowupHandler } from "./scheduler/followup-handler.js";
import { RsvpReminderHandler } from "./scheduler/rsvp-reminder-handler.js";
import { EventBridgeSchedulerClient } from "./scheduler/scheduler-client.js";
import { SchedulerClient as AwsSchedulerClient } from "@aws-sdk/client-scheduler";
import { EmailService } from "./email/email-service.js";
import { SesDomainIdentityService } from "./email/domain-identity-service.js";
import { ForwardingService } from "./forwarding/forwarding-service.js";
import { EmailSignalStore } from "./database/email-signal-store.js";
import { DigestDispatcher } from "./digest/digest-dispatcher.js";
import { DigestWorker } from "./digest/digest-worker.js";
import { UnsubscribeTokenGenerator } from "./email/unsubscribe-token-generator.js";
import { BillingHandler } from "./billing/billing-handler.js";
import { ReindexDispatcher } from "./jobs/reindex/reindex-dispatcher.js";
import { DraftSendDispatcher } from "./processor/draft-send-dispatcher.js";
import { DraftSendWorker } from "./processor/draft-send-worker.js";
import { sendRsvp } from "./processor/calendar/rsvp-composer.js";
import type { PostApprovalCalendarHandlerDeps } from "./processor/calendar/post-approval-handler.js";
import { HmacSecretGenerator } from "./processor/calendar/hmac-secret-generator.js";
import { SignalQueue } from "./messaging/signal-queue.js";
import { GmailProvider } from "./external-exchanges/gmail-provider.js";
import { OutlookProvider } from "./external-exchanges/outlook-provider.js";
import { ImapAdapter } from "./external-exchanges/imap-adapter.js";
import { JmapAdapter } from "./external-exchanges/jmap-adapter.js";
import { EmxInboundWorker } from "./external-exchanges/emx-inbound-worker.js";
import { EmxDispatchWorker } from "./external-exchanges/emx-dispatch-worker.js";
import type { ProviderAdapter } from "./external-exchanges/provider-adapter.js";
import { EncryptionManager } from "./secrets/encryption-manager.js";
import { getClient as getAuthressClient } from "./api/authress-access.js";
import { RequestLogger } from "./logger.js";

// ---------------------------------------------------------------------------
// Composition root
//
// Owns ALL dependency instantiation for the Lambda: AWS SDK clients, env-var
// reads, singletons, jobs/handlers/workers/services, and the Hono `app`. The
// handler destructures the wired instances it dispatches to; nothing is wired
// at module scope in handler.ts.
// ---------------------------------------------------------------------------

export class CompositeRoot {
  public readonly logger: RequestLogger;
  public readonly processor: SignalProcessor;
  public readonly onboardingHandler: OnboardingTaskHandler;
  public readonly domainHealthJob: DomainHealthJob;
  public readonly healthcheckJob: HealthcheckJob;
  public readonly reindexWorker: ReindexWorker;
  public readonly draftSendWorker: DraftSendWorker;
  public readonly followupHandler: FollowupHandler;
  public readonly rsvpReminderHandler: RsvpReminderHandler;
  public readonly digestDispatcher: DigestDispatcher;
  public readonly digestWorker: DigestWorker;
  public readonly sesFeedbackProcessor: SesFeedbackProcessor;
  public readonly authService: AuthressAuthService;
  public readonly deviceStore: DynamoDeviceStore;
  public readonly emxInboundWorker: EmxInboundWorker;
  public readonly emxDispatchWorker: EmxDispatchWorker;
  public readonly app: ReturnType<typeof createApp>;

  constructor() {
    // -----------------------------------------------------------------------
    // AWS SDK clients (reused across warm invocations)
    // -----------------------------------------------------------------------

    const bedrock = new BedrockRuntimeClient({});
    const s3 = new S3Client({});
    const lambda = new LambdaClient({});
    const sesv2 = new SESv2Client({});
    const sfn = new SFNClient({});
    const kms = new KMSClient({});

    const S3_BUCKET = process.env["EMAIL_BUCKET"]!;
    const CONTENT_CDN_BASE_URL = process.env["CONTENT_CDN_BASE_URL"]!;
    const CONTENT_SANITIZER_ARN = process.env["CONTENT_SANITIZER_ARN"]!;
    const USER_CODE_EXECUTOR_ARN = process.env["USER_CODE_EXECUTOR_ARN"]!;
    const WS_ENDPOINT = process.env["WS_API_ENDPOINT"]!;
    const FCM_PROJECT_ID = process.env["FCM_PROJECT_ID"]!;
    const FCM_SERVICE_ACCOUNT = JSON.parse(process.env["FCM_SERVICE_ACCOUNT"] ?? "{}") as { client_email: string; private_key: string };

    const SCHEDULER_GROUP_NAME = process.env["SCHEDULER_GROUP_NAME"] ?? "signal-followups";
    const SCHEDULER_ROLE_ARN = process.env["SCHEDULER_ROLE_ARN"] ?? "";
    const SIGNAL_QUEUE_ARN = process.env["SIGNAL_QUEUE_ARN"] ?? "";

    // -----------------------------------------------------------------------
    // Singletons
    // -----------------------------------------------------------------------

    const logger = new RequestLogger();

    const signalQueue = new SignalQueue(logger);

    const classifier = new SignalClassifier(bedrock, logger);

    const embeddingGenerator = new BedrockEmbeddingGenerator(bedrock, logger);

    const accountDb = new AccountDatabase(logger);
    const threadDb = new ThreadDatabase(logger);
    const resourceDb = new ResourceDatabase();
    const processingDb = new ProcessingDatabase();
    const auditDb = new AuditDatabase();
    const deviceStore = new DynamoDeviceStore();

    const SES_CONFIG_SET_ARN = process.env["SES_CONFIGURATION_SET_ARN"]!;
    const SES_CONFIG_SET_NAME = SES_CONFIG_SET_ARN.split("/").pop()!;
    const PLATFORM_TENANT = SES_CONFIG_SET_NAME.replace(/-sending$/, "-platform");
    const MAIL_DOMAIN = process.env["MAIL_DOMAIN"]!;
    const NOTIFICATION_FROM = `noreply@${MAIL_DOMAIN}`;
    const DKIM_PRIVATE_KEY = process.env["DKIM_PRIVATE_KEY"] ?? "";

    if (!MAIL_DOMAIN) {
      logger.error("MAIL_DOMAIN not set — cannot derive notification sender address", { code: "handler.env.mail_domain_missing" });
    }
    if (!DKIM_PRIVATE_KEY) {
      logger.error("DKIM_PRIVATE_KEY not set — domain identity registration will fail", { code: "handler.env.dkim_key_missing" });
    }

    const emailService = new EmailService(sesv2, { from: NOTIFICATION_FROM, configSetName: SES_CONFIG_SET_NAME, platformTenantName: PLATFORM_TENANT, mailDomain: MAIL_DOMAIN }, logger, processingDb);
    const domainIdentityService = new SesDomainIdentityService(
      sesv2, "mail", DKIM_PRIVATE_KEY, MAIL_DOMAIN, SES_CONFIG_SET_ARN,
    );

    // -----------------------------------------------------------------------
    // External Mail Exchanges (EMX)
    //
    // Constructed ahead of the send path: outbound mail from an alias backed by an external
    // mailbox has to go out through that provider, so ReplySenderService needs the adapters.
    // -----------------------------------------------------------------------

    /**
     * Fetches the provider access token Authress holds for a linked identity.
     *
     * `userId` is the Authress account user who linked the mailbox — the `userId` path
     * parameter of GET /v1/connections/{connectionId}/users/{userId}/credentials.
     * `connectionUserId` selects which of that user's (possibly several) identities linked
     * under `connectionId` to fetch credentials for — without it Authress returns whichever
     * identity logged in most recently, which is wrong when a user has linked more than one
     * mailbox through the same connection.
     */
    const getProviderToken = async (userId: string, connectionId: string, connectionUserId: string): Promise<string> => {
      const client = getAuthressClient();
      const response = await client.connections.getConnectionCredentials(connectionId, userId, connectionUserId);
      return response.data.accessToken;
    };

    const gmailProvider = new GmailProvider({
      db: accountDb,
      signalQueue,
      logger,
      getProviderToken,
    });

    const outlookProvider = new OutlookProvider({
      db: accountDb,
      signalQueue,
      logger,
      getProviderToken,
    });

    const encryptionManager = new EncryptionManager(kms);
    // Lazy init: KMS decrypt happens on first IMAP request (cold start resolves before traffic)
    void encryptionManager.init();

    const imapAdapter = new ImapAdapter({
      encryptionManager,
      db: accountDb,
      signalQueue,
      logger,
    });

    const jmapAdapter = new JmapAdapter({
      encryptionManager,
      db: accountDb,
      signalQueue,
      logger,
    });

    const emxAdapters: Record<string, ProviderAdapter> = {
      gmail: gmailProvider,
      outlook: outlookProvider,
      imap: imapAdapter,
      jmap: jmapAdapter,
    };

    const externalEmailHandler = new ReplySenderService({
      emailService,
      accountDb,
      adapters: emxAdapters,
      logger,
    });

    const API_DOMAIN = process.env["API_DOMAIN"] ?? "";
    const AUTHRESS_KMS_KEY_ARN = process.env["AUTHRESS_KMS_KEY_ARN"] ?? "";
    const AUTHRESS_KEY_ID = process.env["AUTHRESS_KEY_ID"] ?? "";
    const unsubscribeTokenGenerator = new UnsubscribeTokenGenerator(kms, API_DOMAIN, AUTHRESS_KMS_KEY_ARN, AUTHRESS_KEY_ID);

    const hmacSecretGenerator = new HmacSecretGenerator(kms);

    const emailSignalStore = new EmailSignalStore(s3, S3_BUCKET);
    const forwardingService = new ForwardingService(emailService, accountDb, emailSignalStore, MAIL_DOMAIN, logger);

    const draftSendDispatcher = new DraftSendDispatcher(signalQueue, logger);

    const wsDeliverer = new WsDeliverer(new ApiGatewayManagementApiClient({ endpoint: WS_ENDPOINT }));
    const authHandler = new AuthWorkflowHandler(deviceStore, wsDeliverer, threadDb, logger);
    const handlerRegistry = new HandlerRegistry([authHandler]);

    const schedulerClient = new EventBridgeSchedulerClient({
      client: new AwsSchedulerClient({}),
      groupName: SCHEDULER_GROUP_NAME,
      roleArn: SCHEDULER_ROLE_ARN,
      queueArn: SIGNAL_QUEUE_ARN,
      logger,
    });

    const searchDatabase = createSearchDatabase(logger);

    const processor = new SignalProcessor({
      threadDb,
      resourceDb,
      accountDb,
      processingDb,
      contentSanitizer: new LambdaContentSanitizer(lambda, CONTENT_SANITIZER_ARN, logger),
      userCodeExecutor: new LambdaUserCodeExecutor(lambda, USER_CODE_EXECUTOR_ARN, logger),
      classifier,
      embeddingGenerator,
      auroraWriter: searchDatabase,
      threadMatcher: searchDatabase,
      ruleEvaluator: new JsonLogicRuleEvaluator(logger, new LambdaUserCodeExecutor(lambda, USER_CODE_EXECUTOR_ARN, logger), accountDb),
      notifier: new DeviceNotifier({
        deviceStore: new DynamoDeviceStore(),
        deliverers: {
          websocket: wsDeliverer,
          fcm: new FcmDeliverer(new HttpFcmClient({ projectId: FCM_PROJECT_ID, credentials: FCM_SERVICE_ACCOUNT, logger })),
          apns: new FcmDeliverer(new HttpFcmClient({ projectId: FCM_PROJECT_ID, credentials: FCM_SERVICE_ACCOUNT, logger })),
        },
        logger,
      }),
      forwardingService,
      retentionService: new S3RetentionServiceImpl(s3),
      replySender: externalEmailHandler,
      sqsDispatcher: new SqsDispatcherImpl(signalQueue, logger),
      draftSendDispatcher,
      billingHandler: new BillingHandler(),
      handlerRegistry,
      calendarForwarderDeps: { emailService, serviceDomain: MAIL_DOMAIN, hmac: hmacSecretGenerator },
      schedulerClient,
      logger,
      emailContentStore: new EmailContentStore(s3),
      contentStore: new ContentStore(s3),
      platformTenantName: PLATFORM_TENANT,
    });

    const sesFeedbackProcessor = new SesFeedbackProcessor(processingDb, accountDb, logger, threadDb);

    const reindexWorker = new ReindexWorker(logger);

    const draftSendWorker = new DraftSendWorker(
      threadDb,
      externalEmailHandler,
      logger,
    );

    const domainHealthJob = new DomainHealthJob(accountDb, threadDb, logger);

    const healthcheckValidator = new HealthcheckValidator({
      threadDb,
      searchDatabase,
      sesChecker: new SesIdentityChecker(sesv2),
      dnsChecker: { checkDomain },
      mailDomain: MAIL_DOMAIN,
      logger,
    });

    const healthcheckJob = new HealthcheckJob({
      threadDb,
      emailService,
      mailDomain: MAIL_DOMAIN,
      logger,
      validator: healthcheckValidator,
    });

    const followupHandler = new FollowupHandler({
      threadDb,
      notifier: new DeviceNotifier({
        deviceStore,
        deliverers: {
          websocket: wsDeliverer,
          fcm: new FcmDeliverer(new HttpFcmClient({ projectId: FCM_PROJECT_ID, credentials: FCM_SERVICE_ACCOUNT, logger })),
          apns: new FcmDeliverer(new HttpFcmClient({ projectId: FCM_PROJECT_ID, credentials: FCM_SERVICE_ACCOUNT, logger })),
        },
        logger,
      }),
      logger,
    });

    const rsvpReminderHandler = new RsvpReminderHandler({
      threadDb,
      notifier: new DeviceNotifier({
        deviceStore,
        deliverers: {
          websocket: wsDeliverer,
          fcm: new FcmDeliverer(new HttpFcmClient({ projectId: FCM_PROJECT_ID, credentials: FCM_SERVICE_ACCOUNT, logger })),
          apns: new FcmDeliverer(new HttpFcmClient({ projectId: FCM_PROJECT_ID, credentials: FCM_SERVICE_ACCOUNT, logger })),
        },
        logger,
      }),
      logger,
    });

    // -----------------------------------------------------------------------
    // Digest (dispatch + worker)
    // -----------------------------------------------------------------------

    const digestDispatcher = new DigestDispatcher({
      accountDb,
      signalQueue,
      logger,
    });

    const digestWorker = new DigestWorker({
      accountDb,
      threadDb,
      signalDb: threadDb,
      emailService,
      unsubscribeTokenGenerator,
      logger,
    });

    const emxInboundWorker = new EmxInboundWorker({
      logger,
      emailContentStore: new EmailContentStore(s3),
      adapters: emxAdapters,
      accountDb,
      processor,
    });

    const emxDispatchWorker = new EmxDispatchWorker({
      logger,
      db: accountDb,
      adapters: emxAdapters,
    });

    // -----------------------------------------------------------------------
    // Onboarding (Step Function task handler + account creation starter)
    // -----------------------------------------------------------------------

    const onboardingHandler = new OnboardingTaskHandler(
      accountDb,
      threadDb,
      logger,
      emailService,
    );

    const ACCOUNT_CREATION_SFN_NAME = process.env["ACCOUNT_CREATION_SFN_NAME"] ?? "";
    const ACCOUNT_CREATION_SFN_ARN = ACCOUNT_CREATION_SFN_NAME
      ? `arn:aws:states:${process.env["AWS_REGION"]}:${process.env["AWS_ACCOUNT_ID"]}:stateMachine:${ACCOUNT_CREATION_SFN_NAME}`
      : "";
    let accountCreationStarter: AccountCreationStarter;
    if (!ACCOUNT_CREATION_SFN_ARN) {
      logger.warn("ACCOUNT_CREATION_SFN_ARN not set — account creation Step Function will not start", { code: "handler.sfn.arn_missing" });
      accountCreationStarter = { start: async () => {} };
    } else {
      accountCreationStarter = new SfnAccountCreationStarter(sfn, ACCOUNT_CREATION_SFN_ARN, logger);
    }

    const authService = new AuthressAuthService();

    const postApprovalCalendarDeps: PostApprovalCalendarHandlerDeps = {
      threadDb,
      accountDb,
      contentStore: new ContentStore(s3),
      calendarForwarderDeps: {
        emailService,
        serviceDomain: MAIL_DOMAIN,
        hmac: hmacSecretGenerator,
      },
      logger,
    };

    const app = createApp({
      threadDb,
      resourceDb,
      accountDb,
      auditDb,
      auth: authService,
      access: new AuthressAccessService(),
      logger,
      forwardingService,
      jobDispatcher: new ReindexDispatcher({ signalQueue, logger }),
      healthCheckValidator: healthcheckValidator,
      signalReprocessor: processor,
      draftSendDispatcher,
      accountCreationStarter,
      contentCdnBaseUrl: CONTENT_CDN_BASE_URL,
      astValidator: new LambdaUserCodeExecutor(lambda, USER_CODE_EXECUTOR_ARN, logger),
      billingHandler: new BillingHandler(),
      emailService,
      domainIdentityService,
      rsvpComposer: sendRsvp,
      postApprovalCalendarDeps,
      schedulerClient,
      emailContentStore: new EmailContentStore(s3),
      triggerDigest: async (accountId: string) => {
        const result = await signalQueue.send("digest_send", { accountId });
        if (result.isErr()) {
          logger.error("Failed to enqueue digest_send", { code: "composite_root.digest_trigger_failed", accountId, error: result.error });
        }
      },
      embeddingGenerator,
      threadMatcher: searchDatabase,
      unsubscribeTokenGenerator,
      gmailProvider,
      outlookProvider,
      adapters: emxAdapters,
      encryptionManager,
      getProviderToken,
      signalQueue,
    });

    // -----------------------------------------------------------------------
    // Expose the wired instances the handler dispatches to.
    // -----------------------------------------------------------------------

    this.logger = logger;
    this.processor = processor;
    this.onboardingHandler = onboardingHandler;
    this.domainHealthJob = domainHealthJob;
    this.healthcheckJob = healthcheckJob;
    this.reindexWorker = reindexWorker;
    this.draftSendWorker = draftSendWorker;
    this.followupHandler = followupHandler;
    this.rsvpReminderHandler = rsvpReminderHandler;
    this.digestDispatcher = digestDispatcher;
    this.digestWorker = digestWorker;
    this.sesFeedbackProcessor = sesFeedbackProcessor;
    this.authService = authService;
    this.deviceStore = deviceStore;
    this.emxInboundWorker = emxInboundWorker;
    this.emxDispatchWorker = emxDispatchWorker;
    this.app = app;
  }
}
