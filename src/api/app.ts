import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { randomUUID, createHash, randomBytes } from "crypto";
import { DateTime } from "luxon";
import { generateId, generateAccountId } from "../utils/id.js";
import { getDomain } from "tldts";
import { checkDomain } from "../dns/dns-checker.js";
import { validateRecipientMx } from "../dns/mx-validator.js";
import { computeUndoWindowSeconds } from "./undo-window.js";
import type { AuditEvent, AuditDatabase } from "../database/audit-database.js";
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
import { toApiArc, toApiAccount, toApiSignal, toApiDomain, toApiDomainWithRecords, toApiAlias, toApiAliasSender, toApiLabel, toApiRule, toApiView, toApiTemplate, toApiForwardingAddress } from "./transform.js";
import { validateRuleCondition } from "./validate-rule-condition.js";
import { validateWebhookConfig } from "./validate-webhook-config.js";
import type { UserCodeExecutorClient } from "../processor/user-code-client.js";
import type { BillingHandler } from "../billing/billing-handler.js";
import type { BillingPlan } from "../embedding/retention-tier.js";
import { parseStatsRow } from "../database/stats-writer.js";
import { isValidEmail } from "../email/validate-email.js";
import type { DraftSendDispatcher } from "../processor/draft-send-dispatcher.js";
import type { EmailService } from "../email/email-service.js";
import type { DomainIdentityService } from "../email/domain-identity-service.js";
import type { sendRsvp as SendRsvpFn } from "../processor/calendar/rsvp-composer.js";
import type { PostApprovalCalendarHandlerDeps } from "../processor/calendar/post-approval-handler.js";
import { handlePostApprovalCalendar } from "../processor/calendar/post-approval-handler.js";
import type { SchedulerClient } from "../scheduler/scheduler-client.js";
import { buildScheduleName } from "../scheduler/schedule-name.js";
import { durationToSeconds } from "../processor/retention.js";

// ---------------------------------------------------------------------------
// Job Dispatcher interface (used by reindex route)
// ---------------------------------------------------------------------------

export interface JobDispatcher {
  dispatch(targetRegistryId: string, segmentCount?: number): Promise<Result<{
    jobId: string; targetRegistryId: string; modelId: string; segmentCount: number; startedAt: string;
  }, NotFoundError>>;
}
import { authorizationGuard } from "./authorization-guard.js";
import { createAuthorize } from "./authorization-middleware.js";
import {
  UpdateArcRequest, UpdateSignalRequest, UpdateSignalStatusRequest,
  CreateViewRequest, UpdateViewRequest,
  CreateLabelRequest, UpdateLabelRequest,
  CreateRuleRequest, UpdateRuleRequest,
  CreateDomainRequest,
  CreateAliasRequest, UpdateAliasRequest,
  UpdateAccountRequest,
  CreateForwardingAddressRequest, VerifyForwardingAddressRequest,
  InviteUserRequest, UpdateUserRequest,
  CreateSenderRequest, UpdateSenderRequest, CreateTemplateRequest, ReplaceTemplateRequest, UpdateTemplateRequest,
  CreateDraftSignalRequest, ReplaceDraftSignalRequest,
  RsvpRequest,
} from "./requests.js";
import {
  Account as AccountSchema, Arc as ArcSchema, Signal as SignalSchema,
  View as ViewSchema, Label as LabelSchema, Rule as RuleSchema,
  Domain as DomainSchema, DomainWithRecords as DomainWithRecordsSchema,
  Alias as AliasSchema, AliasSender as AliasSenderSchema,
  EmailTemplate as EmailTemplateSchema, VerifiedForwardingAddress as VerifiedForwardingAddressSchema,
  ListArcsResponse, ListSignalsResponse, ListViewsResponse, ListLabelsResponse,
  ListRulesResponse, ListDomainsResponse, ListAliasesResponse, ListSendersResponse,
  ListTemplatesResponse, ListForwardingAddressesResponse,
  ErrorResponse, ErrorCode, Pagination as PaginationSchema,
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
}

type AppEnv = { Variables: { auth: AuthContext; authorizationVerified?: boolean } };

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

// Mirrors processor.ts's autoApprove — a sender disposition recorded for an address
// implies that address is a recognised alias, so the Alias record must exist alongside it.
async function ensureAliasExists(accountDb: AccountDatabase, accountId: string, address: string): Promise<Result<void, DbError>> {
  const filteringResult = await accountDb.getAccountFilteringConfig(accountId);
  if (filteringResult.isErr()) return neverthrowErr(filteringResult.error);
  const defaultUnknownSenderPolicy = filteringResult.value?.defaultUnknownSenderPolicy ?? "quarantine_visible";

  const aliasResult = await accountDb.ensureAlias(accountId, address, defaultUnknownSenderPolicy);
  if (aliasResult.isErr()) return neverthrowErr(aliasResult.error);
  return neverthrowOk(undefined);
}

export function createApp({ arcDb, accountDb, auditDb, auth, access, logger, verificationMailer, jobDispatcher, draftSendDispatcher, accountCreationStarter, appBaseUrl, contentCdnBaseUrl, astValidator, billingHandler, emailService, domainIdentityService, rsvpComposer, postApprovalCalendarDeps, schedulerClient }: AppDeps) {
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
    const body = c.req.method !== "GET" && c.req.method !== "HEAD"
      ? await c.req.raw.clone().text()
      : undefined;

    await next();

    const status = c.res.status;
    const logData: Record<string, unknown> = {
      code: "api.request",
      method: c.req.method,
      path: c.req.path,
      status,
      requestHeaders: Object.fromEntries(c.req.raw.headers.entries()),
      ...(body ? { requestBody: body } : {}),
      responseHeaders: Object.fromEntries(c.res.headers.entries()),
    };

    if (status >= 400) {
      logData["responseBody"] = await c.res.clone().text();
      logger.warn("RequestLogger", logData);
    } else {
      logger.info("RequestLogger", logData);
    }
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
  // Accounts  —  /accounts
  // -------------------------------------------------------------------------

  app.openapi(route({
    method: "get",
    path: "/accounts",
    tags: ["Accounts"],
    responses: { 200: { content: { "application/json": { schema: z.object({ accounts: z.array(AccountSchema) }) } }, description: "List accounts" } },
  }), async (c) => {
    const { userId } = c.get("auth");
    if (!access) return err(c, 501, "Not implemented");

    // Query Authress for all accounts this user has access to
    const usersResult = await access.listAccountsForUser(userId);
    if (usersResult.isErr()) return err(c, 500, "Internal Server Error");
    const accountIds = usersResult.value;

    // Fetch each account from DynamoDB
    const accounts: Account[] = [];
    for (const accountId of accountIds) {
      const accountResult = await accountDb.getAccount(accountId);
      if (accountResult.isErr()) continue;
      if (accountResult.value) accounts.push(accountResult.value);
    }

    return c.json({ accounts: accounts.map(toApiAccount) }, 200);
  });

  app.openapi(route({
    method: "post",
    path: "/accounts",
    tags: ["Accounts"],
    responses: {
      201: { content: { "application/json": { schema: AccountSchema } }, description: "Account created" },
    },
  }), async (c) => {
    const { userId } = c.get("auth");
    if (!access) return err(c, 501, "Not implemented");

    // Check if user already has an account via Authress
    const existingResult = await access.listAccountsForUser(userId);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    if (existingResult.value.length > 0) return err(c, 409, "Account already exists", "ACCOUNT_EXISTS");

    // generateAccountId uses randomBytes(10) → collision space ≈ 3.6×10^15;
    // retry loop is a safety net only.
    const now = DateTime.utc().toISO()!;
    let account: Account | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate: Account = {
        id: generateAccountId(),
        name: "",
        retentionDuration: "P3M",
        billingPlan: "Trial",
        onboarding: { completed: false },
        createdAt: now,
        updatedAt: now,
      };

      // Step Function first — self-healing: checks DDB account existence and
      // Authress permissions on each retry, so an orphaned execution (from an ID
      // collision below) fails cleanly when it finds no DDB record.
      if (accountCreationStarter) {
        await accountCreationStarter.start(candidate.id, userId);
      }

      // DDB write — commit the account record
      const createResult = await accountDb.createAccount(candidate);
      if (createResult.isOk()) {
        account = candidate;
        break;
      }
      // ID collision — orphaned SFN execution will fail cleanly without a DDB record
    }
    if (!account) return err(c, 500, "Internal Server Error");

    // Authress write — blocking so the user gets valid permissions on the 201 response
    // (SFN also writes Authress as a self-healing fallback)
    const accessResult = await access.addUser(account.id, userId, "admin");
    if (accessResult.isErr()) {
      logger.error("Failed to create Authress access record for new account.", { code: "api.account_create.authress_failed", userId, accountId: account.id, error: accessResult.error });
      return err(c, 500, "Internal Server Error");
    }

    return c.json(toApiAccount(account), 201);
  });

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

    // violate_report: block the sender domain and delete the arc
    if (body.status === "violate_report") {
      const signalsResult = await arcDb.listSignals(accountId, arc.id, { limit: 1 });
      if (signalsResult.isErr()) return err(c, 500, "Internal Server Error");
      const signal = signalsResult.value.items[0];
      if (signal) {
        const senderDomain = signal.data.from.address.includes("@") ? signal.data.from.address.split("@").pop()! : signal.data.from.address;
        const senderETLD1 = getDomain(senderDomain) ?? senderDomain;
        const recipientAddress = signal.data.recipientAddress;
        const saveSenderResult = await accountDb.saveSender(accountId, recipientAddress, senderETLD1, "violate_report");
        if (saveSenderResult.isErr()) return err(c, 500, "Internal Server Error");
        logger.track("Arc reported as GDPR violation. Sender domain blocked with violate_report policy and arc deleted.", {
          code: "api.arc.violate_report",
          accountId,
          arcId: arc.id,
          senderDomain: senderETLD1,
          recipientAddress: signal.data.recipientAddress,
          fromAddress: signal.data.from.address,
        });
      }
      // Persist as deleted — violate_report is the user intent, deleted is the arc state
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
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
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
        spamScore: 0,
        summary: "",
        s3Key: "",
      },
    };
    const createResult = await arcDb.createSignal(signal);
    if (createResult.isErr()) return err(c, 500, "Internal Server Error");
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

    if (body.status === "block_hidden" || body.status === "block_reject" || body.status === "violate_report") {
      const blockResult = await arcDb.updateSignalStatus(accountId, signal.signalLookupId, body.status);
      if (blockResult.isErr()) return err(c, 500, "Internal Server Error");

      // When quarantined by unknown sender, persist sender disposition for future auto-blocking
      if (wasQuarantinedByUnknownSender) {
        const senderDomain = signal.data.from.address.includes("@") ? signal.data.from.address.split("@").pop()! : signal.data.from.address;
        const senderETLD1 = getDomain(senderDomain) ?? senderDomain;
        const recipientAddress = signal.data.recipientAddress;
        const ensureAliasResult = await ensureAliasExists(accountDb, accountId, recipientAddress);
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
        id: generateId("arc-"),
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
      const ensureAliasResult = await ensureAliasExists(accountDb, accountId, signal.data.recipientAddress);
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
          accountId,
          signalId: signal.id,
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
        accountId,
        signalId: signal.id,
        arcId: arc.id,
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
            accountId,
            arcId: arc.id,
            signalId: emailSignal.id,
            url: unsubscribe.url,
            statusCode: response.status,
          });
          return err(c, 503, "Unsubscribe endpoint returned an error");
        }
      } catch (e) {
        clearTimeout(timeout);
        logger.warn("Unsubscribe POST failed — network error or timeout.", {
          code: "unsubscribe.post_error",
          accountId,
          arcId: arc.id,
          signalId: emailSignal.id,
          url: unsubscribe.url,
          error: e,
        });
        return err(c, 503, "Failed to reach unsubscribe endpoint");
      }
    }

    if (unsubscribe.type === "mailto") {
      logger.track("Unsubscribe via mailto — user must complete externally.", {
        code: "unsubscribe.mailto_pending",
        accountId,
        arcId: arc.id,
        signalId: emailSignal.id,
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
          logger.warn("Failed to delete RSVP reminder schedule — fire-time check will handle.", { code: "rsvp.cancel.delete_failed", scheduleName, error: deleteResult.error });
        }
      }
    } else if (schedulerClient && !calendarData.startTime) {
      logger.track("Calendar event has no startTime — skipping RSVP schedule cancellation.", { code: "rsvp.cancel.no_start_time", accountId, arcId: arc.id, signalId: signal.id });
    }

    return c.json(toApiSignal(responseSignal), 200);
  });

  // -------------------------------------------------------------------------
  // Views  —  /accounts/:accountId/views
  // -------------------------------------------------------------------------

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/views",
    tags: ["Views"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("views:read", c => `accounts/${c.req.param("accountId")!}/views`)] as const,
    responses: { 200: { content: { "application/json": { schema: ListViewsResponse } }, description: "List views" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const viewsResult = await accountDb.listViews(accountId);
    if (viewsResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json({ views: viewsResult.value.map(toApiView) }, 200);
  });

  app.openapi(route({
    method: "post",
    path: "/accounts/{accountId}/views",
    tags: ["Views"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("views:write", c => `accounts/${c.req.param("accountId")!}/views`)] as const,
    responses: { 201: { content: { "application/json": { schema: ViewSchema } }, description: "View created" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const body = await zParse(CreateViewRequest, c.req.raw);
    const viewResult = await accountDb.createView(accountId, body);
    if (viewResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(toApiView(viewResult.value), 201);
  });

  app.openapi(route({
    method: "patch",
    path: "/accounts/{accountId}/views/{id}",
    tags: ["Views"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("views:write", c => `accounts/${c.req.param("accountId")!}/views/${c.req.param("id")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: ViewSchema } }, description: "Update view" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const viewResult = await accountDb.getView(accountId, c.req.param("id")!);
    if (viewResult.isErr()) return err(c, 500, "Internal Server Error");
    const view = viewResult.value;
    if (!view) return err(c, 404, "View not found", "VIEW_NOT_FOUND");
    const body = await zParse(UpdateViewRequest, c.req.raw);
    const updateResult = await accountDb.updateView(accountId, view.id, body);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(toApiView(updateResult.value), 200);
  });

  app.openapi(route({
    method: "delete",
    path: "/accounts/{accountId}/views/{id}",
    tags: ["Views"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("views:write", c => `accounts/${c.req.param("accountId")!}/views/${c.req.param("id")!}`)] as const,
    responses: { 204: { description: "View deleted" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const viewResult = await accountDb.getView(accountId, c.req.param("id")!);
    if (viewResult.isErr()) return err(c, 500, "Internal Server Error");
    const view = viewResult.value;
    if (!view) return err(c, 404, "View not found", "VIEW_NOT_FOUND");
    const deleteResult = await accountDb.deleteView(accountId, view.id);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Labels  —  /accounts/:accountId/labels
  // -------------------------------------------------------------------------

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/labels",
    tags: ["Labels"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("labels:read", c => `accounts/${c.req.param("accountId")!}/labels`)] as const,
    responses: { 200: { content: { "application/json": { schema: ListLabelsResponse } }, description: "List labels" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const labelsResult = await accountDb.listLabels(accountId);
    if (labelsResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json({ labels: labelsResult.value.map(toApiLabel) }, 200);
  });

  app.openapi(route({
    method: "post",
    path: "/accounts/{accountId}/labels",
    tags: ["Labels"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("labels:write", c => `accounts/${c.req.param("accountId")!}/labels`)] as const,
    responses: { 201: { content: { "application/json": { schema: LabelSchema } }, description: "Label created" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const body = await zParse(CreateLabelRequest, c.req.raw);
    const labelResult = await accountDb.createLabel(accountId, body);
    if (labelResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(toApiLabel(labelResult.value), 201);
  });

  app.openapi(route({
    method: "patch",
    path: "/accounts/{accountId}/labels/{id}",
    tags: ["Labels"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("labels:write", c => `accounts/${c.req.param("accountId")!}/labels/${c.req.param("id")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: LabelSchema } }, description: "Update label" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const labelsResult = await accountDb.listLabels(accountId);
    if (labelsResult.isErr()) return err(c, 500, "Internal Server Error");
    const label = labelsResult.value.find((l) => l.id === c.req.param("id")!);
    if (!label) return err(c, 404, "Label not found", "LABEL_NOT_FOUND");
    const body = await zParse(UpdateLabelRequest, c.req.raw);
    const updateResult = await accountDb.updateLabel(accountId, label.id, body);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(toApiLabel(updateResult.value), 200);
  });

  app.openapi(route({
    method: "delete",
    path: "/accounts/{accountId}/labels/{id}",
    tags: ["Labels"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("labels:write", c => `accounts/${c.req.param("accountId")!}/labels/${c.req.param("id")!}`)] as const,
    responses: { 204: { description: "Label deleted" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const labelsResult = await accountDb.listLabels(accountId);
    if (labelsResult.isErr()) return err(c, 500, "Internal Server Error");
    const label = labelsResult.value.find((l) => l.id === c.req.param("id")!);
    if (!label) return err(c, 404, "Label not found", "LABEL_NOT_FOUND");
    const deleteResult = await accountDb.deleteLabel(accountId, label.id);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Rules  —  /accounts/:accountId/rules
  // -------------------------------------------------------------------------

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/rules",
    tags: ["Rules"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("rules:read", c => `accounts/${c.req.param("accountId")!}/rules`)] as const,
    responses: { 200: { content: { "application/json": { schema: ListRulesResponse } }, description: "List rules" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const rulesResult = await accountDb.listRules(accountId);
    if (rulesResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json({ rules: rulesResult.value.map(toApiRule) }, 200);
  });

  app.openapi(route({
    method: "post",
    path: "/accounts/{accountId}/rules",
    tags: ["Rules"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("rules:write", c => `accounts/${c.req.param("accountId")!}/rules`)] as const,
    responses: { 201: { content: { "application/json": { schema: RuleSchema } }, description: "Rule created" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const body = await zParse(CreateRuleRequest, c.req.raw);
    const effectiveConditionType = body.conditionType ?? "json_logic";
    if (effectiveConditionType === "js") {
      if (!body.condition || body.condition.trim().length === 0) {
        return err(c, 400, "condition field is required when conditionType is 'js'", "MISSING_CODE");
      }
      const astResult = astValidator ? await astValidator.validateAst(body.condition) : undefined;
      if (!astResult || astResult.isErr()) {
        const e = astResult?.error;
        const message = e?.kind === "ast_validation_error" ? e.message : (e?.message ?? "AST validator not configured");
        const location = e?.kind === "ast_validation_error" ? e.location : undefined;
        return err(c, 400, message, "INVALID_CODE", location ? { location } : undefined);
      }
    } else {
      if (body.condition) {
        const conditionError = validateRuleCondition(body.condition);
        if (conditionError) return err(c, 400, conditionError, "INVALID_CONDITION");
      }
    }
    const forwardError = await validateForwardTargets(accountId, body.actions as Rule["actions"], accountDb);
    if (forwardError) return err(c, 400, forwardError, "UNVERIFIED_FORWARD_TARGET");
    const accountResult = await accountDb.getAccount(accountId);
    const accountPlan: BillingPlan = (accountResult.isOk() && accountResult.value?.billingPlan) || "Free";
    const webhookError = validateWebhookActions(body.actions as Rule["actions"], accountPlan, billingHandler);
    if (webhookError) return err(c, 400, webhookError.message, webhookError.code);
    // Audit: write code change event before persisting (best-effort)
    if (effectiveConditionType === "js") {
      const { userId } = c.get("auth");
      const auditResult = await auditDb.saveAuditEvent({
        accountId, userId, action: "created", resourceType: "rule", resourceId: "",
        before: null, after: { conditionType: "js", condition: body.condition },
      });
      if (auditResult.isErr()) {
        logger.warn("Audit write failed for rule creation, proceeding with resource write", { code: "api.audit.rule_create_failed", accountId, error: auditResult.error });
      }
    }
    const ruleResult = await accountDb.createRule(accountId, body as Parameters<typeof accountDb.createRule>[1]);
    if (ruleResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(toApiRule(ruleResult.value), 201);
  });

  app.openapi(route({
    method: "patch",
    path: "/accounts/{accountId}/rules/{id}",
    tags: ["Rules"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("rules:write", c => `accounts/${c.req.param("accountId")!}/rules/${c.req.param("id")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: RuleSchema } }, description: "Update rule" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const rulesResult = await accountDb.listRules(accountId);
    if (rulesResult.isErr()) return err(c, 500, "Internal Server Error");
    const rule = rulesResult.value.find((r) => r.id === c.req.param("id")!);
    if (!rule) return err(c, 404, "Rule not found", "RULE_NOT_FOUND");
    const body = await zParse(UpdateRuleRequest, c.req.raw);
    // System rules (SR-*) are immutable except for enable/disable — only `status` may change.
    if (rule.accountId === "SYSTEM") {
      const changedKeys = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
      if (changedKeys.some((k) => k !== "status")) {
        return err(c, 403, "System rules can only be enabled or disabled", "SYSTEM_RULE_IMMUTABLE");
      }
      if (body.status === undefined) {
        return err(c, 403, "System rules can only be enabled or disabled", "SYSTEM_RULE_IMMUTABLE");
      }
      const result = await accountDb.upsertSystemRuleStatus(accountId, rule.id, body.status);
      if (result.isErr()) return err(c, 500, "Internal Server Error");
      return c.json(toApiRule({ ...rule, status: body.status }), 200);
    }
    const effectiveConditionType = body.conditionType ?? rule.conditionType ?? "json_logic";
    if (effectiveConditionType === "js") {
      // If condition is being provided, validate it as JS
      if (body.condition !== undefined) {
        if (!body.condition || body.condition.trim().length === 0) {
          return err(c, 400, "condition field is required when conditionType is 'js'", "MISSING_CODE");
        }
        const astResult = astValidator ? await astValidator.validateAst(body.condition) : undefined;
        if (!astResult || astResult.isErr()) {
          const e = astResult?.error;
          const message = e?.kind === "ast_validation_error" ? e.message : (e?.message ?? "AST validator not configured");
          const location = e?.kind === "ast_validation_error" ? e.location : undefined;
          return err(c, 400, message, "INVALID_CODE", location ? { location } : undefined);
        }
      }
      // If switching to "js" conditionType without providing condition, require existing condition on the rule
      if (body.conditionType === "js" && body.condition === undefined && !rule.condition) {
        return err(c, 400, "condition field is required when conditionType is 'js'", "MISSING_CODE");
      }
    } else {
      if (body.condition) {
        const conditionError = validateRuleCondition(body.condition);
        if (conditionError) return err(c, 400, conditionError, "INVALID_CONDITION");
      }
    }
    if (body.actions) {
      const forwardError = await validateForwardTargets(accountId, body.actions as Rule["actions"], accountDb);
      if (forwardError) return err(c, 400, forwardError, "UNVERIFIED_FORWARD_TARGET");
      const accountResult = await accountDb.getAccount(accountId);
      const accountPlan: BillingPlan = (accountResult.isOk() && accountResult.value?.billingPlan) || "Free";
      const webhookError = validateWebhookActions(body.actions as Rule["actions"], accountPlan, billingHandler);
      if (webhookError) return err(c, 400, webhookError.message, webhookError.code);
    }
    // Clear lastError when condition is updated on a JS rule
    const updateData: Parameters<typeof accountDb.updateRule>[2] = { ...body } as Parameters<typeof accountDb.updateRule>[2];
    if (effectiveConditionType === "js" && body.condition !== undefined) {
      (updateData as Record<string, unknown>)["lastError"] = null;
    }
    // Audit: write code change event before persisting (best-effort)
    if (effectiveConditionType === "js" && body.condition !== undefined) {
      const { userId } = c.get("auth");
      const auditResult = await auditDb.saveAuditEvent({
        accountId, userId, action: "updated", resourceType: "rule", resourceId: rule.id,
        before: { conditionType: rule.conditionType ?? "json_logic", condition: rule.condition },
        after: { conditionType: effectiveConditionType, condition: body.condition },
      });
      if (auditResult.isErr()) {
        logger.warn("Audit write failed for rule update, proceeding with resource write", { code: "api.audit.rule_update_failed", accountId, ruleId: rule.id, error: auditResult.error });
      }
    }
    const updateResult = await accountDb.updateRule(accountId, rule.id, updateData);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(toApiRule(updateResult.value), 200);
  });

  app.openapi(route({
    method: "delete",
    path: "/accounts/{accountId}/rules/{id}",
    tags: ["Rules"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("rules:write", c => `accounts/${c.req.param("accountId")!}/rules/${c.req.param("id")!}`)] as const,
    responses: { 204: { description: "Rule deleted" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const rulesResult = await accountDb.listRules(accountId);
    if (rulesResult.isErr()) return err(c, 500, "Internal Server Error");
    const rule = rulesResult.value.find((r) => r.id === c.req.param("id")!);
    if (!rule) return err(c, 404, "Rule not found", "RULE_NOT_FOUND");
    // System rules (SR-*) cannot be deleted — only enabled/disabled via PATCH.
    if (rule.accountId === "SYSTEM") {
      return err(c, 400, "System rules cannot be deleted", "SYSTEM_RULE_IMMUTABLE");
    }
    const deleteResult = await accountDb.deleteRule(accountId, rule.id);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Domains  —  /accounts/:accountId/domains
  // -------------------------------------------------------------------------

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/domains",
    tags: ["Domains"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("domains:read", c => `accounts/${c.req.param("accountId")!}/domains`)] as const,
    responses: { 200: { content: { "application/json": { schema: ListDomainsResponse } }, description: "List domains" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const domainsResult = await accountDb.listDomains(accountId);
    if (domainsResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json({ domains: domainsResult.value.map(toApiDomain) }, 200);
  });

  app.openapi(route({
    method: "post",
    path: "/accounts/{accountId}/domains",
    tags: ["Domains"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("domains:write", c => `accounts/${c.req.param("accountId")!}/domains`)] as const,
    responses: { 201: { content: { "application/json": { schema: DomainSchema } }, description: "Domain created" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const body = await zParse(CreateDomainRequest, c.req.raw);

    // Cross-account ownership check — oldest registrant wins
    const ownerResult = await accountDb.resolveAccountForDomain(body.domain);
    if (ownerResult.isErr()) return err(c, 500, "Internal Server Error");
    if (ownerResult.value && ownerResult.value !== accountId) {
      return err(c, 409, "Domain already registered by another account", "DOMAIN_EXISTS");
    }

    // Register domain with SES first (idempotent — AlreadyExistsException is ok)
    const sesResult = await domainIdentityService.register(body.domain, accountId);
    if (sesResult.isErr()) {
      logger.error("Failed to register domain SES identity", { code: "domain.ses_identity_failed", accountId, domain: body.domain, error: sesResult.error });
      return err(c, 500, "Internal Server Error");
    }

    // DB write last — once this succeeds, the domain "exists" for all readers
    const domainResult = await accountDb.createDomain(accountId, body.domain);
    if (domainResult.isErr()) return err(c, 500, "Internal Server Error");

    return c.json(toApiDomain(domainResult.value), 201);
  });

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/domains/{id}",
    tags: ["Domains"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("domains:read", c => `accounts/${c.req.param("accountId")!}/domains/${c.req.param("id")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: DomainWithRecordsSchema } }, description: "Get domain with DNS records" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const domainResult = await accountDb.getDomain(accountId, c.req.param("id")!.toLowerCase());
    if (domainResult.isErr()) return err(c, 500, "Internal Server Error");
    const domain = domainResult.value;
    if (!domain) return err(c, 404, "Domain not found", "DOMAIN_NOT_FOUND");
    const records = buildDnsRecords(domain);
    return c.json(toApiDomainWithRecords(domain, records), 200);
  });

  app.openapi(route({
    method: "patch",
    path: "/accounts/{accountId}/domains/{id}",
    tags: ["Domains"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("domains:write", c => `accounts/${c.req.param("accountId")!}/domains/${c.req.param("id")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: DomainWithRecordsSchema } }, description: "Verify/refresh domain" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const domainResult = await accountDb.getDomain(accountId, c.req.param("id")!.toLowerCase());
    if (domainResult.isErr()) return err(c, 500, "Internal Server Error");
    const domain = domainResult.value;
    if (!domain) return err(c, 404, "Domain not found", "DOMAIN_NOT_FOUND");
    const records = await checkDomain(domain);
    const now = DateTime.utc().toISO()!;
    const failingRecords = records.filter((r) => r.status === "failing").map((r) => r.name);
    const receivingHealthy = records.find((r) => r.type === "MX")?.status === "verified";
    const senderHealthy = records.filter((r) => r.type !== "MX").every((r) => r.status === "verified");
    const healthResult = await accountDb.updateDomainHealth(accountId, domain.domain, {
      receivingHealthy,
      senderHealthy,
      failingRecords,
      lastCheckedAt: now,
      ...(failingRecords.length === 0 ? { lastHealthyAt: now } : {}),
    });
    if (healthResult.isErr()) return err(c, 500, "Internal Server Error");

    // Update setup flags to reflect current DNS state
    const receivingChanged = (receivingHealthy ?? false) !== domain.receivingSetupComplete;
    const senderChanged = senderHealthy !== domain.senderSetupComplete;
    if (receivingChanged || senderChanged) {
      await accountDb.updateDomainSetup(accountId, domain.domain, {
        receivingSetupComplete: receivingHealthy ?? false,
        senderSetupComplete: senderHealthy,
      });
    }

    const updatedResult = await accountDb.getDomain(accountId, domain.domain);
    if (updatedResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(toApiDomainWithRecords(updatedResult.value!, records), 200);
  });

  app.openapi(route({
    method: "delete",
    path: "/accounts/{accountId}/domains/{id}",
    tags: ["Domains"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("domains:write", c => `accounts/${c.req.param("accountId")!}/domains/${c.req.param("id")!}`)] as const,
    responses: { 204: { description: "Domain deleted" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const domainResult = await accountDb.getDomain(accountId, c.req.param("id")!.toLowerCase());
    if (domainResult.isErr()) return err(c, 500, "Internal Server Error");
    const domain = domainResult.value;
    if (!domain) return err(c, 404, "Domain not found", "DOMAIN_NOT_FOUND");
    const deleteResult = await accountDb.deleteDomain(accountId, domain.domain);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Account  —  /accounts/:accountId
  // -------------------------------------------------------------------------

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}",
    tags: ["Accounts"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("accounts:read", c => `accounts/${c.req.param("accountId")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: AccountSchema } }, description: "Get account" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const accountResult = await accountDb.getAccount(accountId);
    if (accountResult.isErr()) return err(c, 500, "Internal Server Error");
    const account = accountResult.value;
    if (!account) return err(c, 404, "Account not found", "ACCOUNT_NOT_FOUND");
    return c.json(toApiAccount(account), 200);
  });

  app.openapi(route({
    method: "patch",
    path: "/accounts/{accountId}",
    tags: ["Accounts"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("accounts:write", c => `accounts/${c.req.param("accountId")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: AccountSchema } }, description: "Update account" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const body = await zParse(UpdateAccountRequest, c.req.raw);

    // Merge onboarding sub-object with existing to avoid overwriting fields not sent
    if (body.onboarding) {
      const existingResult = await accountDb.getAccount(accountId);
      if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
      const existing = existingResult.value;
      body.onboarding = { ...existing?.onboarding, ...body.onboarding };
    }

    const updateResult = await accountDb.updateAccount(accountId, body as Partial<Pick<Account, "name" | "retentionDuration" | "notifications" | "filtering" | "onboarding" | "afterSendAction">>);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(toApiAccount(updateResult.value), 200);
  });

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/stats",
    tags: ["Accounts"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("stats:read", c => `accounts/${c.req.param("accountId")!}/stats`)] as const,
    responses: { 200: { content: { "application/json": { schema: z.object({}) } }, description: "Get stats" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const statsResult = await accountDb.getStats(accountId);
    if (statsResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(parseStatsRow(statsResult.value), 200);
  });

  // -------------------------------------------------------------------------
  // Account users  —  /accounts/:accountId/users
  // -------------------------------------------------------------------------

  const TeamMemberSchema = z.object({
    userId: z.string(),
    role: z.string(),
    name: z.string().optional(),
    email: z.string().optional(),
    picture: z.string().optional(),
  });
  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/users",
    tags: ["Users"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("users:read", c => `accounts/${c.req.param("accountId")!}/users`)] as const,
    responses: { 200: { content: { "application/json": { schema: z.object({ users: z.array(TeamMemberSchema), pagination: PaginationSchema }) } }, description: "List users" } },
  }), async (c) => {
    if (!access) return err(c, 501, "Not implemented");
    const accountId = c.req.param("accountId")!;
    const result = await access.listUsers(accountId);
    if (result.isErr()) {
      logger.warn("Authress service unavailable while listing account users.", { code: "api.authress_unavailable", accountId, error: result.error });
      return err(c, 503, "Service temporarily unavailable");
    }
    const users = result.value;
    const profiles = await Promise.all(users.map(async (u) => {
      const profileResult = await access.getUserProfile(u.userId);
      if (profileResult.isErr()) return u;
      const { name, email, picture } = profileResult.value;
      return { ...u, ...(name ? { name } : {}), ...(email ? { email } : {}), ...(picture ? { picture } : {}) };
    }));
    return c.json(page("users", profiles), 200);
  });

  app.openapi(route({
    method: "post",
    path: "/accounts/{accountId}/users",
    tags: ["Users"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("accounts:read", c => `accounts/${c.req.param("accountId")!}`)] as const,
    responses: { 201: { description: "User invited" } },
  }), async (c) => {
    if (!access) return err(c, 501, "Not implemented");
    const accountId = c.req.param("accountId")!;
    const body = await zParse(InviteUserRequest, c.req.raw);

    if (!isValidEmail(body.email, logger)) {
      return err(c, 400, "Invalid email address", "INVALID_EMAIL");
    }

    const inviteResult = await access.createInvite(accountId, body.email, body.role);
    if (inviteResult.isErr()) {
      logger.track("Authress invite creation failed. The Authress API rejected the invite request.", {
        code: "invite.authress_creation_failed",
        accountId,
        email: body.email,
        error: inviteResult.error,
      });
      return err(c, 422, "Failed to create invite", "INVITE_CREATION_FAILED");
    }

    const { inviteId } = inviteResult.value;
    const inviteUrl = `${appBaseUrl}/invite?inviteId=${inviteId}`;

    logger.track("Team invite created. SES email sending not yet implemented — wire EmailService.send() here when ready.", {
      code: "invite.email_pending_implementation",
      accountId,
      email: body.email,
      inviteId,
      inviteUrl,
    });

    return new Response(null, { status: 201 });
  });

  app.openapi(route({
    method: "patch",
    path: "/accounts/{accountId}/users/{userId}",
    tags: ["Users"],
    request: { params: z.object({ accountId: z.string(), userId: z.string() }) },
    middleware: [authz("users:write", c => `accounts/${c.req.param("accountId")!}/users/${c.req.param("userId")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: z.object({ userId: z.string(), role: z.string() }) } }, description: "Update user role" } },
  }), async (c) => {
    if (!access) return err(c, 501, "Not implemented");
    const accountId = c.req.param("accountId")!;
    const body = await zParse(UpdateUserRequest, c.req.raw);
    const result = await access.updateUserRole(accountId, c.req.param("userId")!, body.role);
    if (result.isErr()) {
      logger.warn("Authress service unavailable while updating user role.", { code: "api.authress_unavailable", accountId, userId: c.req.param("userId")!, error: result.error });
      return err(c, 503, "Service temporarily unavailable");
    }
    return c.json({ userId: c.req.param("userId")!, role: body.role }, 200);
  });

  app.openapi(route({
    method: "delete",
    path: "/accounts/{accountId}/users/{userId}",
    tags: ["Users"],
    request: { params: z.object({ accountId: z.string(), userId: z.string() }) },
    middleware: [authz("users:write", c => `accounts/${c.req.param("accountId")!}/users/${c.req.param("userId")!}`)] as const,
    responses: { 204: { description: "User removed" } },
  }), async (c) => {
    if (!access) return err(c, 501, "Not implemented");
    const accountId = c.req.param("accountId")!;
    const result = await access.removeUser(accountId, c.req.param("userId")!);
    if (result.isErr()) {
      logger.warn("Authress service unavailable while removing user.", { code: "api.authress_unavailable", accountId, userId: c.req.param("userId")!, error: result.error });
      return err(c, 503, "Service temporarily unavailable");
    }
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Aliases  —  /accounts/:accountId/aliases
  // -------------------------------------------------------------------------

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/aliases",
    tags: ["Aliases"],
    request: {
      params: z.object({ accountId: z.string() }),
      query: z.object({ domain: z.string().optional() }),
    },
    middleware: [authz("aliases:read", c => `accounts/${c.req.param("accountId")!}/aliases`)] as const,
    responses: { 200: { content: { "application/json": { schema: ListAliasesResponse } }, description: "List aliases" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const domain = c.req.query("domain")?.toLowerCase();
    const aliasesResult = await accountDb.listAliases(accountId);
    if (aliasesResult.isErr()) return err(c, 500, "Internal Server Error");
    let aliases = aliasesResult.value;
    if (domain) aliases = aliases.filter(a => a.createdForOrigin?.includes(domain));
    return c.json({ aliases: aliases.map(toApiAlias) }, 200);
  });

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/aliases/{address}",
    tags: ["Aliases"],
    request: { params: z.object({ accountId: z.string(), address: z.string() }) },
    middleware: [authz("aliases:read", c => `accounts/${c.req.param("accountId")!}/aliases/${c.req.param("address")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: AliasSchema } }, description: "Get alias" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
    const aliasResult = await accountDb.getAlias(accountId, address);
    if (aliasResult.isErr()) return err(c, 500, "Internal Server Error");
    const alias = aliasResult.value;
    if (!alias) return err(c, 404, "Alias not found", "ALIAS_NOT_FOUND");
    return c.json(toApiAlias(alias), 200);
  });

  app.openapi(route({
    method: "post",
    path: "/accounts/{accountId}/aliases",
    tags: ["Aliases"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("aliases:write", c => `accounts/${c.req.param("accountId")!}/aliases`)] as const,
    responses: { 201: { content: { "application/json": { schema: AliasSchema } }, description: "Alias created" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const body = await zParse(CreateAliasRequest, c.req.raw);
    const aliasDomain = body.address.split("@")[1]!;
    const domainCheckResult = await accountDb.getDomain(accountId, aliasDomain);
    if (domainCheckResult.isErr()) return err(c, 500, "Internal Server Error");
    if (!domainCheckResult.value) return err(c, 422, "Domain not registered for this account", "DOMAIN_NOT_REGISTERED");
    const existingResult = await accountDb.getAlias(accountId, body.address);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    if (existingResult.value) return err(c, 409, "Alias already exists", "ALIAS_EXISTS");
    const now = DateTime.utc().toISO()!;
    const createResult = await accountDb.createAlias({
      id: body.address,
      accountId,
      address: body.address,
      domain: body.address.split("@")[1]!,
      alias: body.address.split("@")[0]!,
      unknownSenderPolicy: body.unknownSenderPolicy ?? "quarantine_visible",
      ...(body.createdForOrigin !== undefined ? { createdForOrigin: body.createdForOrigin } : {}),
      createdAt: now,
      updatedAt: now,
    });
    if (createResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(toApiAlias(createResult.value), 201);
  });

  app.openapi(route({
    method: "patch",
    path: "/accounts/{accountId}/aliases/{address}",
    tags: ["Aliases"],
    request: { params: z.object({ accountId: z.string(), address: z.string() }) },
    middleware: [authz("aliases:write", c => `accounts/${c.req.param("accountId")!}/aliases/${c.req.param("address")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: AliasSchema } }, description: "Update alias" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
    const body = await zParse(UpdateAliasRequest, c.req.raw);
    if (body.newAddress) {
      const newDomain = body.newAddress.split("@")[1]!;
      const domainCheckResult = await accountDb.getDomain(accountId, newDomain);
      if (domainCheckResult.isErr()) return err(c, 500, "Internal Server Error");
      if (!domainCheckResult.value) return err(c, 422, "Domain not registered for this account", "DOMAIN_NOT_REGISTERED");
      const renameResult = await accountDb.renameAlias(accountId, address, body.newAddress);
      if (renameResult.isErr()) {
        if (renameResult.error.kind === "not_found") return err(c, 404, "Alias not found", "ALIAS_NOT_FOUND");
        return err(c, 500, "Internal Server Error");
      }
      return c.json(toApiAlias(renameResult.value), 200);
    }
    const existingResult = await accountDb.getAlias(accountId, address);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    const existing = existingResult.value;
    const now = DateTime.utc().toISO()!;
    const upsertResult = await accountDb.upsertAlias({
      id: address,
      accountId,
      address,
      domain: address.split("@")[1]!,
      alias: address.split("@")[0]!,
      unknownSenderPolicy: body.unknownSenderPolicy ?? existing?.unknownSenderPolicy ?? "quarantine_visible",
      ...(body.spamScoreThreshold !== undefined ? { spamScoreThreshold: body.spamScoreThreshold } : existing?.spamScoreThreshold !== undefined ? { spamScoreThreshold: existing.spamScoreThreshold } : {}),
      ...(body.createdForOrigin !== undefined ? { createdForOrigin: body.createdForOrigin } : existing?.createdForOrigin !== undefined ? { createdForOrigin: existing.createdForOrigin } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    if (upsertResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(toApiAlias(upsertResult.value), 200);
  });

  app.openapi(route({
    method: "delete",
    path: "/accounts/{accountId}/aliases/{address}",
    tags: ["Aliases"],
    request: { params: z.object({ accountId: z.string(), address: z.string() }) },
    middleware: [authz("aliases:write", c => `accounts/${c.req.param("accountId")!}/aliases/${c.req.param("address")!}`)] as const,
    responses: { 204: { description: "Alias deleted" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
    const deleteResult = await accountDb.deleteAlias(accountId, address);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Alias Senders  —  /accounts/:accountId/aliases/:address/senders
  // -------------------------------------------------------------------------

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/aliases/{address}/senders",
    tags: ["Alias Senders"],
    request: { params: z.object({ accountId: z.string(), address: z.string() }) },
    middleware: [authz("aliases:read", c => `accounts/${c.req.param("accountId")!}/aliases/${c.req.param("address")!}/senders`)] as const,
    responses: { 200: { content: { "application/json": { schema: ListSendersResponse } }, description: "List senders" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
    const sendersResult = await accountDb.listSenders(accountId, address);
    if (sendersResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json({ senders: sendersResult.value.map(toApiAliasSender) }, 200);
  });

  app.openapi(route({
    method: "post",
    path: "/accounts/{accountId}/aliases/{address}/senders",
    tags: ["Alias Senders"],
    request: { params: z.object({ accountId: z.string(), address: z.string() }) },
    middleware: [authz("aliases:write", c => `accounts/${c.req.param("accountId")!}/aliases/${c.req.param("address")!}/senders`)] as const,
    responses: { 201: { content: { "application/json": { schema: AliasSenderSchema } }, description: "Sender created" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
    const body = await zParse(CreateSenderRequest, c.req.raw);
    const existingResult = await accountDb.getSender(accountId, address, body.domain);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    if (existingResult.value) {
      if (existingResult.value.policy === body.policy) {
        return c.json(toApiAliasSender(existingResult.value), 201);
      }
      return err(c, 409, "Sender already exists with a different policy", "SENDER_EXISTS");
    }
    const saveResult = await accountDb.saveSender(accountId, address, body.domain, body.policy);
    if (saveResult.isErr()) return err(c, 500, "Internal Server Error");
    const createdResult = await accountDb.getSender(accountId, address, body.domain);
    if (createdResult.isErr() || !createdResult.value) return err(c, 500, "Internal Server Error");
    return c.json(toApiAliasSender(createdResult.value), 201);
  });

  app.openapi(route({
    method: "put",
    path: "/accounts/{accountId}/aliases/{address}/senders/{domain}",
    tags: ["Alias Senders"],
    request: { params: z.object({ accountId: z.string(), address: z.string(), domain: z.string() }) },
    middleware: [authz("aliases:write", c => `accounts/${c.req.param("accountId")!}/aliases/${c.req.param("address")!}/senders/${c.req.param("domain")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: AliasSenderSchema } }, description: "Sender updated" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
    const senderDomain = decodeURIComponent(c.req.param("domain")!).toLowerCase();
    const body = await zParse(UpdateSenderRequest, c.req.raw);
    const existingResult = await accountDb.getSender(accountId, address, senderDomain);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    if (!existingResult.value) return err(c, 404, "Sender not found", "SENDER_NOT_FOUND");
    const saveResult = await accountDb.saveSender(accountId, address, senderDomain, body.policy);
    if (saveResult.isErr()) return err(c, 500, "Internal Server Error");
    const updatedResult = await accountDb.getSender(accountId, address, senderDomain);
    if (updatedResult.isErr() || !updatedResult.value) return err(c, 500, "Internal Server Error");
    return c.json(toApiAliasSender(updatedResult.value), 200);
  });

  app.openapi(route({
    method: "delete",
    path: "/accounts/{accountId}/aliases/{address}/senders/{domain}",
    tags: ["Alias Senders"],
    request: { params: z.object({ accountId: z.string(), address: z.string(), domain: z.string() }) },
    middleware: [authz("aliases:write", c => `accounts/${c.req.param("accountId")!}/aliases/${c.req.param("address")!}/senders/${c.req.param("domain")!}`)] as const,
    responses: { 204: { description: "Sender removed" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
    const senderDomain = decodeURIComponent(c.req.param("domain")!).toLowerCase();
    const removeResult = await accountDb.removeSender(accountId, address, senderDomain);
    if (removeResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Email Templates  —  /accounts/:accountId/templates
  // -------------------------------------------------------------------------

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/templates",
    tags: ["Templates"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("templates:read", c => `accounts/${c.req.param("accountId")!}/templates`)] as const,
    responses: { 200: { content: { "application/json": { schema: ListTemplatesResponse } }, description: "List templates" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const templatesResult = await accountDb.listTemplates(accountId);
    if (templatesResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json({ templates: templatesResult.value.map(toApiTemplate) }, 200);
  });

  app.openapi(route({
    method: "post",
    path: "/accounts/{accountId}/templates",
    tags: ["Templates"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("templates:write", c => `accounts/${c.req.param("accountId")!}/templates`)] as const,
    responses: { 201: { content: { "application/json": { schema: EmailTemplateSchema } }, description: "Template created" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const body = await zParse(CreateTemplateRequest, c.req.raw);
    if (body.functions) {
      if (astValidator) {
        const astResult = await astValidator.validateAstBatch(body.functions);
        if (astResult.isErr()) {
          const e = astResult.error;
          const message = e.kind === "ast_validation_error" ? e.message : e.message;
          const location = e.kind === "ast_validation_error" ? e.location : undefined;
          return err(c, 400, `Invalid code in function: ${message}`, "INVALID_CODE", location ? { location } : undefined);
        }
      }
    }
    const now = DateTime.utc().toISO()!;
    // Audit: write functions change event before persisting (best-effort)
    if (body.functions) {
      const { userId } = c.get("auth");
      const templateId = generateId("tpl-");
      const auditResult = await auditDb.saveAuditEvent({
        accountId, userId, action: "created", resourceType: "template", resourceId: templateId,
        before: null, after: { functions: body.functions },
      });
      if (auditResult.isErr()) {
        logger.warn("Audit write failed for template creation, proceeding with resource write", { code: "api.audit.template_create_failed", accountId, error: auditResult.error });
      }
      const templateResult = await accountDb.createTemplate({
        id: templateId, accountId, name: body.name, subject: body.subject, body: body.body,
        functions: body.functions,
        createdAt: now, updatedAt: now,
      });
      if (templateResult.isErr()) return err(c, 500, "Internal Server Error");
      return c.json(toApiTemplate(templateResult.value), 201);
    }
    const templateResult = await accountDb.createTemplate({
      id: generateId("tpl-"), accountId, name: body.name, subject: body.subject, body: body.body,
      createdAt: now, updatedAt: now,
    });
    if (templateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(toApiTemplate(templateResult.value), 201);
  });

  app.openapi(route({
    method: "patch",
    path: "/accounts/{accountId}/templates/{id}",
    tags: ["Templates"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("templates:write", c => `accounts/${c.req.param("accountId")!}/templates/${c.req.param("id")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: EmailTemplateSchema } }, description: "Update template" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const body = await zParse(UpdateTemplateRequest, c.req.raw);
    if (body.functions) {
      if (astValidator) {
        const astResult = await astValidator.validateAstBatch(body.functions);
        if (astResult.isErr()) {
          const e = astResult.error;
          const message = e.kind === "ast_validation_error" ? e.message : e.message;
          const location = e.kind === "ast_validation_error" ? e.location : undefined;
          return err(c, 400, `Invalid code in function: ${message}`, "INVALID_CODE", location ? { location } : undefined);
        }
      }
    }
    const existingResult = await accountDb.getTemplate(accountId, c.req.param("id")!);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    if (!existingResult.value) return err(c, 404, "Template not found", "TEMPLATE_NOT_FOUND");
    // Audit: write functions change event before persisting (best-effort)
    if (body.functions) {
      const { userId } = c.get("auth");
      const auditResult = await auditDb.saveAuditEvent({
        accountId, userId, action: "updated", resourceType: "template", resourceId: c.req.param("id")!,
        before: { functions: existingResult.value.functions ?? null },
        after: { functions: body.functions },
      });
      if (auditResult.isErr()) {
        logger.warn("Audit write failed for template update, proceeding with resource write", { code: "api.audit.template_update_failed", accountId, templateId: c.req.param("id")!, error: auditResult.error });
      }
    }
    const updateResult = await accountDb.updateTemplate(accountId, c.req.param("id")!, body as Parameters<typeof accountDb.updateTemplate>[2]);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(toApiTemplate(updateResult.value), 200);
  });

  app.openapi(route({
    method: "put",
    path: "/accounts/{accountId}/templates/{id}",
    tags: ["Templates"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("templates:write", c => `accounts/${c.req.param("accountId")!}/templates/${c.req.param("id")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: EmailTemplateSchema } }, description: "Replace template" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const body = await zParse(ReplaceTemplateRequest, c.req.raw);
    if (body.functions) {
      if (astValidator) {
        const astResult = await astValidator.validateAstBatch(body.functions);
        if (astResult.isErr()) {
          const e = astResult.error;
          const message = e.kind === "ast_validation_error" ? e.message : e.message;
          const location = e.kind === "ast_validation_error" ? e.location : undefined;
          return err(c, 400, `Invalid code in function: ${message}`, "INVALID_CODE", location ? { location } : undefined);
        }
      }
    }
    const existingResult = await accountDb.getTemplate(accountId, c.req.param("id")!);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    if (!existingResult.value) return err(c, 404, "Template not found", "TEMPLATE_NOT_FOUND");
    // Audit: write functions change event before persisting (best-effort)
    if (body.functions) {
      const { userId } = c.get("auth");
      const auditResult = await auditDb.saveAuditEvent({
        accountId, userId, action: "updated", resourceType: "template", resourceId: c.req.param("id")!,
        before: { functions: existingResult.value.functions ?? null },
        after: { functions: body.functions },
      });
      if (auditResult.isErr()) {
        logger.warn("Audit write failed for template replace, proceeding with resource write", { code: "api.audit.template_replace_failed", accountId, templateId: c.req.param("id")!, error: auditResult.error });
      }
    }
    const updateResult = await accountDb.updateTemplate(accountId, c.req.param("id")!, { name: body.name, subject: body.subject, body: body.body, ...(body.functions ? { functions: body.functions } : {}) });
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(toApiTemplate(updateResult.value), 200);
  });

  app.openapi(route({
    method: "delete",
    path: "/accounts/{accountId}/templates/{id}",
    tags: ["Templates"],
    request: { params: z.object({ accountId: z.string(), id: z.string() }) },
    middleware: [authz("templates:write", c => `accounts/${c.req.param("accountId")!}/templates/${c.req.param("id")!}`)] as const,
    responses: { 204: { description: "Template deleted" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const existingResult = await accountDb.getTemplate(accountId, c.req.param("id")!);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    if (!existingResult.value) return err(c, 404, "Template not found", "TEMPLATE_NOT_FOUND");
    const deleteResult = await accountDb.deleteTemplate(accountId, c.req.param("id")!);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });


  // -------------------------------------------------------------------------
  // Verified forwarding addresses  —  /accounts/:accountId/forwarding-addresses
  // -------------------------------------------------------------------------

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/forwarding-addresses",
    tags: ["Forwarding Addresses"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("forwarding-addresses:read", c => `accounts/${c.req.param("accountId")!}/forwarding-addresses`)] as const,
    responses: { 200: { content: { "application/json": { schema: ListForwardingAddressesResponse } }, description: "List forwarding addresses" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const addressesResult = await accountDb.listVerifiedForwardingAddresses(accountId);
    if (addressesResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json({ forwardingAddresses: addressesResult.value.map(toApiForwardingAddress) }, 200);
  });

  app.openapi(route({
    method: "post",
    path: "/accounts/{accountId}/forwarding-addresses",
    tags: ["Forwarding Addresses"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("forwarding-addresses:write", c => `accounts/${c.req.param("accountId")!}/forwarding-addresses`)] as const,
    responses: { 201: { content: { "application/json": { schema: VerifiedForwardingAddressSchema } }, description: "Forwarding address created" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const body = await zParse(CreateForwardingAddressRequest, c.req.raw);

    const existingResult = await accountDb.getVerifiedForwardingAddress(accountId, body.address);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    const existing = existingResult.value;
    if (existing?.status === "verified") return c.json(toApiForwardingAddress(existing), 201);

    const now = DateTime.utc().toISO()!;
    const addr: VerifiedForwardingAddress = {
      id: body.address,
      accountId,
      address: body.address,
      status: "pending",
      token: randomUUID(),
      createdAt: existing?.createdAt ?? now,
      ...(existing?.verifiedAt !== undefined ? { verifiedAt: existing.verifiedAt } : {}),
    };
    // SES first — send verification email before persisting the address so a
    // mailer failure never leaves a pending record the user can't re-trigger.
    if (verificationMailer) {
      const verifyResult = await verificationMailer.sendForwardVerification(accountId, addr.address, addr.token);
      if (verifyResult.isErr()) {
        logger.warn("Failed to send forwarding address verification email. The SES send call returned an error. The user won't receive the verification link.", { code: "forwarding.verification_email_failed", accountId, address: addr.address, error: verifyResult.error });
        return err(c, 422, "Failed to send verification email. Please try again.");
      }
    }

    const saveResult = await accountDb.saveVerifiedForwardingAddress(addr);
    if (saveResult.isErr()) return err(c, 500, "Internal Server Error");

    return c.json(toApiForwardingAddress(addr), 201);
  });

  app.openapi(route({
    method: "post",
    path: "/accounts/{accountId}/forwarding-addresses/{address}/verify",
    tags: ["Forwarding Addresses"],
    request: { params: z.object({ accountId: z.string(), address: z.string() }) },
    middleware: [authz("forwarding-addresses:write", c => `accounts/${c.req.param("accountId")!}/forwarding-addresses/${c.req.param("address")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: VerifiedForwardingAddressSchema } }, description: "Address verified" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
    const body = await zParse(VerifyForwardingAddressRequest, c.req.raw);

    const existingResult = await accountDb.getVerifiedForwardingAddress(accountId, address);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    const existing = existingResult.value;
    if (!existing) return err(c, 404, "Forwarding address not found", "FORWARDING_ADDRESS_NOT_FOUND");
    if (existing.status === "verified") return c.json(toApiForwardingAddress(existing), 200);
    if (existing.token !== body.token) return err(c, 400, "Invalid token", "INVALID_TOKEN");

    const verified: VerifiedForwardingAddress = { ...existing, status: "verified", verifiedAt: DateTime.utc().toISO()! };
    const saveResult = await accountDb.saveVerifiedForwardingAddress(verified);
    if (saveResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(toApiForwardingAddress(verified), 200);
  });

  app.openapi(route({
    method: "delete",
    path: "/accounts/{accountId}/forwarding-addresses/{address}",
    tags: ["Forwarding Addresses"],
    request: { params: z.object({ accountId: z.string(), address: z.string() }) },
    middleware: [authz("forwarding-addresses:write", c => `accounts/${c.req.param("accountId")!}/forwarding-addresses/${c.req.param("address")!}`)] as const,
    responses: { 204: { description: "Forwarding address deleted" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
    const deleteResult = await accountDb.deleteVerifiedForwardingAddress(accountId, address);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Audit  —  /accounts/:accountId/audit
  // -------------------------------------------------------------------------

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/audit",
    tags: ["Audit"],
    request: {
      params: z.object({ accountId: z.string() }),
      query: z.object({ cursor: z.string().optional(), limit: z.string().optional() }),
    },
    middleware: [authz("audit:read", c => `accounts/${c.req.param("accountId")!}/audit`)] as const,
    responses: { 200: { content: { "application/json": { schema: z.object({}) } }, description: "List audit events" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const cursor = c.req.query("cursor");
    const rawLimit = c.req.query("limit");
    const params: PageParams = { ...(cursor ? { cursor } : {}), ...(rawLimit ? { limit: parseInt(rawLimit, 10) } : {}) };
    const result = await auditDb.listAuditEvents(accountId, params);
    if (result.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(result.value, 200);
  });

  // ---------------------------------------------------------------------------
  // Reindex jobs (admin)
  // ---------------------------------------------------------------------------

  app.openapi(route({
    method: "post",
    path: "/reindex",
    tags: ["Admin"],
    request: {
      body: { content: { "application/json": { schema: z.object({
        targetRegistryId: z.string(),
        segmentCount: z.number().int().min(1).max(256).optional(),
      }) } } },
    },
    middleware: [authz("accounts:write", "accounts")] as const,
    responses: {
      202: { content: { "application/json": { schema: z.object({
        jobId: z.string(),
        targetRegistryId: z.string(),
        modelId: z.string(),
        segmentCount: z.number(),
        startedAt: z.string(),
      }) } }, description: "Reindex job dispatched" },
    },
  }), async (c) => {
    const body = c.req.valid("json");
    const result = await jobDispatcher.dispatch(body.targetRegistryId, body.segmentCount);
    if (result.isErr()) return err(c, 404, "Cluster not found");
    return c.json(result.value, 202);
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Validate that all forward targets in a rule's actions are verified for this account.
// Returns an error string if invalid, null if OK.
async function validateForwardTargets(
  accountId: string,
  actions: Rule["actions"],
  store: Pick<AccountDatabase, "listVerifiedForwardingAddresses">,
): Promise<string | null> {
  const forwardTargets = actions.filter((a) => a.type === "forward" && a.value).map((a) => a.value!);
  if (forwardTargets.length === 0) return null;
  const verifiedResult = await store.listVerifiedForwardingAddresses(accountId);
  if (verifiedResult.isErr()) return "Internal error validating forward targets";
  const verifiedSet = new Set(verifiedResult.value.filter((v) => v.status === "verified").map((v) => v.address));
  const unverified = forwardTargets.filter((t) => !verifiedSet.has(t));
  return unverified.length > 0 ? `Forward targets not verified: ${unverified.join(", ")}` : null;
}

// Validate webhook actions: config validity + plan feature gating.
// Returns an error object if invalid, null if OK.
function validateWebhookActions(
  actions: Rule["actions"],
  accountPlan: BillingPlan,
  billing: BillingHandler,
): { message: string; code: z.infer<typeof ErrorCode> } | null {
  const webhookActions = actions.filter((a) => a.type === "webhook");
  if (webhookActions.length === 0) return null;

  for (const action of webhookActions) {
    const configError = validateWebhookConfig(action.value);
    if (configError) return { message: configError, code: "INVALID_WEBHOOK_CONFIG" };
  }

  if (!billing.isFeatureEnabled(accountPlan, "webhook")) {
    return { message: "Webhook actions require a paid plan", code: "PLAN_FEATURE_REQUIRED" };
  }

  return null;
}

const DKIM_SELECTOR = "mail";
const MAIL_DOMAIN = process.env["MAIL_DOMAIN"] ?? "platform.email.rhosys.cloud";

// Always returns all 4 DNS records for a domain regardless of setup tier.
// The status field on each record reflects the last health check result.
function buildDnsRecords(domain: Domain): DnsRecord[] {
  const d = domain.domain;
  const failing = new Set(domain.failingRecords ?? []);
  const checked = domain.lastCheckedAt !== undefined;

  function recordStatus(name: string): DnsRecord["status"] {
    if (!checked) return "pending";
    return failing.has(name) ? "failing" : "verified";
  }

  const mxName = d;
  const dkimName = `${DKIM_SELECTOR}._domainkey.${d}`;
  const spfName = `bounce.${d}`;
  const dmarcName = `_dmarc.${d}`;

  return [
    {
      name: mxName,
      type: "MX",
      value: `10 mx.${MAIL_DOMAIN}`,
      status: recordStatus(mxName),
    },
    {
      name: dkimName,
      type: "CNAME",
      value: `${DKIM_SELECTOR}._domainkey.${MAIL_DOMAIN}`,
      status: recordStatus(dkimName),
    },
    {
      name: spfName,
      type: "CNAME",
      value: `bounce.${MAIL_DOMAIN}`,
      status: recordStatus(spfName),
    },
    {
      name: dmarcName,
      type: "CNAME",
      value: `_dmarc.${MAIL_DOMAIN}`,
      status: recordStatus(dmarcName),
    },
  ];
}
