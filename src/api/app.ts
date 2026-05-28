import { OpenAPIHono } from "@hono/zod-openapi";
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
import type { DbError, NotFoundError, AuthressServiceError, AuthError } from "../errors.js";
import type { Arc, Signal, AnySignal, Attachment, View, Label, Rule, Domain, DnsRecord, Account, Page, PageParams, ArcStatus, Workflow, WorkflowData, Alias, AliasSender, SenderPolicy, VerifiedForwardingAddress, Pagination, EmailTemplate, CalendarEventData, CalendarResponseData, DomainMisconfigurationData } from "../types/index.js";
import { isCalendarEventSignal, isEmailSignal } from "../types/index.js";
import type { UpdateArcFields, ArcDatabase } from "../database/arc-database.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";
import { deriveGroupingKey } from "../processor/processor.js";
import { zParse } from "./validate.js";
import { toApiArc, toApiSignal } from "./transform.js";
import { validateRuleCondition } from "./validate-rule-condition.js";
import { validateWebhookConfig } from "./validate-webhook-config.js";
import type { AstValidationResult } from "../isolated/ast-validator.js";
import type { UserCodeExecutorClient } from "../processor/user-code-client.js";
import type { BillingHandler } from "../billing/billing-handler.js";
import type { BillingPlan } from "../embedding/retention-tier.js";
import { parseStatsRow } from "../database/stats-writer.js";
import { isValidEmail } from "../email/validate-email.js";
import type { DraftSendDispatcher } from "../processor/draft-send-dispatcher.js";
import type { EmailService } from "../email/email-service.js";
import type { sendRsvp as SendRsvpFn } from "../processor/calendar/rsvp-composer.js";
import type { PostApprovalCalendarHandlerDeps } from "../processor/calendar/post-approval-handler.js";
import { handlePostApprovalCalendar } from "../processor/calendar/post-approval-handler.js";

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
  CreateSenderRequest, CreateTemplateRequest, ReplaceTemplateRequest, UpdateTemplateRequest,
  CreateDraftSignalRequest, ReplaceDraftSignalRequest,
  RsvpRequest,
} from "./requests.js";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthContext {
  accountId: string;
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

export interface AccessService {
  listUsers(accountId: string): Promise<Result<AccountUser[], AuthressServiceError>>;
  listAccountsForUser(userId: string): Promise<Result<string[], AuthressServiceError>>;
  addUser(accountId: string, userId: string, role: AccountRole): Promise<Result<void, AuthressServiceError>>;
  updateUserRole(accountId: string, userId: string, role: AccountRole): Promise<Result<void, AuthressServiceError>>;
  removeUser(accountId: string, userId: string): Promise<Result<void, AuthressServiceError>>;
  checkAccess(userId: string, accountId: string, permission: string): Promise<void>;
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
  sendForwardVerification(accountId: string, address: string, token: string): Promise<Result<void, DbError>>;
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

interface AppDeps {
  arcDb: ArcDatabase;
  accountDb: AccountDatabase;
  auditDb: AuditDatabase;
  auth: AuthService;
  access?: AccessService;
  logger: Logger;
  verificationMailer?: VerificationMailer;
  jobDispatcher?: JobDispatcher;
  draftSendDispatcher?: DraftSendDispatcher;
  accountCreationStarter?: { start(accountId: string, email: string): Promise<void> };
  appBaseUrl?: string;
  contentCdnBaseUrl?: string;
  astValidator?: UserCodeExecutorClient;
  billingHandler?: BillingHandler;
  emailService: EmailService;
  rsvpComposer: typeof SendRsvpFn;
  postApprovalCalendarDeps: PostApprovalCalendarHandlerDeps;
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

export function createApp({ arcDb, accountDb, auditDb, auth, access, logger, verificationMailer, jobDispatcher, draftSendDispatcher, accountCreationStarter, appBaseUrl, contentCdnBaseUrl, astValidator, billingHandler, emailService, rsvpComposer, postApprovalCalendarDeps }: AppDeps) {
  const app = new OpenAPIHono<AppEnv>();

  // Helper: validate code AST via the isolated Lambda
  async function validateCodeAst(code: string): Promise<AstValidationResult> {
    if (!astValidator) {
      // Fallback should never happen in production — fail closed
      return { valid: false, error: "AST validator not configured" };
    }
    const response = await astValidator.validateAst(code);
    if (!response.success) {
      return { valid: false, error: response.error.message };
    }
    return response.result;
  }

  // Helper: validate multiple template functions in a single Lambda invocation
  async function validateFunctionsAst(functions: Array<{ name: string; code: string }>): Promise<{ valid: true } | { valid: false; name: string; error: string; location?: { line: number; column: number } }> {
    if (!astValidator) {
      return { valid: false, name: functions[0]?.name ?? "", error: "AST validator not configured" };
    }
    const response = await astValidator.validateAstBatch(functions);
    if (!response.success) {
      return { valid: false, name: functions[0]?.name ?? "", error: response.error.message };
    }
    const failed = response.results.find(r => !r.valid);
    if (failed && !failed.valid) {
      return { valid: false, name: failed.name, error: failed.error, ...(failed.location ? { location: failed.location } : {}) };
    }
    return { valid: true };
  }

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

  // Attach x-request-id to every response
  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("x-request-id", logger.getInvocationId());
  });

  function err(c: Context<AppEnv>, status: number, title: string, errorCode?: string, details?: unknown) {
    return c.json(
      { title, ...(errorCode ? { errorCode } : {}), ...(details !== undefined ? { details } : {}), errorId: logger.getInvocationId() },
      status as 400 | 401 | 403 | 404 | 409 | 501,
    );
  }

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

    // Extract accountId from URL path for account-scoped routes
    const accountMatch = /\/accounts\/([^/]+)/.exec(c.req.path);
    c.set("auth", { accountId: accountMatch?.[1] ?? "", userId });

    await next();
  });

  // Authorization guard — safety net for forgotten authorize() calls on account-scoped routes
  app.use("/accounts/:accountId/*", authorizationGuard());

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

  // -------------------------------------------------------------------------
  // Accounts  —  /accounts
  // -------------------------------------------------------------------------

  app.get("/accounts", async (c) => {
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

    return c.json({ accounts });
  });

  app.post("/accounts", async (c) => {
    const { userId } = c.get("auth");
    if (!access) return err(c, 501, "Not implemented");

    // Check if user already has an account via Authress
    const existingResult = await access.listAccountsForUser(userId);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    if (existingResult.value.length > 0) return err(c, 409, "Account already exists", "ACCOUNT_EXISTS");

    // Generate a unique account ID — cycle until DynamoDB conditional put succeeds
    const now = DateTime.utc().toISO()!;
    let account: Account | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate: Account = {
        id: generateAccountId(),
        name: "",
        deletionRetentionDays: 0,
        billingPlan: "Trial",
        onboarding: { completed: false },
        createdAt: now,
        updatedAt: now,
      };
      const createResult = await accountDb.createAccount(candidate);
      if (createResult.isOk()) {
        account = candidate;
        break;
      }
      // ConditionalCheckFailedException means ID collision — retry with a new ID
    }
    if (!account) return err(c, 500, "Internal Server Error");

    // Grant admin role in Authress
    const accessResult = await access.addUser(account.id, userId, "admin");
    if (accessResult.isErr()) {
      logger.error("Failed to create Authress access record for new account. The account exists in DynamoDB but the user won't have permissions until this is resolved.", { code: "api.account_create.authress_failed", userId, accountId: account.id, error: accessResult.error });
    }

    // Start onboarding Step Function (fire-and-forget — errors are swallowed internally)
    if (accountCreationStarter) {
      await accountCreationStarter.start(account.id, userId);
    }

    return c.json(account, 201);
  });

  // -------------------------------------------------------------------------
  // Arcs  —  /accounts/:accountId/arcs
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/arcs", authz("arcs:read", c => `accounts/${c.req.param("accountId")}/arcs`), async (c) => {
    const { accountId } = c.get("auth");
    const query = c.req.query();
    const q = query["q"];
    if (q) {
      const params: PageParams = {
        ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
        ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
      };
      const result = await arcDb.searchArcs(accountId, q, params);
      if (result.isErr()) return err(c, 500, "Internal Server Error");
      return c.json(page("arcs", result.value.items.map(toApiArc), result.value.nextCursor));
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
    return c.json(page("arcs", result.value.items.map(toApiArc), result.value.nextCursor));
  });

  app.get("/accounts/:accountId/arcs/:id", authz("arcs:read", c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const arcResult = await arcDb.getArc(accountId, c.req.param("id"));
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    if (arc.accountId !== accountId) return err(c, 403, "Forbidden");
    return c.json(arc);
  });

  app.patch("/accounts/:accountId/arcs/:id", authz("arcs:write", c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const arcResult = await arcDb.getArc(accountId, c.req.param("id"));
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    if (arc.accountId !== accountId) return err(c, 403, "Forbidden");
    const body = await zParse(UpdateArcRequest, c.req.raw);

    // violate_report: block the sender domain and delete the arc
    if (body.status === "violate_report") {
      const signalsResult = await arcDb.listSignals(accountId, arc.id, { limit: 1 });
      if (signalsResult.isErr()) return err(c, 500, "Internal Server Error");
      const signal = signalsResult.value.items[0];
      if (signal) {
        const senderDomain = signal.data.from.address.includes("@") ? signal.data.from.address.split("@").pop()! : signal.data.from.address;
        const senderETLD1 = getDomain(senderDomain) ?? senderDomain;
        const saveSenderResult = await accountDb.saveSender(accountId, signal.data.recipientAddress, senderETLD1, "violate_report");
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
      return c.json(updateResult.value);
    }

    const fields: UpdateArcFields = {};
    if (body.urgency !== undefined) fields.urgency = body.urgency;
    if (body.labels !== undefined) fields.labels = body.labels;
    const status = body.status ?? arc.status;
    const lastSignalAt = body.lastSignalAt ?? arc.lastSignalAt;
    const updateResult = await arcDb.updateArc(accountId, arc.id, status, lastSignalAt, fields);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(updateResult.value);
  });

  // -------------------------------------------------------------------------
  // Signals  —  /accounts/:accountId/arcs/:arcId/signals  &  /signals/:id
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/arcs/:arcId/signals", authz("signals:read", c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("arcId")}/signals`), async (c) => {
    const { accountId } = c.get("auth");
    const arcResult = await arcDb.getArc(accountId, c.req.param("arcId"));
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    if (arc.accountId !== accountId) return err(c, 403, "Forbidden");
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

    return c.json(page("signals", enrichedSignals, result.value.nextCursor));
  });

  app.post("/accounts/:accountId/arcs/:arcId/signals", authz("signals:write", c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("arcId")}/signals`), async (c) => {
    const { accountId } = c.get("auth");
    const arcResult = await arcDb.getArc(accountId, c.req.param("arcId"));
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    if (arc.accountId !== accountId) return err(c, 403, "Forbidden");
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
    return c.json(createResult.value, 201);
  });

  app.put("/accounts/:accountId/arcs/:arcId/signals/:id", authz("signals:write", c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("arcId")}/signals/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const arcResult = await arcDb.getArc(accountId, c.req.param("arcId"));
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    if (arc.accountId !== accountId) return err(c, 403, "Forbidden");
    const signalResult = await arcDb.getSignalById(accountId, c.req.param("id"), c.req.param("arcId"));
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
    return c.json(updateResult.value);
  });

  app.get("/accounts/:accountId/signals", authz("signals:read", c => `accounts/${c.req.param("accountId")}/signals`), async (c) => {
    const { accountId } = c.get("auth");
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
    return c.json(page("signals", itemsWithUrls, result.value.nextCursor));
  });

  app.post("/accounts/:accountId/signals/:id/quarantineResponse", authz("signals:write", c => `accounts/${c.req.param("accountId")}/signals/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const signalResult = await arcDb.getSignalById(accountId, c.req.param("id"));
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.accountId !== accountId) return err(c, 403, "Forbidden");
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
        const saveSenderResult = await accountDb.saveSender(accountId, signal.data.recipientAddress, senderETLD1, body.status);
        if (saveSenderResult.isErr()) return err(c, 500, "Internal Server Error");
      }

      return c.json(blockResult.value);
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
    return c.json({ arc, signal: { ...signalWithUrls, status: "active", arcId: arc.id } });
  });

  app.get("/accounts/:accountId/signals/:id", authz("signals:read", c => `accounts/${c.req.param("accountId")}/signals/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const signalResult = await arcDb.getSignalById(accountId, c.req.param("id"));
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.accountId !== accountId) return err(c, 403, "Forbidden");
    return c.json(contentCdnBaseUrl ? withAttachmentUrls(signal, contentCdnBaseUrl) : signal);
  });

  app.patch("/accounts/:accountId/signals/:id", authz("signals:write", c => `accounts/${c.req.param("accountId")}/signals/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const signalResult = await arcDb.getSignalById(accountId, c.req.param("id"));
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.accountId !== accountId) return err(c, 403, "Forbidden");
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
      return c.json(updateResult.value);
    }

    // Normal draft edit (subject, textBody, from, to)
    const updateResult = await arcDb.updateSignal(accountId, signal.signalLookupId, body as Parameters<typeof arcDb.updateSignal>[2]);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(updateResult.value);
  });

  app.post("/accounts/:accountId/arcs/:arcId/signals/:id/send", authz("signals:write", c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("arcId")}/signals/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");

    // Arc validation
    const arcResult = await arcDb.getArc(accountId, c.req.param("arcId"));
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    if (arc.accountId !== accountId) return err(c, 403, "Forbidden");

    // Signal validation
    const signalResult = await arcDb.getSignalById(accountId, c.req.param("id"), c.req.param("arcId"));
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.accountId !== accountId) return err(c, 403, "Forbidden");
    if (signal.arcId !== arc.id) return err(c, 400, "Signal does not belong to this arc", "SIGNAL_ARC_MISMATCH");
    if (signal.status !== "draft") return err(c, 400, "Only draft signals can be sent", "SIGNAL_NOT_DRAFT");

    // MX validation
    const mxResult = await validateRecipientMx(signal.data.to);
    if (!mxResult.valid) {
      return c.json({ title: "Invalid recipient domain", errorCode: "INVALID_RECIPIENT_DOMAIN", details: { invalidDomains: mxResult.invalidDomains } }, 422);
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

    return c.json({ ...updateResult.value, undoWindowSeconds, undoExpiresAt });
  });

  app.delete("/accounts/:accountId/signals/:id", authz("signals:write", c => `accounts/${c.req.param("accountId")}/signals/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const signalResult = await arcDb.getSignalById(accountId, c.req.param("id"));
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.accountId !== accountId) return err(c, 403, "Forbidden");
    if (signal.status === "sent") return err(c, 400, "Signal already sent", "SIGNAL_ALREADY_SENT");
    if (signal.status !== "draft") return err(c, 400, "Only draft signals can be deleted", "SIGNAL_NOT_DRAFT");
    const deleteResult = await arcDb.deleteSignal(accountId, signal.signalLookupId);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Calendar RSVP  —  /accounts/:accountId/arcs/:arcId/signals/:id/rsvp
  // -------------------------------------------------------------------------

  app.post("/accounts/:accountId/arcs/:arcId/signals/:id/rsvp", authz("signals:write", c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("arcId")}/signals/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    if (!emailService || !rsvpComposer) return err(c, 501, "RSVP not configured");

    // Validate arc
    const arcResult = await arcDb.getArc(accountId, c.req.param("arcId"));
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    if (arc.accountId !== accountId) return err(c, 403, "Forbidden");

    // Validate signal — must be a calendar_event signal
    const signalResult = await arcDb.getSignalById(accountId, c.req.param("id"), c.req.param("arcId"));
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
      return c.json({ title: "Domain misconfiguration", errorCode: "DOMAIN_MISCONFIGURATION", details: { domain: aliasDomain, reason: "DKIM + SPF not configured for alias domain" } }, 422);
    }

    // Send-first: call RSVP_Composer
    const rsvpResult = await rsvpComposer(
      {
        decision: body.decision,
        originalCalendarData: calendarData,
        aliasAddress: recipientAddress,
        organizerAddress: calendarData.organizer,
        fromAddress: recipientAddress,
      },
      { emailService },
    );

    // On send failure: return error, do NOT create signal (Property 13)
    if (rsvpResult.isErr()) {
      return c.json({ title: "Failed to send RSVP", errorCode: "RSVP_SEND_FAILED" }, 502);
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

    return c.json(responseSignal);
  });

  // -------------------------------------------------------------------------
  // Views  —  /accounts/:accountId/views
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/views", authz("views:read", c => `accounts/${c.req.param("accountId")}/views`), async (c) => {
    const { accountId } = c.get("auth");
    const viewsResult = await accountDb.listViews(accountId);
    if (viewsResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(page("views", viewsResult.value));
  });

  app.post("/accounts/:accountId/views", authz("views:write", c => `accounts/${c.req.param("accountId")}/views`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreateViewRequest, c.req.raw);
    const viewResult = await accountDb.createView(accountId, body);
    if (viewResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(viewResult.value, 201);
  });

  app.patch("/accounts/:accountId/views/:id", authz("views:write", c => `accounts/${c.req.param("accountId")}/views/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const viewResult = await accountDb.getView(accountId, c.req.param("id"));
    if (viewResult.isErr()) return err(c, 500, "Internal Server Error");
    const view = viewResult.value;
    if (!view) return err(c, 404, "View not found", "VIEW_NOT_FOUND");
    const body = await zParse(UpdateViewRequest, c.req.raw);
    const updateResult = await accountDb.updateView(accountId, view.id, body);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(updateResult.value);
  });

  app.delete("/accounts/:accountId/views/:id", authz("views:write", c => `accounts/${c.req.param("accountId")}/views/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const viewResult = await accountDb.getView(accountId, c.req.param("id"));
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

  app.get("/accounts/:accountId/labels", authz("labels:read", c => `accounts/${c.req.param("accountId")}/labels`), async (c) => {
    const { accountId } = c.get("auth");
    const labelsResult = await accountDb.listLabels(accountId);
    if (labelsResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(page("labels", labelsResult.value));
  });

  app.post("/accounts/:accountId/labels", authz("labels:write", c => `accounts/${c.req.param("accountId")}/labels`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreateLabelRequest, c.req.raw);
    const labelResult = await accountDb.createLabel(accountId, body);
    if (labelResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(labelResult.value, 201);
  });

  app.patch("/accounts/:accountId/labels/:id", authz("labels:write", c => `accounts/${c.req.param("accountId")}/labels/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const labelsResult = await accountDb.listLabels(accountId);
    if (labelsResult.isErr()) return err(c, 500, "Internal Server Error");
    const label = labelsResult.value.find((l) => l.id === c.req.param("id"));
    if (!label) return err(c, 404, "Label not found", "LABEL_NOT_FOUND");
    const body = await zParse(UpdateLabelRequest, c.req.raw);
    const updateResult = await accountDb.updateLabel(accountId, label.id, body);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(updateResult.value);
  });

  app.delete("/accounts/:accountId/labels/:id", authz("labels:write", c => `accounts/${c.req.param("accountId")}/labels/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const labelsResult = await accountDb.listLabels(accountId);
    if (labelsResult.isErr()) return err(c, 500, "Internal Server Error");
    const label = labelsResult.value.find((l) => l.id === c.req.param("id"));
    if (!label) return err(c, 404, "Label not found", "LABEL_NOT_FOUND");
    const deleteResult = await accountDb.deleteLabel(accountId, label.id);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Rules  —  /accounts/:accountId/rules
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/rules", authz("rules:read", c => `accounts/${c.req.param("accountId")}/rules`), async (c) => {
    const { accountId } = c.get("auth");
    const rulesResult = await accountDb.listRules(accountId);
    if (rulesResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(page("rules", rulesResult.value));
  });

  app.post("/accounts/:accountId/rules", authz("rules:write", c => `accounts/${c.req.param("accountId")}/rules`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreateRuleRequest, c.req.raw);
    const effectiveConditionType = body.conditionType ?? "json_logic";
    if (effectiveConditionType === "js") {
      if (!body.condition || body.condition.trim().length === 0) {
        return err(c, 400, "condition field is required when conditionType is 'js'", "MISSING_CODE");
      }
      const astResult = await validateCodeAst(body.condition);
      if (!astResult.valid) {
        return err(c, 400, astResult.error, "INVALID_CODE", astResult.location ? { location: astResult.location } : undefined);
      }
    } else {
      if (body.condition) {
        const conditionError = validateRuleCondition(body.condition);
        if (conditionError) return err(c, 400, conditionError, "INVALID_CONDITION");
      }
    }
    const forwardError = await validateForwardTargets(accountId, body.actions as Rule["actions"], accountDb);
    if (forwardError) return err(c, 400, forwardError, "UNVERIFIED_FORWARD_TARGET");
    if (billingHandler) {
      const accountResult = await accountDb.getAccount(accountId);
      const accountPlan: BillingPlan = (accountResult.isOk() && accountResult.value?.billingPlan) || "Free";
      const webhookError = validateWebhookActions(body.actions as Rule["actions"], accountPlan, billingHandler);
      if (webhookError) return err(c, 400, webhookError.message, webhookError.code);
    }
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
    return c.json(ruleResult.value, 201);
  });

  app.patch("/accounts/:accountId/rules/:id", authz("rules:write", c => `accounts/${c.req.param("accountId")}/rules/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const rulesResult = await accountDb.listRules(accountId);
    if (rulesResult.isErr()) return err(c, 500, "Internal Server Error");
    const rule = rulesResult.value.find((r) => r.id === c.req.param("id"));
    if (!rule) return err(c, 404, "Rule not found", "RULE_NOT_FOUND");
    const body = await zParse(UpdateRuleRequest, c.req.raw);
    const effectiveConditionType = body.conditionType ?? rule.conditionType ?? "json_logic";
    if (effectiveConditionType === "js") {
      // If condition is being provided, validate it as JS
      if (body.condition !== undefined) {
        if (!body.condition || body.condition.trim().length === 0) {
          return err(c, 400, "condition field is required when conditionType is 'js'", "MISSING_CODE");
        }
        const astResult = await validateCodeAst(body.condition);
        if (!astResult.valid) {
          return err(c, 400, astResult.error, "INVALID_CODE", astResult.location ? { location: astResult.location } : undefined);
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
      if (billingHandler) {
        const accountResult = await accountDb.getAccount(accountId);
        const accountPlan: BillingPlan = (accountResult.isOk() && accountResult.value?.billingPlan) || "Free";
        const webhookError = validateWebhookActions(body.actions as Rule["actions"], accountPlan, billingHandler);
        if (webhookError) return err(c, 400, webhookError.message, webhookError.code);
      }
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
    return c.json(updateResult.value);
  });

  app.delete("/accounts/:accountId/rules/:id", authz("rules:write", c => `accounts/${c.req.param("accountId")}/rules/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const rulesResult = await accountDb.listRules(accountId);
    if (rulesResult.isErr()) return err(c, 500, "Internal Server Error");
    const rule = rulesResult.value.find((r) => r.id === c.req.param("id"));
    if (!rule) return err(c, 404, "Rule not found", "RULE_NOT_FOUND");
    const deleteResult = await accountDb.deleteRule(accountId, rule.id);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Domains  —  /accounts/:accountId/domains
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/domains", authz("domains:read", c => `accounts/${c.req.param("accountId")}/domains`), async (c) => {
    const { accountId } = c.get("auth");
    const domainsResult = await accountDb.listDomains(accountId);
    if (domainsResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(page("domains", domainsResult.value));
  });

  app.post("/accounts/:accountId/domains", authz("domains:write", c => `accounts/${c.req.param("accountId")}/domains`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreateDomainRequest, c.req.raw);
    const domainResult = await accountDb.createDomain(accountId, body.domain);
    if (domainResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(domainResult.value, 201);
  });

  app.get("/accounts/:accountId/domains/:id", authz("domains:read", c => `accounts/${c.req.param("accountId")}/domains/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const domainResult = await accountDb.getDomain(accountId, c.req.param("id"));
    if (domainResult.isErr()) return err(c, 500, "Internal Server Error");
    const domain = domainResult.value;
    if (!domain) return err(c, 404, "Domain not found", "DOMAIN_NOT_FOUND");
    if (domain.accountId !== accountId) return err(c, 403, "Forbidden");
    const records = buildDnsRecords(domain);
    return c.json({ ...domain, records });
  });

  app.patch("/accounts/:accountId/domains/:id", authz("domains:write", c => `accounts/${c.req.param("accountId")}/domains/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const domainResult = await accountDb.getDomain(accountId, c.req.param("id"));
    if (domainResult.isErr()) return err(c, 500, "Internal Server Error");
    const domain = domainResult.value;
    if (!domain) return err(c, 404, "Domain not found", "DOMAIN_NOT_FOUND");
    if (domain.accountId !== accountId) return err(c, 403, "Forbidden");
    const records = await checkDomain(domain);
    const now = DateTime.utc().toISO()!;
    const failingRecords = records.filter((r) => r.status === "failing").map((r) => r.name);
    const receivingHealthy = records.find((r) => r.type === "MX")?.status === "verified";
    const senderHealthy = records.filter((r) => r.type !== "MX").every((r) => r.status === "verified");
    const healthResult = await accountDb.updateDomainHealth(accountId, domain.id, {
      receivingHealthy,
      senderHealthy,
      failingRecords,
      lastCheckedAt: now,
      ...(failingRecords.length === 0 ? { lastHealthyAt: now } : {}),
    });
    if (healthResult.isErr()) return err(c, 500, "Internal Server Error");
    const updatedResult = await accountDb.getDomain(accountId, domain.id);
    if (updatedResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json({ ...updatedResult.value, records });
  });

  app.delete("/accounts/:accountId/domains/:id", authz("domains:write", c => `accounts/${c.req.param("accountId")}/domains/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const domainResult = await accountDb.getDomain(accountId, c.req.param("id"));
    if (domainResult.isErr()) return err(c, 500, "Internal Server Error");
    const domain = domainResult.value;
    if (!domain) return err(c, 404, "Domain not found", "DOMAIN_NOT_FOUND");
    if (domain.accountId !== accountId) return err(c, 403, "Forbidden");
    const deleteResult = await accountDb.deleteDomain(accountId, domain.id);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Account  —  /accounts/:accountId
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId", authz("accounts:read", c => `accounts/${c.req.param("accountId")}`), async (c) => {
    const { accountId } = c.get("auth");
    const accountResult = await accountDb.getAccount(accountId);
    if (accountResult.isErr()) return err(c, 500, "Internal Server Error");
    const account = accountResult.value;
    if (!account) return err(c, 404, "Account not found", "ACCOUNT_NOT_FOUND");
    return c.json(account);
  });

  app.patch("/accounts/:accountId", authz("accounts:write", c => `accounts/${c.req.param("accountId")}`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(UpdateAccountRequest, c.req.raw);
    const updateResult = await accountDb.updateAccount(accountId, body as Partial<Pick<Account, "name" | "deletionRetentionDays" | "notifications" | "filtering" | "onboarding" | "afterSendAction">>);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(updateResult.value);
  });

  app.get("/accounts/:accountId/stats", authz("stats:read", c => `accounts/${c.req.param("accountId")}/stats`), async (c) => {
    const { accountId } = c.get("auth");
    const statsResult = await accountDb.getStats(accountId);
    if (statsResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(parseStatsRow(statsResult.value));
  });

  // -------------------------------------------------------------------------
  // Account users  —  /accounts/:accountId/users
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/users", authz("users:read", c => `accounts/${c.req.param("accountId")}/users`), async (c) => {
    if (!access) return err(c, 501, "Not implemented");
    const { accountId } = c.get("auth");
    const result = await access.listUsers(accountId);
    if (result.isErr()) {
      logger.warn("Authress service unavailable while listing account users.", { code: "api.authress_unavailable", accountId, error: result.error });
      return err(c, 503, "Service temporarily unavailable");
    }
    return c.json(page("users", result.value));
  });

  app.post("/accounts/:accountId/users", authz("accounts:read", c => `accounts/${c.req.param("accountId")}`), async (c) => {
    if (!access) return err(c, 501, "Not implemented");
    const { accountId } = c.get("auth");
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

  app.patch("/accounts/:accountId/users/:userId", authz("users:write", c => `accounts/${c.req.param("accountId")}/users/${c.req.param("userId")}`), async (c) => {
    if (!access) return err(c, 501, "Not implemented");
    const { accountId } = c.get("auth");
    const body = await zParse(UpdateUserRequest, c.req.raw);
    const result = await access.updateUserRole(accountId, c.req.param("userId"), body.role);
    if (result.isErr()) {
      logger.warn("Authress service unavailable while updating user role.", { code: "api.authress_unavailable", accountId, userId: c.req.param("userId"), error: result.error });
      return err(c, 503, "Service temporarily unavailable");
    }
    return c.json({ userId: c.req.param("userId"), role: body.role });
  });

  app.delete("/accounts/:accountId/users/:userId", authz("users:write", c => `accounts/${c.req.param("accountId")}/users/${c.req.param("userId")}`), async (c) => {
    if (!access) return err(c, 501, "Not implemented");
    const { accountId } = c.get("auth");
    const result = await access.removeUser(accountId, c.req.param("userId"));
    if (result.isErr()) {
      logger.warn("Authress service unavailable while removing user.", { code: "api.authress_unavailable", accountId, userId: c.req.param("userId"), error: result.error });
      return err(c, 503, "Service temporarily unavailable");
    }
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Aliases  —  /accounts/:accountId/aliases
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/aliases", authz("aliases:read", c => `accounts/${c.req.param("accountId")}/aliases`), async (c) => {
    const { accountId } = c.get("auth");
    const domain = c.req.query("domain");
    const aliasesResult = await accountDb.listAliases(accountId);
    if (aliasesResult.isErr()) return err(c, 500, "Internal Server Error");
    let aliases = aliasesResult.value;
    if (domain) aliases = aliases.filter(a => a.createdForOrigin?.includes(domain));
    return c.json(page("aliases", aliases));
  });

  app.get("/accounts/:accountId/aliases/:address", authz("aliases:read", c => `accounts/${c.req.param("accountId")}/aliases/${c.req.param("address")}`), async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const aliasResult = await accountDb.getAlias(accountId, address);
    if (aliasResult.isErr()) return err(c, 500, "Internal Server Error");
    const alias = aliasResult.value;
    if (!alias) return err(c, 404, "Alias not found", "ALIAS_NOT_FOUND");
    return c.json(alias);
  });

  app.post("/accounts/:accountId/aliases", authz("aliases:write", c => `accounts/${c.req.param("accountId")}/aliases`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreateAliasRequest, c.req.raw);
    const existingResult = await accountDb.getAlias(accountId, body.address);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    if (existingResult.value) return err(c, 409, "Alias already exists", "ALIAS_EXISTS");
    const now = DateTime.utc().toISO()!;
    const createResult = await accountDb.createAlias({
      id: body.address,
      accountId,
      address: body.address,
      unknownSenderPolicy: body.unknownSenderPolicy ?? "quarantine_visible",
      ...(body.createdForOrigin !== undefined ? { createdForOrigin: body.createdForOrigin } : {}),
      createdAt: now,
      updatedAt: now,
    });
    if (createResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(createResult.value, 201);
  });

  app.patch("/accounts/:accountId/aliases/:address", authz("aliases:write", c => `accounts/${c.req.param("accountId")}/aliases/${c.req.param("address")}`), async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const body = await zParse(UpdateAliasRequest, c.req.raw);
    if (body.newAddress) {
      const renameResult = await accountDb.renameAlias(accountId, address, body.newAddress);
      if (renameResult.isErr()) {
        if (renameResult.error.kind === "not_found") return err(c, 404, "Alias not found", "ALIAS_NOT_FOUND");
        return err(c, 500, "Internal Server Error");
      }
      return c.json(renameResult.value);
    }
    const existingResult = await accountDb.getAlias(accountId, address);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    const existing = existingResult.value;
    const now = DateTime.utc().toISO()!;
    const upsertResult = await accountDb.upsertAlias({
      id: address,
      accountId,
      address,
      unknownSenderPolicy: body.unknownSenderPolicy ?? existing?.unknownSenderPolicy ?? "quarantine_visible",
      ...(body.spamScoreThreshold !== undefined ? { spamScoreThreshold: body.spamScoreThreshold } : existing?.spamScoreThreshold !== undefined ? { spamScoreThreshold: existing.spamScoreThreshold } : {}),
      ...(body.createdForOrigin !== undefined ? { createdForOrigin: body.createdForOrigin } : existing?.createdForOrigin !== undefined ? { createdForOrigin: existing.createdForOrigin } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    if (upsertResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(upsertResult.value);
  });

  app.delete("/accounts/:accountId/aliases/:address", authz("aliases:write", c => `accounts/${c.req.param("accountId")}/aliases/${c.req.param("address")}`), async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const deleteResult = await accountDb.deleteAlias(accountId, address);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Alias Senders  —  /accounts/:accountId/aliases/:address/senders
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/aliases/:address/senders", authz("aliases:read", c => `accounts/${c.req.param("accountId")}/aliases/${c.req.param("address")}/senders`), async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const sendersResult = await accountDb.listSenders(accountId, address);
    if (sendersResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json({ senders: sendersResult.value });
  });

  app.post("/accounts/:accountId/aliases/:address/senders", authz("aliases:write", c => `accounts/${c.req.param("accountId")}/aliases/${c.req.param("address")}/senders`), async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const body = await zParse(CreateSenderRequest, c.req.raw);
    const saveResult = await accountDb.saveSender(accountId, address, body.domain, body.policy);
    if (saveResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 201 });
  });

  app.delete("/accounts/:accountId/aliases/:address/senders/:domain", authz("aliases:write", c => `accounts/${c.req.param("accountId")}/aliases/${c.req.param("address")}/senders/${c.req.param("domain")}`), async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const domain = decodeURIComponent(c.req.param("domain"));
    const removeResult = await accountDb.removeSender(accountId, address, domain);
    if (removeResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Email Templates  —  /accounts/:accountId/templates
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/templates", authz("templates:read", c => `accounts/${c.req.param("accountId")}/templates`), async (c) => {
    const { accountId } = c.get("auth");
    const templatesResult = await accountDb.listTemplates(accountId);
    if (templatesResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json({ templates: templatesResult.value });
  });

  app.post("/accounts/:accountId/templates", authz("templates:write", c => `accounts/${c.req.param("accountId")}/templates`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreateTemplateRequest, c.req.raw);
    if (body.functions) {
      const astResult = await validateFunctionsAst(body.functions);
      if (!astResult.valid) {
        return err(c, 400, `Invalid code in function '${astResult.name}': ${astResult.error}`, "INVALID_CODE", astResult.location ? { location: astResult.location } : undefined);
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
      return c.json(templateResult.value, 201);
    }
    const templateResult = await accountDb.createTemplate({
      id: generateId("tpl-"), accountId, name: body.name, subject: body.subject, body: body.body,
      createdAt: now, updatedAt: now,
    });
    if (templateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(templateResult.value, 201);
  });

  app.patch("/accounts/:accountId/templates/:id", authz("templates:write", c => `accounts/${c.req.param("accountId")}/templates/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(UpdateTemplateRequest, c.req.raw);
    if (body.functions) {
      const astResult = await validateFunctionsAst(body.functions);
      if (!astResult.valid) {
        return err(c, 400, `Invalid code in function '${astResult.name}': ${astResult.error}`, "INVALID_CODE", astResult.location ? { location: astResult.location } : undefined);
      }
    }
    const existingResult = await accountDb.getTemplate(accountId, c.req.param("id"));
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    if (!existingResult.value) return err(c, 404, "Template not found", "TEMPLATE_NOT_FOUND");
    // Audit: write functions change event before persisting (best-effort)
    if (body.functions) {
      const { userId } = c.get("auth");
      const auditResult = await auditDb.saveAuditEvent({
        accountId, userId, action: "updated", resourceType: "template", resourceId: c.req.param("id"),
        before: { functions: existingResult.value.functions ?? null },
        after: { functions: body.functions },
      });
      if (auditResult.isErr()) {
        logger.warn("Audit write failed for template update, proceeding with resource write", { code: "api.audit.template_update_failed", accountId, templateId: c.req.param("id"), error: auditResult.error });
      }
    }
    const updateResult = await accountDb.updateTemplate(accountId, c.req.param("id"), body as Parameters<typeof accountDb.updateTemplate>[2]);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(updateResult.value);
  });

  app.put("/accounts/:accountId/templates/:id", authz("templates:write", c => `accounts/${c.req.param("accountId")}/templates/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(ReplaceTemplateRequest, c.req.raw);
    if (body.functions) {
      const astResult = await validateFunctionsAst(body.functions);
      if (!astResult.valid) {
        return err(c, 400, `Invalid code in function '${astResult.name}': ${astResult.error}`, "INVALID_CODE", astResult.location ? { location: astResult.location } : undefined);
      }
    }
    const existingResult = await accountDb.getTemplate(accountId, c.req.param("id"));
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    if (!existingResult.value) return err(c, 404, "Template not found", "TEMPLATE_NOT_FOUND");
    // Audit: write functions change event before persisting (best-effort)
    if (body.functions) {
      const { userId } = c.get("auth");
      const auditResult = await auditDb.saveAuditEvent({
        accountId, userId, action: "updated", resourceType: "template", resourceId: c.req.param("id"),
        before: { functions: existingResult.value.functions ?? null },
        after: { functions: body.functions },
      });
      if (auditResult.isErr()) {
        logger.warn("Audit write failed for template replace, proceeding with resource write", { code: "api.audit.template_replace_failed", accountId, templateId: c.req.param("id"), error: auditResult.error });
      }
    }
    const updateResult = await accountDb.updateTemplate(accountId, c.req.param("id"), { name: body.name, subject: body.subject, body: body.body, ...(body.functions ? { functions: body.functions } : {}) });
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(updateResult.value);
  });

  app.delete("/accounts/:accountId/templates/:id", authz("templates:write", c => `accounts/${c.req.param("accountId")}/templates/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const existingResult = await accountDb.getTemplate(accountId, c.req.param("id"));
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    if (!existingResult.value) return err(c, 404, "Template not found", "TEMPLATE_NOT_FOUND");
    const deleteResult = await accountDb.deleteTemplate(accountId, c.req.param("id"));
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });


  // -------------------------------------------------------------------------
  // Verified forwarding addresses  —  /accounts/:accountId/forwarding-addresses
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/forwarding-addresses", authz("forwarding-addresses:read", c => `accounts/${c.req.param("accountId")}/forwarding-addresses`), async (c) => {
    const { accountId } = c.get("auth");
    const addressesResult = await accountDb.listVerifiedForwardingAddresses(accountId);
    if (addressesResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(page("forwardingAddresses", addressesResult.value));
  });

  app.post("/accounts/:accountId/forwarding-addresses", authz("forwarding-addresses:write", c => `accounts/${c.req.param("accountId")}/forwarding-addresses`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreateForwardingAddressRequest, c.req.raw);

    const existingResult = await accountDb.getVerifiedForwardingAddress(accountId, body.address);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    const existing = existingResult.value;
    if (existing?.status === "verified") return c.json(existing, 200);

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
    const saveResult = await accountDb.saveVerifiedForwardingAddress(addr);
    if (saveResult.isErr()) return err(c, 500, "Internal Server Error");

    if (verificationMailer) {
      const verifyResult = await verificationMailer.sendForwardVerification(accountId, addr.address, addr.token);
      if (verifyResult.isErr()) {
        logger.warn("Failed to send forwarding address verification email. The SES send call returned an error. The user won't receive the verification link.", { code: "forwarding.verification_email_failed", accountId, address: addr.address, error: verifyResult.error });
        return err(c, 422, "Failed to send verification email. Please try again.");
      }
    }

    return c.json(addr, 201);
  });

  app.post("/accounts/:accountId/forwarding-addresses/:address/verify", authz("forwarding-addresses:write", c => `accounts/${c.req.param("accountId")}/forwarding-addresses/${c.req.param("address")}`), async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const body = await zParse(VerifyForwardingAddressRequest, c.req.raw);

    const existingResult = await accountDb.getVerifiedForwardingAddress(accountId, address);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    const existing = existingResult.value;
    if (!existing) return err(c, 404, "Forwarding address not found", "FORWARDING_ADDRESS_NOT_FOUND");
    if (existing.status === "verified") return c.json(existing);
    if (existing.token !== body.token) return err(c, 400, "Invalid token", "INVALID_TOKEN");

    const verified: VerifiedForwardingAddress = { ...existing, status: "verified", verifiedAt: DateTime.utc().toISO()! };
    const saveResult = await accountDb.saveVerifiedForwardingAddress(verified);
    if (saveResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(verified);
  });

  app.delete("/accounts/:accountId/forwarding-addresses/:address", authz("forwarding-addresses:write", c => `accounts/${c.req.param("accountId")}/forwarding-addresses/${c.req.param("address")}`), async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const deleteResult = await accountDb.deleteVerifiedForwardingAddress(accountId, address);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Audit  —  /accounts/:accountId/audit
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/audit", authz("audit:read", c => `accounts/${c.req.param("accountId")}/audit`), async (c) => {
    const { accountId } = c.get("auth");
    const cursor = c.req.query("cursor");
    const rawLimit = c.req.query("limit");
    const params: PageParams = { ...(cursor ? { cursor } : {}), ...(rawLimit ? { limit: parseInt(rawLimit, 10) } : {}) };
    const result = await auditDb.listAuditEvents(accountId, params);
    if (result.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(result.value);
  });

  // ---------------------------------------------------------------------------
  // Reindex jobs (admin)
  // ---------------------------------------------------------------------------

  if (jobDispatcher) {
    const MIN_SEGMENT_COUNT = 1;
    const MAX_SEGMENT_COUNT = 256;

    app.post("/reindex", async (c) => {
      let body: Record<string, unknown> | null;
      try {
        body = await c.req.json<Record<string, unknown>>();
      } catch {
        body = null;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return err(c, 400, "Request body must be a JSON object");
      }

      const { targetRegistryId, segmentCount } = body;
      if (!targetRegistryId || typeof targetRegistryId !== "string") {
        return err(c, 400, "targetRegistryId is required and must be a string");
      }
      if (segmentCount !== undefined) {
        if (typeof segmentCount !== "number" || !Number.isInteger(segmentCount)) {
          return err(c, 400, "segmentCount must be an integer");
        }
        if (segmentCount < MIN_SEGMENT_COUNT || segmentCount > MAX_SEGMENT_COUNT) {
          return err(c, 400, `segmentCount must be between ${MIN_SEGMENT_COUNT} and ${MAX_SEGMENT_COUNT}`);
        }
      }

      const result = await jobDispatcher.dispatch(targetRegistryId, segmentCount as number | undefined);
      if (result.isErr()) return err(c, 404, `Cluster "${targetRegistryId}" not found`);
      return c.json(result.value, 202);
    });
  }

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
): { message: string; code: string } | null {
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
