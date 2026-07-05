import type { APIGatewayProxyEventV2, SQSEvent, Context, APIGatewayProxyResultV2, EventBridgeEvent, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { S3Client } from "@aws-sdk/client-s3";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SFNClient } from "@aws-sdk/client-sfn";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { SQS_MESSAGE_TYPES } from "./types/index.js";
import type { Signal } from "./types/index.js";
import { ok, err } from "./errors.js";
import type { Result, DbError } from "./errors.js";
import { isStepFunctionTaskEvent } from "./onboarding/types.js";
import { OnboardingTaskHandler } from "./onboarding/onboarding-task-handler.js";
import { SfnAccountCreationStarter } from "./onboarding/account-creation-starter.js";
import type { AccountCreationStarter } from "./onboarding/account-creation-starter.js";

const [MSG_TYPE_REINDEX, MSG_TYPE_SIDE_EFFECT, MSG_TYPE_DRAFT_SEND, MSG_TYPE_SIGNAL_FOLLOWUP, MSG_TYPE_RSVP_REMINDER, MSG_TYPE_DIGEST_DISPATCH, MSG_TYPE_DIGEST_SEND] = SQS_MESSAGE_TYPES;
import { SignalClassifier } from "./classifier/classifier.js";
import { SignalProcessor } from "./processor/processor.js";
import type { InboundSignalMessage, SideEffectPayload, SesVerdict } from "./processor/processor.js";
import { SqsDispatcherImpl } from "./processor/sqs-dispatcher.js";
import { LambdaContentSanitizer } from "./processor/content-sanitizer-client.js";
import { JsonLogicRuleEvaluator } from "./processor/rule-evaluator.js";
import { LambdaUserCodeExecutor } from "./processor/user-code-client.js";
import { AccountDatabase } from "./database/account-database.js";
import { ThreadDatabase } from "./database/thread-database.js";
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
import { FeedbackProcessor } from "./notifier/feedback-processor.js";
import { DomainHealthJob } from "./jobs/domain-health-job.js";
import { AuthressAuthService } from "./api/authress-auth.js";
import { AuthressAccessService } from "./api/authress-access.js";
import { createApp } from "./api/app.js";
import { BedrockEmbeddingGenerator } from "./embedding/embedding-generator.js";
import { createSearchDatabase } from "./database/thread-matcher.js";
import { S3RetentionServiceImpl } from "./embedding/s3-retention-service.js";
import { ReindexWorker } from "./jobs/reindex/reindex-worker.js";
import { AuthWorkflowHandler } from "./workflow/auth-handler.js";
import { HandlerRegistry } from "./workflow/registry.js";
import { FollowupHandler } from "./scheduler/followup-handler.js";
import type { FollowupMessage } from "./scheduler/followup-handler.js";
import { RsvpReminderHandler } from "./scheduler/rsvp-reminder-handler.js";
import type { RsvpReminderMessage } from "./scheduler/rsvp-reminder.js";
import { EventBridgeSchedulerClient } from "./scheduler/scheduler-client.js";
import { SchedulerClient as AwsSchedulerClient } from "@aws-sdk/client-scheduler";

import { EmailService } from "./email/email-service.js";
import { SesDomainIdentityService } from "./email/domain-identity-service.js";
import { ForwardingService } from "./forwarding/forwarding-service.js";
import { EmailSignalStore } from "./database/email-signal-store.js";
import { DigestDispatcher } from "./digest/digest-dispatcher.js";
import { DigestWorker } from "./digest/digest-worker.js";
import type { IDigestSendMessage } from "./digest/digest-worker.js";
import { BillingHandler } from "./billing/billing-handler.js";
import { ReindexDispatcher } from "./jobs/reindex/reindex-dispatcher.js";
import type { ReindexSegmentMessage } from "./jobs/reindex/reindex-dispatcher.js";
import { DraftSendDispatcher } from "./processor/draft-send-dispatcher.js";
import type { DraftSendPayload } from "./processor/draft-send-dispatcher.js";
import { DraftSendWorker } from "./processor/draft-send-worker.js";
import { sendRsvp } from "./processor/calendar/rsvp-composer.js";
import type { PostApprovalCalendarHandlerDeps } from "./processor/calendar/post-approval-handler.js";
import { RequestLogger } from "./logger.js";
import { DateTime } from "luxon";

// ---------------------------------------------------------------------------
// AWS SDK clients (reused across warm invocations)
// ---------------------------------------------------------------------------

const bedrock = new BedrockRuntimeClient({});
const s3 = new S3Client({});
const lambda = new LambdaClient({});
const sesv2 = new SESv2Client({});
const sqs = new SQSClient({});
const sfn = new SFNClient({});

const S3_BUCKET = process.env["EMAIL_BUCKET"]!;
const CONTENT_BUCKET = process.env["CONTENT_BUCKET"]!;
const CONTENT_CDN_BASE_URL = process.env["CONTENT_CDN_BASE_URL"]!;
const CONTENT_SANITIZER_ARN = process.env["CONTENT_SANITIZER_ARN"]!;
const USER_CODE_EXECUTOR_ARN = process.env["USER_CODE_EXECUTOR_ARN"]!;
const SIGNAL_QUEUE_URL = process.env["SIGNAL_QUEUE_URL"]!;
const WS_ENDPOINT = process.env["WS_API_ENDPOINT"]!;
const FCM_PROJECT_ID = process.env["FCM_PROJECT_ID"]!;
const FCM_SERVICE_ACCOUNT = JSON.parse(process.env["FCM_SERVICE_ACCOUNT"] ?? "{}") as { client_email: string; private_key: string };
const RETRY_TRACK_THRESHOLD = 30;

const SCHEDULER_GROUP_NAME = process.env["SCHEDULER_GROUP_NAME"] ?? "signal-followups";
const SCHEDULER_ROLE_ARN = process.env["SCHEDULER_ROLE_ARN"] ?? "";
const SIGNAL_QUEUE_ARN = process.env["SIGNAL_QUEUE_ARN"] ?? "";

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

const logger = new RequestLogger();

const classifier = new SignalClassifier(bedrock, logger);

const embeddingGenerator = new BedrockEmbeddingGenerator(bedrock, logger);

const accountDb = new AccountDatabase(logger);
const threadDb = new ThreadDatabase(logger);
const processingDb = new ProcessingDatabase();
const auditDb = new AuditDatabase();
const deviceStore = new DynamoDeviceStore();

const SES_CONFIG_SET_ARN = process.env["SES_CONFIGURATION_SET_ARN"]!;
const SES_CONFIG_SET_NAME = SES_CONFIG_SET_ARN.split("/").pop()!;
const MAIL_DOMAIN = process.env["MAIL_DOMAIN"]!;
const NOTIFICATION_FROM = `noreply@${MAIL_DOMAIN}`;
const DKIM_PRIVATE_KEY = process.env["DKIM_PRIVATE_KEY"] ?? "";

if (!MAIL_DOMAIN) {
  logger.error("MAIL_DOMAIN not set — cannot derive notification sender address", { code: "handler.env.mail_domain_missing" });
}
if (!DKIM_PRIVATE_KEY) {
  logger.error("DKIM_PRIVATE_KEY not set — domain identity registration will fail", { code: "handler.env.dkim_key_missing" });
}

const emailService = new EmailService(sesv2, { from: NOTIFICATION_FROM, configSetName: SES_CONFIG_SET_NAME }, logger);
const domainIdentityService = new SesDomainIdentityService(
  sesv2, "mail", DKIM_PRIVATE_KEY, MAIL_DOMAIN, SES_CONFIG_SET_ARN,
);

const externalEmailHandler = new ReplySenderService(emailService, logger);

const APP_BASE_URL = process.env["APP_BASE_URL"] ?? "";
const emailSignalStore = new EmailSignalStore(s3, S3_BUCKET);
const forwardingService = new ForwardingService(emailService, accountDb, emailSignalStore, APP_BASE_URL, MAIL_DOMAIN, logger);

const draftSendDispatcher = new DraftSendDispatcher(SIGNAL_QUEUE_URL, sqs, logger);

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
  sqsDispatcher: new SqsDispatcherImpl(SIGNAL_QUEUE_URL, sqs, logger),
  draftSendDispatcher,
  billingHandler: new BillingHandler(),
  handlerRegistry,
  calendarForwarderDeps: { emailService, serviceDomain: MAIL_DOMAIN },
  schedulerClient,
  logger,
  s3Client: s3,
  emailBucket: S3_BUCKET,
  contentBucket: CONTENT_BUCKET,
});

const feedbackProcessor = new FeedbackProcessor(processingDb, accountDb, logger, threadDb);

const reindexWorker = new ReindexWorker(logger);

const draftSendWorker = new DraftSendWorker(
  threadDb,
  externalEmailHandler,
  logger,
);

const domainHealthJob = new DomainHealthJob(accountDb, threadDb, logger);

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

// ---------------------------------------------------------------------------
// Digest (dispatch + worker)
// ---------------------------------------------------------------------------

const digestDispatcher = new DigestDispatcher({
  accountDb,
  sqsClient: sqs,
  queueUrl: SIGNAL_QUEUE_URL,
  logger,
});

const digestWorker = new DigestWorker({
  accountDb,
  threadDb,
  signalDb: threadDb,
  emailService,
  logger,
});

// ---------------------------------------------------------------------------
// Onboarding (Step Function task handler + account creation starter)
// ---------------------------------------------------------------------------

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
  s3Client: s3,
  contentBucket: CONTENT_BUCKET,
  calendarForwarderDeps: {
    emailService,
    serviceDomain: MAIL_DOMAIN,
  },
  logger,
};

const app = createApp({
  threadDb,
  accountDb,
  auditDb,
  auth: authService,
  access: new AuthressAccessService(),
  logger,
  forwardingService,
  jobDispatcher: new ReindexDispatcher({ logger }),
  signalReprocessor: processor,
  draftSendDispatcher,
  accountCreationStarter,
  appBaseUrl: APP_BASE_URL,
  contentCdnBaseUrl: CONTENT_CDN_BASE_URL,
  astValidator: new LambdaUserCodeExecutor(lambda, USER_CODE_EXECUTOR_ARN, logger),
  billingHandler: new BillingHandler(),
  emailService,
  domainIdentityService,
  rsvpComposer: sendRsvp,
  postApprovalCalendarDeps,
  schedulerClient,
  s3Client: s3,
  emailBucket: S3_BUCKET,
  triggerDigest: async (accountId: string) => {
    await sqs.send(new SendMessageCommand({
      QueueUrl: SIGNAL_QUEUE_URL,
      MessageBody: JSON.stringify({ accountId }),
      MessageAttributes: { messageType: { DataType: "String", StringValue: "digest_send" } },
    }));
  },
});

// ---------------------------------------------------------------------------
// Lambda entry point
// ---------------------------------------------------------------------------

export async function handler(
  event: APIGatewayProxyEventV2 | APIGatewayProxyWebsocketEventV2 | SQSEvent | EventBridgeEvent<string, { source?: string }> | unknown,
  _context: Context,
): Promise<APIGatewayProxyResultV2 | WsAuthorizerResult | HttpAuthorizerResponse | { statusCode: number } | { batchItemFailures: Array<{ itemIdentifier: string }> } | unknown> {
  const cfRequestId = (event as APIGatewayProxyEventV2)?.headers?.["x-amz-cf-id"] ?? "";
  const apiGwRequestId = (event as APIGatewayProxyEventV2)?.requestContext?.requestId ?? "";
  const lambdaRequestId = _context.awsRequestId ?? "";
  const compositeId = `CF${cfRequestId}-API${apiGwRequestId}-L${lambdaRequestId}`;
  logger.startInvocation(compositeId);

  try {
  return await handlerInner(event, _context);
  } catch (e) {
    logger.critical("Unhandled top-level exception in Lambda handler. This should never happen — all code paths must handle their own errors.", { code: "handler.unhandled_exception", error: e, event });
    return { statusCode: 500, headers: { "x-request-id": compositeId }, body: JSON.stringify({ title: "Internal Server Error", errorId: compositeId }) };
  }
}

async function handlerInner(
  event: APIGatewayProxyEventV2 | APIGatewayProxyWebsocketEventV2 | SQSEvent | EventBridgeEvent<string, { source?: string }> | unknown,
  _context: Context,
): Promise<APIGatewayProxyResultV2 | WsAuthorizerResult | HttpAuthorizerResponse | { statusCode: number } | { batchItemFailures: Array<{ itemIdentifier: string }> } | unknown> {

  if (isStepFunctionTaskEvent(event)) {
    const { context } = event;
    const processorId = `${context.StateMachine.Name}|${context.State.Name}`;
    const payload = context.Execution.Input;

    if (!payload?.accountId || !payload?.email) {
      logger.warn("Step Function task missing required Input fields", { code: "handler.sfn.missing_input", processorId });
      return {};
    }

    const processors: Record<string, () => Promise<unknown>> = {
      "email-catcher-AccountCreation|FirstFollowup": () => onboardingHandler.handleFollowup(payload.accountId, payload.email),
      "email-catcher-AccountCreation|Cleanup": () => onboardingHandler.handleCleanup(payload.accountId, payload.email),
      "email-catcher-AccountCreation|TrialCheck": () => onboardingHandler.handleTrialCheck(payload.accountId, context.Execution.StartTime),
    };

    const processor = processors[processorId];
    if (!processor) {
      logger.warn("Unknown Step Function task", { code: "handler.sfn.unknown_task", processorId });
      return {};
    }
    const result = await processor();
    if (result && typeof result === "object" && "isErr" in result) {
      if ((result as { isErr(): boolean }).isErr()) {
        const error = (result as unknown as { error: unknown }).error;
        logger.error("Step Function task failed", { code: "handler.sfn.task_failed", processorId, error });
        throw new Error(`SFN task ${processorId} failed: ${JSON.stringify(error)}`);
      }
      return (result as unknown as { value: unknown }).value;
    }
    return result;
  }

  if (isEventBridgeEvent(event)) {
    const ebEvent = event as EventBridgeEvent<string, unknown>;
    const ruleName = ebEvent.resources?.[0]?.split("/").pop();
    if (ruleName?.endsWith("-domain-health")) {
      await domainHealthJob.run();
    }
    return;
  }
  if (isSqsEvent(event)) {
    const failures: Array<{ itemIdentifier: string }> = [];

    for (const record of event.Records) {
      const receiveCount = Number(record.attributes?.ApproximateReceiveCount ?? "1");

      let body: unknown;
      try {
        body = JSON.parse(record.body);
      } catch (e) {
        logger.error("Failed to parse SQS record body as JSON.", { code: "handler.sqs.parse_failed", messageId: record.messageId, error: e });
        failures.push({ itemIdentifier: record.messageId });
        continue;
      }

      const messageType = record.messageAttributes?.["messageType"]?.stringValue ?? (body as { sqsMessageAttributeMessageType?: string }).sqsMessageAttributeMessageType;
      const result = await processSqsRecord(body, messageType, receiveCount, record.messageId);

      if (result.isErr()) {
        if (receiveCount > RETRY_TRACK_THRESHOLD) {
          logger.error("SQS message failed after exceeding retry threshold.", { code: "handler.sqs.retry_threshold_exceeded", messageId: record.messageId, receiveCount, messageType, error: result.error, record });
        } else {
          logger.info("SQS message processing failed. Will be retried automatically.", { code: "handler.sqs.processing_failed", messageId: record.messageId, receiveCount, messageType, error: result.error, record });
        }
        failures.push({ itemIdentifier: record.messageId });
      }
    }

    return { batchItemFailures: failures };
  }
  if (isWsAuthorizerEvent(event)) {
    return handleWsAuthorizer(event as WsAuthorizerEvent);
  }
  if (isHttpAuthorizerEvent(event)) {
    return handleHttpAuthorizer(event as HttpAuthorizerEvent);
  }
  if (isWebSocketEvent(event)) {
    return handleWebSocket(event as APIGatewayProxyWebsocketEventV2);
  }
  return honoToApiGateway(app, event as APIGatewayProxyEventV2);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function processSqsRecord(
  body: unknown,
  messageType: string | undefined,
  receiveCount: number,
  messageId: string,
): Promise<Result<void, unknown>> {
  if (messageType === MSG_TYPE_REINDEX) {
    return reindexWorker.processSegmentMessage(body as ReindexSegmentMessage);
  }

  if (messageType === MSG_TYPE_SIDE_EFFECT) {
    const payload = body as SideEffectPayload;
    if (!payload.signal || !payload.thread) {
      logger.error("Malformed side-effect payload — missing signal or thread. Dropping message.", { code: "handler.sqs.malformed_side_effect", messageId });
      return ok(undefined);
    }
    return processor.processSideEffect(payload, receiveCount);
  }

  if (messageType === MSG_TYPE_DRAFT_SEND) {
    return draftSendWorker.process(body as DraftSendPayload);
  }

  if (messageType === MSG_TYPE_SIGNAL_FOLLOWUP) {
    const message = body as FollowupMessage;
    if (!message.accountId || !message.signalId || !message.threadId) {
      logger.error("Malformed signal_followup payload — missing required fields. Dropping message.", { code: "handler.sqs.malformed_followup", messageId });
      return ok(undefined);
    }
    return followupHandler.process(message);
  }

  if (messageType === MSG_TYPE_RSVP_REMINDER) {
    const message = body as RsvpReminderMessage;
    if (!message.accountId || !message.signalId || !message.threadId) {
      logger.error("Malformed rsvp_reminder payload — missing required fields. Dropping message.", { code: "handler.sqs.malformed_rsvp_reminder", messageId });
      return ok(undefined);
    }
    return rsvpReminderHandler.process(message);
  }

  if (messageType === MSG_TYPE_DIGEST_DISPATCH) {
    return digestDispatcher.dispatch();
  }

  if (messageType === MSG_TYPE_DIGEST_SEND) {
    const message = body as IDigestSendMessage;
    if (!message.accountId) {
      logger.error("Malformed digest_send payload — missing accountId. Dropping message.", { code: "handler.sqs.malformed_digest_send", messageId });
      return ok(undefined);
    }
    return digestWorker.process(message);
  }

  // SNS envelope — unwrap and route by notificationType
  const sns = body as { Message: string };
  let inner: unknown;
  try {
    inner = JSON.parse(sns.Message);
  } catch (e) {
    return err(e);
  }

  const notification = inner as { notificationType?: string; mail?: { messageId: string; timestamp: string; destination: string[] }; receipt?: { dkimVerdict: { status: SesVerdict }; dmarcVerdict: { status: SesVerdict }; action: { objectKey: string } } };

  if (notification.notificationType === "Bounce" || notification.notificationType === "Complaint") {
    await feedbackProcessor.processNotification(notification);
    return ok(undefined);
  }

  const mail = notification.mail!;
  const receipt = notification.receipt!;

  // The owning account is resolved inside the processor from the recipient address —
  // the handler is a thin SQS/SNS unwrapper and does no DB work here.
  const message: InboundSignalMessage = {
    s3Key: receipt.action.objectKey,
    sesMessageId: mail.messageId,
    idempotencyKey: messageId,
    timestamp: mail.timestamp,
    destination: mail.destination,
    dkimVerdict: receipt.dkimVerdict.status,
    dmarcVerdict: receipt.dmarcVerdict.status,
  };
  return processor.processRecord(message, receiveCount);
}

// ---------------------------------------------------------------------------
// WebSocket authorizer  (fires on $connect; injects accountId into context)
// ---------------------------------------------------------------------------

type WsAuthorizerEvent = {
  type: "REQUEST";
  methodArn: string;
  requestContext?: { path?: string };
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

  // Extract accountId from connection path: /api/accounts/{accountId}
  const pathMatch = /\/api\/accounts\/([^/?]+)/.exec(event.requestContext?.path ?? event.headers?.["x-forwarded-path"] ?? "");
  const accountId = pathMatch?.[1] ?? event.queryStringParameters?.["accountId"] ?? "";
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
// HTTP API authorizer  (payload format 2.0 — simple response)
//
// ⚠️  NEVER add path-based logic to this authorizer. The authorizer's caching
// key is the Authorization header ONLY. If you branch on rawPath here, API
// Gateway will cache the first result and apply it to ALL paths with the same
// token — including paths you intended to deny. Public routes MUST be excluded
// from the authorizer at the API Gateway route level (Terraform), not here.
// ---------------------------------------------------------------------------

type HttpAuthorizerEvent = {
  version: "2.0";
  type: "REQUEST";
  routeArn: string;
  routeKey: string;
  rawPath: string;
  headers: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  requestContext: {
    accountId: string;
    apiId: string;
    domainName: string;
    http: { method: string; path: string };
    requestId: string;
    routeKey: string;
    stage: string;
    time: string;
    timeEpoch: number;
  };
  identitySource?: string[];
};

type HttpAuthorizerResponse = {
  isAuthorized: boolean;
  context: Record<string, string>;
};

function isHttpAuthorizerEvent(event: unknown): event is HttpAuthorizerEvent {
  const e = event as Record<string, unknown>;
  return e["version"] === "2.0" && e["type"] === "REQUEST" && typeof e["routeArn"] === "string";
}

async function handleHttpAuthorizer(event: HttpAuthorizerEvent): Promise<HttpAuthorizerResponse> {
  const authHeader = event.headers?.["authorization"] ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match || !match[1]?.trim()) {
    return { isAuthorized: false, context: {} };
  }

  const token = match[1].trim();
  const verifyResult = await authService.verify(token);
  if (verifyResult.isErr()) {
    return { isAuthorized: false, context: {} };
  }

  const { userId } = verifyResult.value;
  return { isAuthorized: true, context: { userId } };
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
        createdAt: DateTime.utc().toISO()!,
        updatedAt: DateTime.utc().toISO()!,
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
