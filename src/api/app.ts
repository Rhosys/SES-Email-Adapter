import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { randomUUID, createHash, randomBytes } from "crypto";
import type { S3Client } from "@aws-sdk/client-s3";
import { DateTime } from "luxon";
import { generateId } from "../utils/id.js";
import { getDomain } from "tldts";
import { validateRecipientMx } from "../dns/mx-validator.js";
import { computeUndoWindowSeconds } from "./undo-window.js";
import type { AuditDatabase } from "../database/audit-database.js";
import type { Result } from "neverthrow";
import { ok as neverthrowOk, err as neverthrowErr } from "neverthrow";
import type { DbError, NotFoundError, AuthressServiceError, AuthError, TransientSesError } from "../errors.js";
import type { Arc, Signal, AnySignal, Attachment, View, Label, Rule, Domain, DnsRecord, Account, Page, PageParams, ArcStatus, Workflow, WorkflowData, Alias, AliasSender, SenderPolicy, VerifiedForwardingAddress, Pagination, EmailTemplate, CalendarEventData, CalendarResponseData, DomainMisconfigurationData } from "../types/index.js";
import { isCalendarEventSignal, isEmailSignal } from "../types/index.js";
import type { UpdateArcFields, ArcDatabase } from "../database/arc-database.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";
import { deriveGroupingKey } from "../processor/processor.js";
import { zParse } from "./validate.js";
import { toApiArc, toApiSignal } from "./transform.js";
import { generatePresignedGet } from "../processor/presign.js";
import type { UserCodeExecutorClient } from "../processor/user-code-client.js";
import type { BillingHandler } from "../billing/billing-handler.js";
import type { DraftSendDispatcher } from "../processor/draft-send-dispatcher.js";
import type { EmailService } from "../email/email-service.js";
import type { DomainIdentityService } from "../email/domain-identity-service.js";
import type { sendRsvp as SendRsvpFn } from "../processor/calendar/rsvp-composer.js";
import type { PostApprovalCalendarHandlerDeps } from "../processor/calendar/post-approval-handler.js";
import { handlePostApprovalCalendar } from "../processor/calendar/post-approval-handler.js";
import type { SchedulerClient } from "../scheduler/scheduler-client.js";
import { buildScheduleName } from "../scheduler/schedule-name.js";
import { durationToSeconds } from "../processor/retention.js";
import { registerViewsRoutes } from "./viewsApi.js";
import { registerLabelsRoutes } from "./labelsApi.js";
import { registerRulesRoutes } from "./rulesApi.js";
import { registerTemplatesRoutes } from "./templatesApi.js";
import { registerDomainsRoutes } from "./domainsApi.js";
import { registerAliasesRoutes, ensureAliasExists } from "./aliasesApi.js";
import { registerAccountsRoutes } from "./accountsApi.js";
import { registerAuditRoutes } from "./auditApi.js";
import { registerAdminRoutes } from "./adminApi.js";

// ---------------------------------------------------------------------------
// Job Dispatcher interface (used by reindex route)
// ---------------------------------------------------------------------------

export interface JobDispatcher {
  dispatch(targetRegistryId: string, segmentCount?: number): Promise<Result<{
    jobId: string; targetRegistryId: string; modelId: string; segmentCount: number; startedAt: string;
  }, NotFoundError>>;
}

// ---------------------------------------------------------------------------
// Signal Reprocessor interface (used by reprocess route)
// ---------------------------------------------------------------------------

export interface SignalReprocessor {
  reprocessSignal(accountId: string, signalId: string): Promise<Result<Signal, import("../errors.js").ProcessorError>>;
}

import { authorizationGuard, ROUTE_NOT_FOUND_KEY } from "./authorization-guard.js";
import { createAuthorize } from "./authorization-middleware.js";
import {
  UpdateArcRequest, UpdateSignalRequest, UpdateSignalStatusRequest,
  CreateViewRequest, UpdateViewRequest,
  CreateLabelRequest, UpdateLabelRequest,
  CreateRuleRequest, UpdateRuleRequest,
  CreateDraftSignalRequest, ReplaceDraftSignalRequest,
  RsvpRequest,
} from "./requests.js";
import {
  Arc as ArcSchema, Signal as SignalSchema,
  ListArcsResponse, ListSignalsResponse,
  ErrorResponse, ErrorCode,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthContext {
  userId: string;
}

export interface AuthService {
  verify(token: string): Promise<Result<{ userId: string }, AuthError>>;
}

// ---------------------------------------------------------------------------
// Access (Authress RBAC)
// ---------------------------------------------------------------------------

export type AccountRole = "admin" | "member" | "viewer";

export interface AccountUser {
  userId: string;
  role: AccountRole;
}

export interface UserProfile {
  userId: string;
  role: AccountRole;
  name?: string;
  email?: string;
  picture?: string;
}

export interface AccessService {
  listUsers(accountId: string): Promise<Result<AccountUser[], AuthressServiceError>>;
  getUserProfile(userId: string): Promise<Result<{ name?: string; email?: string; picture?: string }, AuthressServiceError>>;
  listAccountsForUser(userId: string): Promise<Result<string[], AuthressServiceError>>;
  addUser(accountId: string, userId: string, role: AccountRole): Promise<Result<void, AuthressServiceError>>;
  updateUserRole(accountId: string, userId: string, role: AccountRole): Promise<Result<void, AuthressServiceError>>;
  removeUser(accountId: string, userId: string): Promise<Result<void, AuthressServiceError>>;
  checkAccess(userId: string, resourceUri: string, permission: string): Promise<void>;
  createInvite(accountId: string, email: string, role: AccountRole): Promise<Result<{ inviteId: string }, AuthressServiceError>>;
}

// ---------------------------------------------------------------------------
// Query params & re-exports
// ---------------------------------------------------------------------------

export interface ListArcsParams extends PageParams {
  workflow?: Workflow;
  label?: string;
  status?: ArcStatus;
}

export type { UpdateArcRequest, UpdateSignalStatusRequest, CreateViewRequest, UpdateViewRequest, CreateLabelRequest, UpdateLabelRequest, CreateRuleRequest, UpdateRuleRequest };

// ---------------------------------------------------------------------------
// Verification mailer
// ---------------------------------------------------------------------------

export interface VerificationMailer {
  sendForwardVerification(accountId: string, address: string, token: string): Promise<Result<void, TransientSesError>>;
  sendCalendarForwardVerification(accountId: string, address: string, token: string): Promise<Result<void, TransientSesError>>;
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export interface AppDeps {
  arcDb: ArcDatabase;
  accountDb: AccountDatabase;
  auditDb: AuditDatabase;
  auth: AuthService;
  access: AccessService;
  logger: Logger;
  verificationMailer: VerificationMailer;
  jobDispatcher: JobDispatcher;
  signalReprocessor: SignalReprocessor;
  draftSendDispatcher: DraftSendDispatcher;
  accountCreationStarter: { start(accountId: string, email: string): Promise<void> };
  appBaseUrl: string;
  contentCdnBaseUrl: string;
  astValidator: UserCodeExecutorClient;
  billingHandler: BillingHandler;
  emailService: EmailService;
  domainIdentityService: DomainIdentityService;
  rsvpComposer: typeof SendRsvpFn;
  postApprovalCalendarDeps: PostApprovalCalendarHandlerDeps;
  schedulerClient: SchedulerClient;
  s3Client: S3Client;
  emailBucket: string;
}

export type AppEnv = { Variables: { auth: AuthContext; authorizationVerified?: boolean; [ROUTE_NOT_FOUND_KEY]?: boolean } };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function page<K extends string, T>(key: K, items: T[], nextCursor?: string): Record<K, T[]> & { pagination: Pagination } {
  return { [key]: items, pagination: { cursor: nextCursor ?? null } } as Record<K, T[]> & { pagination: Pagination };
}

function withAttachmentUrls<T extends AnySignal>(signal: T, cdnBase: string): T {
  if (!isEmailSignal(signal)) return signal;
  return { ...signal, data: { ...signal.data, attachments: signal.data.attachments.map((a: Attachment) => ({ ...a, url: `${cdnBase}/${a.s3Key}` })) } };
}



export function createApp({ arcDb, accountDb, auditDb, auth, access, logger, verificationMailer, jobDispatcher, signalReprocessor, draftSendDispatcher, accountCreationStarter, appBaseUrl, contentCdnBaseUrl, astValidator, billingHandler, emailService, domainIdentityService, rsvpComposer, postApprovalCalendarDeps, schedulerClient, s3Client, emailBucket }: AppDeps) {
  const app = new OpenAPIHono<AppEnv>();

  // RFC 9727 — Well-Known URI for API Catalog
  app.use("/.well-known/*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "public, max-age=3600");
  });
  app.doc("/.well-known/api-catalog", {
    openapi: "3.1.0",
    info: { title: "SES Email Adapter", version: "1.0.0" },
  });
  app.get("/", (c) => c.redirect("/.well-known/api-catalog", 301));

  // Attach x-request-id header to every response and errorId to 4XX/5XX JSON bodies
  app.use("*", async (c, next) => {
    await next();
    const requestId = logger.getInvocationId();
    c.res.headers.set("x-request-id", requestId);

    // Enrich error response bodies with errorId when missing
    const status = c.res.status;
    if (status >= 400 && c.res.headers.get("content-type")?.includes("application/json")) {
      const clone = c.res.clone();
      const body = await clone.json();
      if (body && typeof body === "object" && !("errorId" in body)) {
        c.res = new Response(JSON.stringify({ ...body, errorId: requestId }), {
          status,
          headers: c.res.headers,
        });
      }
    }
  });

  // RequestLogger — log every API request/response
  app.use("*", async (c, next) => {
    const start = Date.now();
    const body = c.req.method !== "GET" && c.req.method !== "HEAD"
      ? await c.req.raw.clone().text()
      : undefined;

    await next();

    const elapsed = Date.now() - start;
    const status = c.res.status;

    if (elapsed > 25_000) {
      logger.error("Request exceeded 25s — at risk of Lambda timeout.", { code: "api.slow_request", method: c.req.method, path: c.req.path, status, elapsedMs: elapsed });
    }

    const logData: Record<string, unknown> = {
      code: "api.request",
      method: c.req.method,
      path: c.req.path,
      status,
      elapsedMs: elapsed,
      requestHeaders: Object.fromEntries(c.req.raw.headers.entries()),
      ...(body ? { requestBody: body } : {}),
      responseHeaders: Object.fromEntries(c.res.headers.entries()),
    };

    if (status >= 400) {
      logData["responseBody"] = await c.res.clone().text();
    }
    logger.info("RequestLogger", logData);
  });

  // CloudFront origin verification — reject requests that bypass CloudFront
  const CF_ORIGIN_SECRET = process.env["CF_ORIGIN_SECRET"];
  if (CF_ORIGIN_SECRET) {
    app.use("*", async (c, next) => {
      if (c.req.header("x-origin-verify") !== CF_ORIGIN_SECRET) {
        return err(c, 403, "Forbidden");
      }
      await next();
    });
  }

  // JWT verification (authentication only — authorization is handled per-route)
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204, {
        "Access-Control-Allow-Origin": c.req.header("Origin") ?? "*",
        "Access-Control-Allow-Methods": "DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT",
        "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Powered-By,X-Login-Hash,If-Unmodified-Since,Origin,Referer,Accept,Accept-Language,Accept-Encoding,User-Agent,Content-Length,Cache-Control,Pragma,Sec-Fetch-Dest,Sec-Fetch-Mode,Sec-Fetch-Site,sec-gpc",
        "Cache-Control": "public, max-age=3600",
      });
    }
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) return err(c, 401, "Unauthorized");

    const verifyResult = await auth.verify(header.slice(7));
    if (verifyResult.isErr()) return err(c, 401, "Unauthorized");
    const { userId } = verifyResult.value;

    c.set("auth", { userId });

    await next();
  });

  // Authorization guard — safety net for forgotten authorize() calls on any route
  app.use("*", authorizationGuard(logger));

  // Per-route authorization middleware factory
  const authorize = access ? createAuthorize(access, logger) : null;

  // Helper that returns the authorize middleware or a no-op if access service is unavailable
  function authz(permission: string, resourceUri: string | ((c: Context<AppEnv>) => string)): ReturnType<NonNullable<typeof authorize>> {
    if (authorize) {
      return authorize(permission, resourceUri as string | ((c: Context) => string));
    }
    // When no access service, mark as authorized (backward compat for tests without access)
    return async (c, next) => {
      c.set("authorizationVerified", true);
      await next();
    };
  }

  // Shared error responses — included in every route to satisfy TypeScript's strict handler return type checking
  const errResponses = {
    400: { content: { "application/json": { schema: ErrorResponse } }, description: "Bad request" },
    401: { content: { "application/json": { schema: ErrorResponse } }, description: "Unauthorized" },
    403: { content: { "application/json": { schema: ErrorResponse } }, description: "Forbidden" },
    404: { content: { "application/json": { schema: ErrorResponse } }, description: "Not found" },
    409: { content: { "application/json": { schema: ErrorResponse } }, description: "Conflict" },
    422: { content: { "application/json": { schema: ErrorResponse } }, description: "Unprocessable entity" },
    500: { content: { "application/json": { schema: ErrorResponse } }, description: "Internal server error" },
    501: { content: { "application/json": { schema: ErrorResponse } }, description: "Not implemented" },
    503: { content: { "application/json": { schema: ErrorResponse } }, description: "Service unavailable" },
  } as const;

  type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500 | 501 | 503;
  type ErrorCodeLiteral = z.infer<typeof ErrorCode>;
  type ErrorBody = { title: string; errorCode?: ErrorCodeLiteral; details?: unknown; errorId: string };

  function err<S extends ErrorStatus>(c: Context<AppEnv>, status: S, title: string, errorCode?: ErrorCodeLiteral, details?: unknown) {
    return c.json(
      { title, ...(errorCode ? { errorCode } : {}), ...(details !== undefined ? { details } : {}), errorId: logger.getInvocationId() } as ErrorBody,
      status,
    );
  }

  // Route helper: wraps createRoute to auto-merge shared error responses into every route definition.
  // Keeps error responses in the type-level config so Hono infers the full return union (success | errors).
  // This preserves compile-time validation of the success response shape.
  // NOTE: requires explicit status codes on success returns (e.g. c.json(data, 200)) and
  // response shapes that match the zod schema exactly.
  const route = <const R extends Parameters<typeof createRoute>[0]>(config: R) =>
    createRoute({ ...config, responses: { ...errResponses, ...config.responses } } as unknown as R & { responses: R["responses"] & typeof errResponses });


  // -------------------------------------------------------------------------
  // Accounts & Users  —  /accounts, /accounts/:accountId, /accounts/:accountId/users
  // -------------------------------------------------------------------------
  registerAccountsRoutes(app, { accountDb, access, logger, accountCreationStarter, emailService, appBaseUrl, authz, err, route });

  // -------------------------------------------------------------------------
  // Arcs  —  /accounts/:accountId/arcs
  // -------------------------------------------------------------------------

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/arcs",
    tags: ["Arcs"],
    request: {
      params: z.object({ accountId: z.string() }),
      query: z.object({ workflow: z.string().optional(), label: z.string().optional(), status: z.string().optional(), cursor: z.string().optional(), limit: z.string().optional(), q: z.string().optional() }),
    },
    middleware: [authz("arcs:read", c => `accounts/${c.req.param("accountId")!}/arcs`)] as const,
    responses: { 200: { content: { "application/json": { schema: ListArcsResponse } }, description: "List arcs" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const query = c.req.query();
    const q = query["q"];
    if (q) {
      const params: PageParams = {
        ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
        ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
      };
      const result = await arcDb.searchArcs(accountId, q, params);
      if (result.isErr()) return err(c, 500, "Internal Server Error");
      return c.json(page("arcs", result.value.items.map(toApiArc), result.value.nextCursor), 200);
    }
    const params: ListArcsParams = {
      ...(query["workflow"] ? { workflow: query["workflow"] as Workflow } : {}),
      ...(query["label"] ? { label: query["label"] } : {}),
      ...(query["status"] ? { status: query["status"] as ArcStatus } : {}),
      ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
      ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
    };
    const result = await arcDb.listArcs(accountId, params);
    if (result.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(page("arcs", result.value.items.map(toApiArc), result.value.nextCursor), 200);
  });

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/arcs/{id}",
    tags: ["Arcs"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("arcs:read", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("id")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: ArcSchema } }, description: "Get arc" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const arcResult = await arcDb.getArc(accountId, c.req.param("id")!);
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    return c.json(toApiArc(arc), 200);
  });

  app.openapi(route({
    method: "patch",
    path: "/accounts/{accountId}/arcs/{id}",
    tags: ["Arcs"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("arcs:write", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("id")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: ArcSchema } }, description: "Update arc" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const arcResult = await arcDb.getArc(accountId, c.req.param("id")!);
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    const body = await zParse(UpdateArcRequest, c.req.raw);

    // report_violation: block the sender domain and delete the arc
    if (body.status === "report_violation") {
      const signalsResult = await arcDb.listSignals(accountId, arc.id, { limit: 1 });
      if (signalsResult.isErr()) return err(c, 500, "Internal Server Error");
      const signal = signalsResult.value.items[0];
      if (signal) {
        const senderDomain = signal.data.from.address.includes("@") ? signal.data.from.address.split("@").pop()! : signal.data.from.address;
        const senderETLD1 = getDomain(senderDomain) ?? senderDomain;
        const recipientAddress = signal.data.recipientAddress;
        const saveSenderResult = await accountDb.saveSender(accountId, recipientAddress, senderETLD1, "report_violation");
        if (saveSenderResult.isErr()) return err(c, 500, "Internal Server Error");
        logger.track("Arc reported as GDPR violation. Sender domain blocked with report_violation policy and arc deleted.", {
          code: "api.arc.report_violation",
          signal, arc,
          senderDomain: senderETLD1,
        });
      }
      // Persist as deleted — report_violation is the user intent, deleted is the arc state
      const updateResult = await arcDb.updateArc(accountId, arc.id, "deleted", arc.lastSignalAt, {});
      if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
      return c.json(toApiArc(updateResult.value), 200);
    }

    const fields: UpdateArcFields = {};
    if (body.urgency !== undefined) fields.urgency = body.urgency;
    if (body.labels !== undefined) fields.labels = body.labels;
    if (body.followupAt !== undefined) fields.followupAt = body.followupAt;
    const status = body.status ?? arc.status;
    const lastSignalAt = body.lastSignalAt ?? arc.lastSignalAt;

    // followupAt validation
    if (body.followupAt) {
      const followupTime = new Date(body.followupAt).getTime();
      const now = Date.now();
      if (followupTime <= now) {
        return err(c, 400, "followupAt must be in the future");
      }
      if (arc.retentionDuration) {
        const retentionSeconds = durationToSeconds(arc.retentionDuration);
        if (retentionSeconds != null) {
          const expiresAt = new Date(arc.createdAt).getTime() + retentionSeconds * 1000;
          if (followupTime > expiresAt) {
            return err(c, 400, "followupAt exceeds arc retention expiration");
          }
        }
      }
    }

    // Apply status change (if any)
    const statusChanged = body.status !== undefined && body.status !== arc.status;
    const updateResult = await arcDb.updateArc(accountId, arc.id, status, lastSignalAt, fields);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");

    // Create followup schedule (if requested)
    if (body.followupAt && schedulerClient) {
      // Get the most recent signal for the arc to use as signalId
      const signalsResult = await arcDb.listSignals(accountId, arc.id, { limit: 1 });
      const signalId = signalsResult.isOk() ? signalsResult.value.items[0]?.id ?? arc.id : arc.id;

      const scheduleResult = await schedulerClient.createFollowup({
        accountId,
        signalId,
        arcId: arc.id,
        fireAt: body.followupAt,
        suffix: "followup",
        sqsMessageAttributeMessageType: "signal_followup",
      });

      if (scheduleResult.isErr()) {
        // Rollback status change if one was applied
        if (statusChanged) {
          await arcDb.updateArc(accountId, arc.id, arc.status, arc.lastSignalAt, {});
        }
        return err(c, 500, "Failed to create followup schedule");
      }
    }

    return c.json(toApiArc(updateResult.value), 200);
  });

  // -------------------------------------------------------------------------
  // Signals  —  /accounts/:accountId/arcs/:arcId/signals  &  /signals/:id
  // -------------------------------------------------------------------------

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/arcs/{arcId}/signals",
    tags: ["Signals"],
    request: {
      params: z.object({ accountId: z.string(), arcId: z.string() }),
      query: z.object({ cursor: z.string().optional(), limit: z.string().optional() }),
    },
    middleware: [authz("signals:read", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("arcId")!}/signals`)] as const,
    responses: { 200: { content: { "application/json": { schema: ListSignalsResponse } }, description: "List signals for arc" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const arcResult = await arcDb.getArc(accountId, c.req.param("arcId")!);
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    const query = c.req.query();
    const params: PageParams = {
      ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
      ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
    };
    const result = await arcDb.listSignals(accountId, arc.id, params);
    if (result.isErr()) return err(c, 500, "Internal Server Error");

    // Enrich calendar_event signals with the most recent calendar_response decision
    const signals = result.value.items as unknown as import("../types/index.js").AnySignal[];
    const calendarEventSignals = signals.filter(isCalendarEventSignal);
    const enrichments = new Map<string, { decision: CalendarResponseData["decision"]; respondedAt: string }>();

    if (calendarEventSignals.length > 0) {
      // Collect unique veventUids from calendar_event signals
      const veventUids = new Set(calendarEventSignals.map(s => s.data.veventUid));
      for (const veventUid of veventUids) {
        const responseResult = await arcDb.getLatestCalendarResponse(accountId, arc.id, veventUid);
        if (responseResult.isOk() && responseResult.value) {
          const resp = responseResult.value.data;
          enrichments.set(veventUid, { decision: resp.decision, respondedAt: resp.respondedAt });
        }
      }
    }

    // Build enriched response — calendar_event signals get latestResponse field
    const enrichedSignals = signals.map(signal => {
      const withUrls = contentCdnBaseUrl ? withAttachmentUrls(signal, contentCdnBaseUrl) : signal;
      const apiSignal = toApiSignal(withUrls);
      if (isCalendarEventSignal(withUrls) && enrichments.has(withUrls.data.veventUid)) {
        return { ...apiSignal, latestResponse: enrichments.get(withUrls.data.veventUid) };
      }
      return apiSignal;
    });

    return c.json(page("signals", enrichedSignals, result.value.nextCursor), 200);
  });

  app.openapi(route({
    method: "post",
    path: "/accounts/{accountId}/arcs/{arcId}/signals",
    tags: ["Signals"],
    request: { params: z.object({ accountId: z.string(), arcId: z.string() }) },
    middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("arcId")!}/signals`)] as const,
    responses: { 201: { content: { "application/json": { schema: SignalSchema } }, description: "Create draft signal" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const arcResult = await arcDb.getArc(accountId, c.req.param("arcId")!);
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc || arc.status === "deleted") return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    const body = await zParse(CreateDraftSignalRequest, c.req.raw);
    const now = DateTime.utc().toISO()!;
    const id = generateId("sgn-");
    const signal: Signal = {
      id,
      signalLookupId: id,
      arcId: arc.id,
      accountId,
      source: "user",
      type: "email",
      status: "draft",
      labels: [],
      createdAt: now,
      data: {
        receivedAt: now,
        from: body.from as Signal["data"]["from"],
        to: body.to as Signal["data"]["to"],
        cc: [],
        subject: body.subject,
        ...(body.textBody != null ? { textBody: body.textBody } : {}),
        attachments: [],
        headers: {},
        recipientAddress: body.from.address,
        workflow: arc.workflow,
        workflowData: { workflow: arc.workflow } as Signal["data"]["workflowData"],
        tags: [],
        summary: "",
        s3Key: "",
      },
    };
    const createResult = await arcDb.createSignal(signal);
    if (createResult.isErr()) return err(c, 500, "Internal Server Error");
    await arcDb.updateArc(accountId, arc.id, arc.status, now, {});
    return c.json(toApiSignal(createResult.value), 201);
  });

  app.openapi(route({
    method: "put",
    path: "/accounts/{accountId}/arcs/{arcId}/signals/{id}",
    tags: ["Signals"],
    request: { params: z.object({ accountId: z.string(), arcId: z.string(), id: z.string() }) },
    middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("arcId")!}/signals/${c.req.param("id")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: SignalSchema } }, description: "Replace draft signal" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const arcResult = await arcDb.getArc(accountId, c.req.param("arcId")!);
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!, c.req.param("arcId")!);
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.arcId !== arc.id) return err(c, 400, "Signal does not belong to this arc", "SIGNAL_ARC_MISMATCH");
    if (signal.status === "sent") return err(c, 400, "Signal already sent", "SIGNAL_ALREADY_SENT");
    if (signal.status !== "draft") return err(c, 400, "Only draft signals can be replaced", "SIGNAL_NOT_DRAFT");
    const body = await zParse(ReplaceDraftSignalRequest, c.req.raw);
    const updateResult = await arcDb.updateSignal(accountId, signal.signalLookupId, {
      from: body.from as Signal["data"]["from"],
      to: body.to as Signal["data"]["to"],
      subject: body.subject,
      ...(body.textBody != null ? { textBody: body.textBody } : {}),
    });
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(toApiSignal(updateResult.value), 200);
  });

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/signals",
    tags: ["Signals"],
    request: {
      params: z.object({ accountId: z.string() }),
      query: z.object({ status: z.string(), cursor: z.string().optional(), limit: z.string().optional() }),
    },
    middleware: [authz("signals:read", c => `accounts/${c.req.param("accountId")!}/signals`)] as const,
    responses: { 200: { content: { "application/json": { schema: ListSignalsResponse } }, description: "List quarantined signals" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const query = c.req.query();
    const status = query["status"];
    if (status !== "quarantined" && status !== "quarantine_visible" && status !== "quarantine_hidden") {
      return err(c, 400, "status query param must be 'quarantined', 'quarantine_visible', or 'quarantine_hidden'", "INVALID_STATUS");
    }
    const params: PageParams = {
      ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
      ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
    };
    const result = await arcDb.listPreArcSignals(accountId, "quarantined", params);
    if (result.isErr()) return err(c, 500, "Internal Server Error");
    const items = (status === "quarantine_visible" || status === "quarantine_hidden")
      ? result.value.items.filter(s => s.status === status)
      : result.value.items;
    const itemsWithUrls = contentCdnBaseUrl ? items.map(s => withAttachmentUrls(s, contentCdnBaseUrl)) : items;
    return c.json(page("signals", itemsWithUrls.map(toApiSignal), result.value.nextCursor), 200);
  });

  app.openapi(route({
    method: "post",
    path: "/accounts/{accountId}/signals/{id}/quarantineResponse",
    tags: ["Signals"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/signals/${c.req.param("id")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: z.object({}) } }, description: "Quarantine response" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!);
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.status !== "quarantine_visible" && signal.status !== "quarantine_hidden") {
      return err(c, 400, "Only quarantined signals can have their status updated", "SIGNAL_NOT_REVIEWABLE");
    }

    const body = await zParse(UpdateSignalStatusRequest, c.req.raw);

    // Determine if quarantine was caused by unknown sender (no status-changing rule fired)
    const wasQuarantinedByUnknownSender = !(signal.data.matchedRules ?? []).some(r => r.statusChange);

    if (body.status === "block_hidden" || body.status === "block_reject" || body.status === "report_violation") {
      const blockResult = await arcDb.updateSignalStatus(accountId, signal.signalLookupId, body.status);
      if (blockResult.isErr()) return err(c, 500, "Internal Server Error");

      // When quarantined by unknown sender, persist sender disposition for future auto-blocking
      if (wasQuarantinedByUnknownSender) {
        const senderDomain = signal.data.from.address.includes("@") ? signal.data.from.address.split("@").pop()! : signal.data.from.address;
        const senderETLD1 = getDomain(senderDomain) ?? senderDomain;
        const recipientAddress = signal.data.recipientAddress;
        const ensureAliasResult = await ensureAliasExists(accountDb, accountId, recipientAddress, signal.id);
        if (ensureAliasResult.isErr()) return err(c, 500, "Internal Server Error");
        const saveSenderResult = await accountDb.saveSender(accountId, recipientAddress, senderETLD1, body.status);
        if (saveSenderResult.isErr()) return err(c, 500, "Internal Server Error");
      }

      return c.json(blockResult.value, 200);
    }

    // status === "active": find existing arc or create one, bypassing rule evaluation
    const senderDomain = signal.data.from.address.includes("@") ? signal.data.from.address.split("@").pop()! : signal.data.from.address;
    const senderETLD1 = getDomain(senderDomain) ?? senderDomain;
    const groupingKey = deriveGroupingKey(signal.data.workflow, signal.data.workflowData, signal.data.recipientAddress, senderETLD1);
    const matchedArcResult = groupingKey ? await arcDb.fastFindArcByAlternativeLookupKey(accountId, groupingKey) : null;
    if (matchedArcResult && matchedArcResult.isErr()) return err(c, 500, "Internal Server Error");
    const matchedArc = matchedArcResult ? matchedArcResult.value : null;

    const now = DateTime.utc().toISO()!;
    let arc: Arc;
    if (matchedArc) {
      const updateResult = await arcDb.updateArc(accountId, matchedArc.id, "active", signal.data.receivedAt, {});
      if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
      arc = updateResult.value;
    } else {
      arc = {
        id: generateId("thr-"),
        accountId,
        workflow: signal.data.workflow,
        labels: [],
        status: "active",
        summary: signal.data.summary,
        lastSignalAt: signal.data.receivedAt,
        senderAddress: (signal.data as { from?: { address?: string } }).from?.address ?? "",
        recipientAddress: (signal.data as { recipientAddress?: string }).recipientAddress ?? "",
        subject: (signal.data as { subject?: string }).subject ?? "",
        createdAt: now,
        updatedAt: now,
        ...(groupingKey ? { groupingKey } : {}),
      };
      const createResult = await arcDb.createArc(arc);
      if (createResult.isErr()) return err(c, 500, "Internal Server Error");
    }

    const unblockResult = await arcDb.unblockSignal(accountId, signal.signalLookupId, arc.id);
    if (unblockResult.isErr()) return err(c, 500, "Internal Server Error");

    // When quarantined by unknown sender, approve the sender for future emails
    if (wasQuarantinedByUnknownSender) {
      const ensureAliasResult = await ensureAliasExists(accountDb, accountId, signal.data.recipientAddress, signal.id);
      if (ensureAliasResult.isErr()) return err(c, 500, "Internal Server Error");
      const saveSenderResult = await accountDb.saveSender(accountId, signal.data.recipientAddress, senderETLD1, "allow");
      if (saveSenderResult.isErr()) return err(c, 500, "Internal Server Error");
    }

    // Post-approval calendar forwarding — process .ics attachment and forward if present
    if (postApprovalCalendarDeps) {
      const approvedSignal: Signal = { ...signal, status: "active", arcId: arc.id };
      try {
        await handlePostApprovalCalendar(approvedSignal, arc, postApprovalCalendarDeps);
      } catch (e) {
        logger.warn("Post-approval calendar handler threw unexpectedly.", {
          code: "api.quarantine_response.calendar_error",
          signal, arc,
          error: e,
        });
      }
    }

    const signalWithUrls = contentCdnBaseUrl ? withAttachmentUrls(signal, contentCdnBaseUrl) : signal;
    return c.json({ arc: toApiArc(arc), signal: toApiSignal({ ...signalWithUrls, status: "active", arcId: arc.id }) }, 200);
  });

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/signals/{id}",
    tags: ["Signals"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("signals:read", c => `accounts/${c.req.param("accountId")!}/signals/${c.req.param("id")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: SignalSchema } }, description: "Get signal" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!);
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    const withUrls = contentCdnBaseUrl ? withAttachmentUrls(signal, contentCdnBaseUrl) : signal;
    return c.json(toApiSignal(withUrls), 200);
  });

  // Raw email source — 307 redirect to presigned S3 URL
  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/signals/{id}/raw",
    tags: ["Signals"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("signals:read", c => `accounts/${c.req.param("accountId")!}/signals/${c.req.param("id")!}`)] as const,
    responses: { 307: { description: "Redirect to presigned S3 URL for the raw email" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!);
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (!isEmailSignal(signal)) return err(c, 400, "Signal is not an email", "SIGNAL_NOT_FOUND");
    if (!signal.data.s3Key) return err(c, 404, "Raw email not available", "SIGNAL_NOT_FOUND");

    const url = await generatePresignedGet(s3Client, emailBucket, signal.data.s3Key);
    return c.redirect(url, 307);
  });

  app.openapi(route({
    method: "patch",
    path: "/accounts/{accountId}/signals/{id}",
    tags: ["Signals"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/signals/${c.req.param("id")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: SignalSchema } }, description: "Update signal" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!);
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.status === "sent") return err(c, 400, "Signal already sent", "SIGNAL_ALREADY_SENT");
    if (signal.status !== "draft" && signal.status !== "pending_send") return err(c, 400, "Only draft or pending signals can be updated", "SIGNAL_NOT_EDITABLE");

    const body = await zParse(UpdateSignalRequest, c.req.raw);

    // If pending_send, only status change to "draft" is allowed
    if (signal.status === "pending_send") {
      const hasContentFields = body.subject !== undefined || body.textBody !== undefined || body.from !== undefined || body.to !== undefined;
      if (hasContentFields && body.status !== "draft") return err(c, 400, "Pending signals can only be reverted to draft", "INVALID_STATUS_TRANSITION");
      if (body.status !== "draft") return err(c, 400, "Pending signals can only be reverted to draft", "INVALID_STATUS_TRANSITION");
      const updateResult = await arcDb.updateSignalSendStatus(accountId, signal.signalLookupId, { status: "draft", sendInitiatedAt: null });
      if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
      return c.json(toApiSignal(updateResult.value), 200);
    }

    // Normal draft edit (subject, textBody, from, to)
    const updateResult = await arcDb.updateSignal(accountId, signal.signalLookupId, body as Parameters<typeof arcDb.updateSignal>[2]);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(toApiSignal(updateResult.value), 200);
  });

  app.openapi(route({
    method: "post",
    path: "/accounts/{accountId}/arcs/{arcId}/signals/{id}/send",
    tags: ["Signals"],
    request: { params: z.object({ accountId: z.string(), arcId: z.string(), id: z.string() }) },
    middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("arcId")!}/signals/${c.req.param("id")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: z.object({}) } }, description: "Send draft signal" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;

    // Arc validation
    const arcResult = await arcDb.getArc(accountId, c.req.param("arcId")!);
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");

    // Signal validation
    const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!, c.req.param("arcId")!);
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.arcId !== arc.id) return err(c, 400, "Signal does not belong to this arc", "SIGNAL_ARC_MISMATCH");
    if (signal.status !== "draft") return err(c, 400, "Only draft signals can be sent", "SIGNAL_NOT_DRAFT");

    // MX validation
    const mxResult = await validateRecipientMx(signal.data.to);
    if (mxResult.isErr()) {
      return err(c, 422, "Invalid recipient domain", "INVALID_RECIPIENT_DOMAIN", { invalidDomains: mxResult.error.invalidDomains });
    }

    // Verify the from address matches the arc's alias
    if (signal.data.from.address !== arc.recipientAddress) {
      logger.track("Draft send: from address does not match arc alias — rejecting.", {
        code: "draft_send.from_address_mismatch",
        signal, arc,
        fromAddress: signal.data.from.address,
        arcRecipientAddress: arc.recipientAddress,
      });
      return err(c, 422, "From address does not match arc alias");
    }

    // Compute undo window
    const undoWindowSeconds = computeUndoWindowSeconds(signal.data.textBody);
    const sendInitiatedAt = DateTime.utc().toISO()!;
    const undoExpiresAt = DateTime.utc().plus({ seconds: undoWindowSeconds }).toISO()!;

    // SQS FIRST — before DDB write
    if (!draftSendDispatcher) return err(c, 501, "Send not configured");
    const sqsResult = await draftSendDispatcher.dispatch({ signalId: signal.id, accountId, sendInitiatedAt }, undoWindowSeconds);
    if (sqsResult.isErr()) return err(c, 500, "Internal Server Error");

    // DDB write — transition to pending_send
    const updateResult = await arcDb.updateSignalSendStatus(accountId, signal.signalLookupId, { status: "pending_send", sendInitiatedAt });
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");

    return c.json({ ...toApiSignal(updateResult.value), undoWindowSeconds, undoExpiresAt }, 200);
  });

  app.openapi(route({
    method: "delete",
    path: "/accounts/{accountId}/signals/{id}",
    tags: ["Signals"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/signals/${c.req.param("id")!}`)] as const,
    responses: { 204: { description: "Signal deleted" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!);
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.status === "sent") return err(c, 400, "Signal already sent", "SIGNAL_ALREADY_SENT");
    if (signal.status !== "draft") return err(c, 400, "Only draft signals can be deleted", "SIGNAL_NOT_DRAFT");
    const deleteResult = await arcDb.deleteSignal(accountId, signal.signalLookupId);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Unsubscribe  —  /accounts/:accountId/arcs/:arcId/unsubscribe
  // -------------------------------------------------------------------------

  app.openapi(route({
    method: "post",
    path: "/accounts/{accountId}/arcs/{arcId}/unsubscribe",
    tags: ["Signals"],
    request: { params: z.object({ accountId: z.string(), arcId: z.string() }) },
    middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("arcId")!}`)] as const,
    responses: {
      200: { content: { "application/json": { schema: z.object({ status: z.string(), url: z.string().optional() }) } }, description: "Unsubscribe initiated and arc archived" },
    },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const arcResult = await arcDb.getArc(accountId, c.req.param("arcId")!);
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");

    // Find the latest email signal on this arc with unsubscribe info
    const signalsResult = await arcDb.listSignals(accountId, arc.id, { limit: 20 });
    if (signalsResult.isErr()) return err(c, 500, "Internal Server Error");

    const emailSignal = signalsResult.value.items.find(
      (s): s is Signal => s.type === "email" && s.source === "email" && Boolean((s.data as Signal["data"]).unsubscribe),
    );
    if (!emailSignal) return err(c, 400, "No unsubscribe info available for this arc");

    const unsubscribe = emailSignal.data.unsubscribe!;

    // Attempt server-side unsubscribe for "server" type
    if (unsubscribe.type === "server") {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(unsubscribe.url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
          logger.warn("Unsubscribe POST returned non-2xx.", {
            code: "unsubscribe.post_failed",
            signal: emailSignal, arc,
            url: unsubscribe.url,
            statusCode: response.status,
          });
          return err(c, 503, "Unsubscribe endpoint returned an error");
        }
      } catch (e) {
        clearTimeout(timeout);
        logger.warn("Unsubscribe POST failed — network error or timeout.", {
          code: "unsubscribe.post_error",
          signal: emailSignal, arc,
          url: unsubscribe.url,
          error: e,
        });
        return err(c, 503, "Failed to reach unsubscribe endpoint");
      }
    }

    if (unsubscribe.type === "mailto") {
      logger.track("Unsubscribe via mailto — user must complete externally.", {
        code: "unsubscribe.mailto_pending",
        signal: emailSignal, arc,
        url: unsubscribe.url,
      });
    }

    // Archive the arc regardless of unsubscribe type
    const archiveResult = await arcDb.updateArc(accountId, arc.id, "archived", arc.lastSignalAt, {});
    if (archiveResult.isErr()) return err(c, 500, "Internal Server Error");

    // Return url for website/mailto so frontend can open it if needed
    const responseUrl = unsubscribe.type !== "server" ? unsubscribe.url : undefined;
    return c.json({ status: "unsubscribed", ...(responseUrl ? { url: responseUrl } : {}) }, 200);
  });

  // -------------------------------------------------------------------------
  // Calendar RSVP  —  /accounts/:accountId/arcs/:arcId/signals/:id/rsvp
  // -------------------------------------------------------------------------

  app.openapi(route({
    method: "post",
    path: "/accounts/{accountId}/arcs/{arcId}/signals/{id}/rsvp",
    tags: ["Signals"],
    request: { params: z.object({ accountId: z.string(), arcId: z.string(), id: z.string() }) },
    middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("arcId")!}/signals/${c.req.param("id")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: SignalSchema } }, description: "RSVP to calendar invite" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    if (!emailService || !rsvpComposer) return err(c, 501, "RSVP not configured");

    // Validate arc
    const arcResult = await arcDb.getArc(accountId, c.req.param("arcId")!);
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");

    // Validate signal — must be a calendar_event signal
    const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!, c.req.param("arcId")!);
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.arcId !== arc.id) return err(c, 400, "Signal does not belong to this arc", "SIGNAL_ARC_MISMATCH");
    if (!isCalendarEventSignal(signal)) return err(c, 400, "Signal is not a calendar event", "NOT_CALENDAR_EVENT");

    const calendarData = signal.data;
    const body = await zParse(RsvpRequest, c.req.raw);

    // Determine alias address — the recipientAddress from the originating email signal
    // The alias is the address that received the original invite
    const aliasAddress = calendarData.organizer ? `${arc.id}@${accountId}.${MAIL_DOMAIN}` : "";

    // Look up the originating email signal to get the actual alias address
    const emailSignalResult = await arcDb.getSignalById(accountId, calendarData.linkedSignalId, arc.id);
    const emailSignal = emailSignalResult.isOk() ? emailSignalResult.value : null;
    const recipientAddress = emailSignal?.data && "recipientAddress" in emailSignal.data ? (emailSignal.data as { recipientAddress: string }).recipientAddress : "";

    if (!recipientAddress) return err(c, 400, "Cannot determine alias address for RSVP", "NO_ALIAS_ADDRESS");

    // Check domain sender setup (DKIM + SPF) — domain misconfiguration check
    const aliasDomain = recipientAddress.split("@")[1] ?? "";
    const domainResult = await accountDb.getDomainByName(accountId, aliasDomain);
    if (domainResult.isErr()) return err(c, 500, "Internal Server Error");
    const domain = domainResult.value;

    if (!domain?.senderSetupComplete) {
      // Domain misconfiguration — create domain_misconfiguration signal, return 422
      const now = DateTime.utc().toISO()!;
      const misconfigSignalId = generateId("sgn-");
      const misconfigSignal: Signal<DomainMisconfigurationData> = {
        id: misconfigSignalId,
        signalLookupId: misconfigSignalId,
        arcId: arc.id,
        accountId,
        source: "signal",
        type: "domain_misconfiguration",
        status: "active",
        labels: [],
        createdAt: now,
        data: {
          reason: "DKIM + SPF not configured for alias domain",
          linkedSignalId: signal.id,
          aliasAddress: recipientAddress,
          domain: aliasDomain,
        },
      };
      await arcDb.saveSignal(misconfigSignal);
      return err(c, 422, "Domain misconfiguration", "DOMAIN_MISCONFIGURATION", { domain: aliasDomain, reason: "DKIM + SPF not configured for alias domain" });
    }

    // Send-first: call RSVP_Composer
    const rsvpResult = await rsvpComposer(
      {
        decision: body.decision,
        originalCalendarData: calendarData,
        aliasAddress: recipientAddress,
        organizerAddress: calendarData.organizer,
        fromAddress: recipientAddress,
        accountId,
      },
      { emailService },
    );

    // On send failure: return error, do NOT create signal (Property 13)
    if (rsvpResult.isErr()) {
      return err(c, 422, "Failed to send RSVP", "RSVP_SEND_FAILED");
    }

    // On success: create calendar_response signal
    const now = DateTime.utc().toISO()!;
    const responseSignalId = generateId("sgn-");
    const responseSignal: Signal<CalendarResponseData> = {
      id: responseSignalId,
      signalLookupId: responseSignalId,
      arcId: arc.id,
      accountId,
      source: "user",
      type: "calendar_response",
      status: "active",
      labels: [],
      createdAt: now,
      data: {
        decision: body.decision,
        respondedAt: now,
        veventUid: calendarData.originalVeventUid,
        linkedSignalId: signal.id,
        sendStatus: "sent",
      },
    };

    const saveResult = await arcDb.saveSignal(responseSignal);
    if (saveResult.isErr()) return err(c, 500, "Internal Server Error");

    // Non-blocking RSVP schedule cancellation
    // The calendar_event signal is already loaded as `signal` (validated above)
    if (schedulerClient && calendarData.startTime) {
      const eventStart = DateTime.fromISO(calendarData.startTime, { zone: "utc" });
      if (eventStart.isValid && eventStart > DateTime.utc()) {
        const scheduleName = buildScheduleName(accountId, signal.id, `rsvp.${eventStart.toFormat("yyyyMMdd")}`);
        const deleteResult = await schedulerClient.deleteFollowup(scheduleName);
        if (deleteResult.isErr()) {
          logger.warn("Failed to delete RSVP reminder schedule — fire-time check will handle.", { code: "rsvp.cancel.delete_failed", signal, arc, scheduleName, error: deleteResult.error });
        }
      }
    } else if (schedulerClient && !calendarData.startTime) {
      logger.track("Calendar event has no startTime — skipping RSVP schedule cancellation.", { code: "rsvp.cancel.no_start_time", signal, arc });
    }

    return c.json(toApiSignal(responseSignal), 200);
  });

  // -------------------------------------------------------------------------
  // Views  —  /accounts/:accountId/views
  // -------------------------------------------------------------------------
  registerViewsRoutes(app, { accountDb, authz, err, route });

  // -------------------------------------------------------------------------
  // Labels  —  /accounts/:accountId/labels
  // -------------------------------------------------------------------------
  registerLabelsRoutes(app, { accountDb, authz, err, route });

  // -------------------------------------------------------------------------
  // Rules  —  /accounts/:accountId/rules
  // -------------------------------------------------------------------------
  registerRulesRoutes(app, { accountDb, auditDb, authz, err, route, astValidator, billingHandler, logger });

  // -------------------------------------------------------------------------
  // Domains  —  /accounts/:accountId/domains
  // -------------------------------------------------------------------------
  registerDomainsRoutes(app, { accountDb, domainIdentityService, logger, authz, err, route });

  // -------------------------------------------------------------------------
  // Aliases, Alias Senders, Forwarding Addresses
  // -------------------------------------------------------------------------
  registerAliasesRoutes(app, { accountDb, logger, verificationMailer, authz, err, route });

  // -------------------------------------------------------------------------
  // Email Templates  —  /accounts/:accountId/templates
  // -------------------------------------------------------------------------
  registerTemplatesRoutes(app, { accountDb, auditDb, authz, err, route, astValidator, logger });


  // -------------------------------------------------------------------------
  // Audit  —  /accounts/:accountId/audit
  // -------------------------------------------------------------------------
  registerAuditRoutes(app, { auditDb, authz, err, route });

  // ---------------------------------------------------------------------------
  // Signal reprocess (admin)
  // ---------------------------------------------------------------------------

  app.openapi(route({
    method: "post",
    path: "/accounts/{accountId}/signals/{id}/reprocess",
    tags: ["Admin"],
    request: {
      params: z.object({ accountId: z.string(), id: z.string() }),
    },
    middleware: [authz("management:write", "reindex")] as const,
    responses: {
      200: { content: { "application/json": { schema: SignalSchema } }, description: "Signal reprocessed" },
    },
  }), async (c) => {
    const { accountId, id } = c.req.valid("param");
    const result = await signalReprocessor.reprocessSignal(accountId, id);
    if (result.isErr()) return err(c, 500, "Reprocess failed");
    return c.json(toApiSignal(result.value), 200);
  });

  // ---------------------------------------------------------------------------
  // Reindex jobs (admin)
  // ---------------------------------------------------------------------------
  registerAdminRoutes(app, { jobDispatcher, authz, err, route });

  // ---------------------------------------------------------------------------
  // Not Found & Method Not Allowed — must be registered after all routes
  // ---------------------------------------------------------------------------

  app.notFound((c) => {
    c.set(ROUTE_NOT_FOUND_KEY, true);

    const requestMethod = c.req.method;
    const requestPath = c.req.path;

    // Check if this path matches any registered route with a different method (→ 405)
    const registeredMethods = new Set<string>();
    for (const r of app.routes) {
      if (r.method === "ALL") continue;
      // Convert Hono path template :param to regex for matching
      const pattern = new RegExp("^" + r.path.replace(/:[^/]+/g, "[^/]+") + "$");
      if (pattern.test(requestPath) && r.method !== requestMethod) {
        registeredMethods.add(r.method);
      }
    }

    if (registeredMethods.size > 0) {
      return c.json({ title: "Method Not Allowed" }, 405);
    }

    return c.json({ title: "Not Found" }, 404);
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAIL_DOMAIN = process.env["MAIL_DOMAIN"] ?? "platform.email.rhosys.cloud";
const API_DOMAIN = process.env["API_DOMAIN"] ?? "";
const KMS_KEY_ARN = process.env["AUTHRESS_KMS_KEY_ARN"] ?? "";
const KEY_ID = process.env["AUTHRESS_KEY_ID"] ?? "";
