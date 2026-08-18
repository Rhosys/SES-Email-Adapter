import type { APIGatewayProxyEventV2, SQSEvent, Context, APIGatewayProxyResultV2, EventBridgeEvent, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { SQS_MESSAGE_TYPES } from "./types/index.js";
import { ok, err, processorError } from "./errors.js";
import type { Result } from "./errors.js";
import { isStepFunctionTaskEvent } from "./onboarding/types.js";
import type { InboundSignalMessage, SideEffectPayload } from "./processor/processor.js";
import type { SESMessage, SESReceiptS3Action } from "aws-lambda";
import type { FollowupMessage } from "./scheduler/followup-handler.js";
import type { RsvpReminderMessage } from "./scheduler/rsvp-reminder.js";
import type { IDigestSendMessage } from "./digest/digest-worker.js";
import type { ReindexSegmentMessage } from "./jobs/reindex/reindex-dispatcher.js";
import type { DraftSendPayload } from "./processor/draft-send-dispatcher.js";
import { DateTime } from "luxon";
import { CompositeRoot } from "./composite-root.js";

const [MSG_TYPE_REINDEX, MSG_TYPE_SIDE_EFFECT, MSG_TYPE_DRAFT_SEND, MSG_TYPE_SIGNAL_FOLLOWUP, MSG_TYPE_RSVP_REMINDER, MSG_TYPE_DIGEST_DISPATCH, MSG_TYPE_DIGEST_SEND, MSG_TYPE_EMX_INBOUND, MSG_TYPE_EMX_DISPATCH, MSG_TYPE_EMX_IDLE] = SQS_MESSAGE_TYPES;
const RETRY_TRACK_THRESHOLD = 30;

const root = new CompositeRoot();
const { logger, processor, onboardingHandler, domainHealthJob, healthcheckJob, reindexWorker, draftSendWorker, followupHandler, rsvpReminderHandler, digestDispatcher, digestWorker, sesFeedbackProcessor, authService, deviceStore, emxInboundWorker, emxDispatchWorker, emxIdleWorker, app } = root;
// ---------------------------------------------------------------------------
// Wiring lives in CompositeRoot (see composite-root.ts).
// ---------------------------------------------------------------------------

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
    const stack = e instanceof Error ? e.stack ?? e.message : String(e);
    logger.error(`Unhandled top-level exception: ${stack}`, { code: "handler.unhandled_exception", error: e, event });
    return { statusCode: 500, headers: { "x-request-id": compositeId }, body: JSON.stringify({ title: `Internal Server Error: ${stack}`, errorId: compositeId }) };
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
      "email-catcher-AccountCreation|SetupDefaults": () => onboardingHandler.handleSetupDefaults(payload.accountId, payload.email),
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
      return;
    }

    if (ruleName?.endsWith("-healthcheck")) {
      await healthcheckJob.run();
      return;
    }

    // Unrecognised rule — log error and return without invoking any job
    logger.error("EventBridge event received with unrecognised rule name. No job will be invoked.", {
      code: "handler.eventbridge.unknown_rule",
      ruleName: ruleName ?? null,
      resources: ebEvent.resources,
    });
    return;
  }
  if (isSqsEvent(event)) {
    const failures: Array<{ itemIdentifier: string }> = [];

    for (const record of event.Records) {
      const receiveCount = Number(record.attributes?.ApproximateReceiveCount ?? "1");
      const messageType = record.messageAttributes?.["messageType"]?.stringValue ?? "unknown";
      logger.info("SQS message received", { code: "handler.sqs.received", messageId: record.messageId, messageType, receiveCount });

      let body: unknown;
      try {
        body = JSON.parse(record.body);
      } catch (e) {
        logger.error("Failed to parse SQS record body as JSON.", { code: "handler.sqs.parse_failed", messageId: record.messageId, error: e });
        failures.push({ itemIdentifier: record.messageId });
        continue;
      }

      const resolvedMessageType = record.messageAttributes?.["messageType"]?.stringValue ?? (body as { sqsMessageAttributeMessageType?: string }).sqsMessageAttributeMessageType;
      const result = await processSqsRecord(body, resolvedMessageType, receiveCount, record.messageId);

      if (result.isErr()) {
        if (receiveCount > RETRY_TRACK_THRESHOLD) {
          logger.error("SQS message failed after exceeding retry threshold.", { code: "handler.sqs.retry_threshold_exceeded", messageId: record.messageId, receiveCount, messageType: resolvedMessageType, error: result.error, record });
        } else {
          logger.info("SQS message processing failed. Will be retried automatically.", { code: "handler.sqs.processing_failed", messageId: record.messageId, receiveCount, messageType: resolvedMessageType, error: result.error, record });
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
  sqsMessageId: string,
): Promise<Result<void, unknown>> {
  if (messageType === MSG_TYPE_REINDEX) {
    return reindexWorker.processSegmentMessage(body as ReindexSegmentMessage);
  }

  if (messageType === MSG_TYPE_SIDE_EFFECT) {
    const payload = body as SideEffectPayload;
    if (!payload.signal || !payload.thread) {
      logger.error("Malformed side-effect payload — missing signal or thread. Dropping message.", { code: "handler.sqs.malformed_side_effect", sqsMessageId });
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
      logger.error("Malformed signal_followup payload — missing required fields. Dropping message.", { code: "handler.sqs.malformed_followup", sqsMessageId });
      return ok(undefined);
    }
    return followupHandler.process(message);
  }

  if (messageType === MSG_TYPE_RSVP_REMINDER) {
    const message = body as RsvpReminderMessage;
    if (!message.accountId || !message.signalId || !message.threadId) {
      logger.error("Malformed rsvp_reminder payload — missing required fields. Dropping message.", { code: "handler.sqs.malformed_rsvp_reminder", sqsMessageId });
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
      logger.error("Malformed digest_send payload — missing accountId. Dropping message.", { code: "handler.sqs.malformed_digest_send", sqsMessageId });
      return ok(undefined);
    }
    return digestWorker.process(message);
  }

  if (messageType === MSG_TYPE_EMX_INBOUND) {
    const payload = body as import("./external-exchanges/emx-inbound-worker.js").EmxInboundPayload;
    if (!payload.source || !payload.providerMessageId || !payload.emxId || !payload.accountId) {
      logger.error("Malformed emx_inbound payload — missing required fields. Dropping.", { code: "handler.sqs.malformed_emx_inbound", sqsMessageId });
      return ok(undefined);
    }
    return emxInboundWorker.process(payload, sqsMessageId, receiveCount);
  }

  if (messageType === MSG_TYPE_EMX_DISPATCH) {
    return emxDispatchWorker.dispatch(body as import("./external-exchanges/emx-dispatch-worker.js").EmxDispatchPayload);
  }

  if (messageType === MSG_TYPE_EMX_IDLE) {
    const payload = body as import("./external-exchanges/emx-idle-worker.js").EmxIdlePayload;
    if (!payload.accountId) {
      logger.error("Malformed emx_idle payload — missing accountId. Dropping.", { code: "handler.sqs.malformed_emx_idle", sqsMessageId });
      return ok(undefined);
    }
    return emxIdleWorker.process(payload);
  }

  // SNS envelope — validate + unwrap. Two SNS topics land on this same queue (see deploy/storage.tf):
  // the inbound receipt rule's S3 action (notificationType: "Received"), and the sending
  // configuration set's feedback destination (Bounce/Complaint/...).

  // Step 1: Validate SNS envelope structure
  const snsEnvelope = body as Record<string, unknown>;
  if (typeof snsEnvelope.Type !== "string" || typeof snsEnvelope.Message !== "string") {
    logger.error("SQS body is not a recognized SNS envelope (missing Type or Message). Dropping.", {
      code: "handler.sqs.unrecognized_body_format",
      sqsMessageId,
      body,
    });
    return ok(undefined);
  }

  if (snsEnvelope.Type !== "Notification") {
    logger.error("SNS envelope Type is not 'Notification'. Dropping.", {
      code: "handler.sqs.not_sns_envelope",
      sqsMessageId,
      type: snsEnvelope.Type,
    });
    return ok(undefined);
  }

  // Step 2: Parse inner Message JSON
  let inner: unknown;
  try {
    inner = JSON.parse(snsEnvelope.Message as string);
  } catch (e) {
    logger.error("Failed to parse SNS Message field as JSON.", {
      code: "handler.sqs.sns_message_parse_failed",
      sqsMessageId,
      error: e,
    });
    return ok(undefined);
  }

  // Step 3: Route by structure. Two SNS topics land on this queue:
  // - SES inbound receipt rule (S3 action): has `receipt.action` + `mail` → SESMessage
  // - SES sending configuration set feedback (Bounce/Complaint/Delivery): has
  //   `notificationType` (older format) or `eventType` (newer format), no `receipt.action`
  const notification = inner as Partial<SESMessage> & { notificationType?: string; eventType?: string };

  if (!notification.receipt?.action || !notification.mail) {
    if (!notification.notificationType && !notification.eventType) {
      logger.error("Parsed SNS Message is not a recognized SES notification shape. Dropping.", {
        code: "handler.sqs.unknown_ses_notification_shape",
        sqsMessageId,
        inner,
      });
      return ok(undefined);
    }
    const feedbackResult = await sesFeedbackProcessor.processNotification(inner);
    if (feedbackResult.isErr()) return err(processorError(feedbackResult.error));
    return ok(undefined);
  }

  // receipt.action + mail confirmed present → narrow to fully required SESMessage
  const ses = inner as SESMessage;
  const s3Action = ses.receipt.action as SESReceiptS3Action;

  const message: InboundSignalMessage = {
    s3Key: s3Action.objectKey,
    compositeMailMessageId: `ses-${ses.mail.messageId}`,
    idempotencyKey: sqsMessageId,
    timestamp: ses.mail.timestamp,
    destination: ses.mail.destination,
    dkimVerdict: ses.receipt.dkimVerdict.status,
    dmarcVerdict: ses.receipt.dmarcVerdict.status,
  };
  const result = await processor.processInbound(message, receiveCount);
  if (result.isErr() && result.error.kind === "no_account_for_recipient") return ok(undefined);
  if (result.isErr()) return err(processorError(result.error));
  return ok(undefined);
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

  // Extract accountId from connection path: /accounts/{accountId}
  const pathMatch = /\/accounts\/([^/?]+)/.exec(event.requestContext?.path ?? event.headers?.["x-forwarded-path"] ?? "");
  const accountId = pathMatch?.[1] ?? event.queryStringParameters?.["accountId"] ?? "";
  if (!accountId) {
    logger.track("WS authorizer denied: accountId missing from both path and query string", { code: "handler.ws_authorizer.missing_account_id", event });
    return wsDeny(event.methodArn);
  }

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
    case "$connect": {
      const saveResult = await deviceStore.saveDevice({
        accountId,
        token: connectionId,
        type: "websocket",
        createdAt: DateTime.utc().toISO()!,
        updatedAt: DateTime.utc().toISO()!,
        // 2-hour TTL — API Gateway closes idle connections after 10 min anyway
        ttl: Math.floor(Date.now() / 1000) + 7200,
      });
      if (saveResult.isErr()) { logger.warn("Failed to save WebSocket device", { code: "handler.ws.save_device_failed", accountId, connectionId, error: saveResult.error }); }
      return { statusCode: 200 };
    }

    case "$disconnect":
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
