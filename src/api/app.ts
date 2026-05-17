import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { randomUUID, createHash, randomBytes } from "crypto";
import { getDomain } from "tldts";
import { checkDomain } from "../dns/dns-checker.js";
import type { AuditEvent } from "../database/audit-database.js";
import type { Result } from "neverthrow";
import type { DbError, NotFoundError, AuthressServiceError, AuthError } from "../errors.js";
import type { Arc, Signal, View, Label, Rule, Domain, DnsRecord, Account, Page, PageParams, ArcStatus, Workflow, WorkflowData, Alias, AliasSender, SenderPolicy, VerifiedForwardingAddress, Pagination, EmailTemplate } from "../types/index.js";
import type { Logger } from "../logger.js";
import { deriveGroupingKey } from "../processor/processor.js";
import { zParse } from "./validate.js";
import { validateRuleCondition } from "./validate-rule-condition.js";
import { parseStatsRow } from "../database/stats-writer.js";

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

export type AccountRole = "owner" | "admin" | "member" | "viewer";

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
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ListArcsParams extends PageParams {
  workflow?: Workflow;
  label?: string;
  status?: ArcStatus;
}

export type { UpdateArcRequest, UpdateSignalStatusRequest, CreateViewRequest, UpdateViewRequest, CreateLabelRequest, UpdateLabelRequest, CreateRuleRequest, UpdateRuleRequest };

export interface ApiDatabase {
  // Arcs
  listArcs(accountId: string, params: ListArcsParams): PromiseLike<Result<Page<Arc>, DbError>>;
  getArc(accountId: string, id: string): PromiseLike<Result<Arc | null, DbError>>;
  updateArc(accountId: string, id: string, update: UpdateArcRequest): PromiseLike<Result<Arc, DbError>>;

  // Signals
  listSignals(accountId: string, arcId: string, params: PageParams): PromiseLike<Result<Page<Signal>, DbError>>;
  listPreArcSignals(accountId: string, status: "quarantined", params: PageParams): PromiseLike<Result<Page<Signal>, DbError>>;
  getSignal(accountId: string, id: string): PromiseLike<Result<Signal | null, DbError>>;
  createSignal(signal: Signal): PromiseLike<Result<Signal, DbError>>;
  updateSignal(accountId: string, id: string, update: Partial<Pick<Signal, "subject" | "textBody" | "from" | "to">>): PromiseLike<Result<Signal, DbError>>;
  deleteSignal(accountId: string, id: string): PromiseLike<Result<void, DbError>>;

  // Views
  listViews(accountId: string): PromiseLike<Result<View[], DbError>>;
  getView(accountId: string, id: string): PromiseLike<Result<View | null, DbError>>;
  createView(accountId: string, data: CreateViewRequest): PromiseLike<Result<View, DbError>>;
  updateView(accountId: string, id: string, data: UpdateViewRequest): PromiseLike<Result<View, DbError>>;
  deleteView(accountId: string, id: string): PromiseLike<Result<void, DbError>>;

  // Labels
  listLabels(accountId: string): PromiseLike<Result<Label[], DbError>>;
  createLabel(accountId: string, data: CreateLabelRequest): PromiseLike<Result<Label, DbError>>;
  updateLabel(accountId: string, id: string, data: UpdateLabelRequest): PromiseLike<Result<Label, DbError>>;
  deleteLabel(accountId: string, id: string): PromiseLike<Result<void, DbError>>;

  // Rules
  listRules(accountId: string): PromiseLike<Result<Rule[], DbError>>;
  createRule(accountId: string, data: CreateRuleRequest): PromiseLike<Result<Rule, DbError>>;
  updateRule(accountId: string, id: string, data: UpdateRuleRequest): PromiseLike<Result<Rule, DbError>>;
  deleteRule(accountId: string, id: string): PromiseLike<Result<void, DbError>>;

  // Domains
  listDomains(accountId: string): PromiseLike<Result<Domain[], DbError>>;
  getDomain(accountId: string, id: string): PromiseLike<Result<Domain | null, DbError>>;
  createDomain(accountId: string, domain: string): PromiseLike<Result<Domain, DbError>>;
  deleteDomain(accountId: string, id: string): PromiseLike<Result<void, DbError>>;
  updateDomainHealth(accountId: string, id: string, health: { receivingHealthy: boolean; senderHealthy: boolean; failingRecords: string[]; lastCheckedAt: string; lastHealthyAt?: string }): PromiseLike<Result<void, DbError>>;

  // Search
  searchArcs(accountId: string, query: string, params: PageParams): PromiseLike<Result<Page<Arc>, DbError>>;

  // Account
  getAccount(accountId: string): PromiseLike<Result<Account | null, DbError>>;
  createAccount(account: Account): PromiseLike<Result<Account, DbError>>;
  updateAccount(accountId: string, update: Partial<Pick<Account, "name" | "deletionRetentionDays" | "notifications" | "filtering" | "onboarding">>): PromiseLike<Result<Account, DbError>>;

  // Aliases
  listAliases(accountId: string): PromiseLike<Result<Alias[], DbError>>;
  getAlias(accountId: string, address: string): PromiseLike<Result<Alias | null, DbError>>;
  createAlias(alias: Alias): PromiseLike<Result<Alias, DbError>>;
  upsertAlias(alias: Alias): PromiseLike<Result<Alias, DbError>>;
  deleteAlias(accountId: string, address: string): PromiseLike<Result<void, DbError>>;
  renameAlias(accountId: string, oldAddress: string, newAddress: string): PromiseLike<Result<Alias, DbError | NotFoundError>>;

  // Alias Senders
  saveSender(accountId: string, address: string, domain: string, policy: SenderPolicy): PromiseLike<Result<void, DbError>>;
  removeSender(accountId: string, address: string, domain: string): PromiseLike<Result<void, DbError>>;
  listSenders(accountId: string, address: string): PromiseLike<Result<AliasSender[], DbError>>;

  // Templates
  createTemplate(template: EmailTemplate): PromiseLike<Result<EmailTemplate, DbError>>;
  getTemplate(accountId: string, id: string): PromiseLike<Result<EmailTemplate | null, DbError>>;
  updateTemplate(accountId: string, id: string, update: Partial<Pick<EmailTemplate, "name" | "subject" | "body">>): PromiseLike<Result<EmailTemplate, DbError>>;
  deleteTemplate(accountId: string, id: string): PromiseLike<Result<void, DbError>>;
  listTemplates(accountId: string): PromiseLike<Result<EmailTemplate[], DbError>>;


  // Signal status management
  updateSignalStatus(accountId: string, signalId: string, status: "block_hidden" | "block_reject" | "violate_report"): PromiseLike<Result<Signal, DbError>>;
  unblockSignal(accountId: string, signalId: string, arcId: string): PromiseLike<Result<void, DbError>>;
  createArc(arc: Arc): PromiseLike<Result<void, DbError>>;
  saveArc(arc: Arc): PromiseLike<Result<void, DbError>>;
  findArcByGroupingKey(accountId: string, key: string): PromiseLike<Result<Arc | null, DbError>>;

  // Verified forwarding addresses
  listVerifiedForwardingAddresses(accountId: string): PromiseLike<Result<VerifiedForwardingAddress[], DbError>>;
  getVerifiedForwardingAddress(accountId: string, address: string): PromiseLike<Result<VerifiedForwardingAddress | null, DbError>>;
  saveVerifiedForwardingAddress(addr: VerifiedForwardingAddress): PromiseLike<Result<void, DbError>>;
  deleteVerifiedForwardingAddress(accountId: string, address: string): PromiseLike<Result<void, DbError>>;

  // Audit
  listAuditEvents(accountId: string, params: PageParams): PromiseLike<Result<Page<AuditEvent>, DbError>>;

  // Stats
  getStats(accountId: string): PromiseLike<Result<Record<string, unknown> | null, DbError>>;
}

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
  store: ApiDatabase;
  auth: AuthService;
  access?: AccessService;
  logger: Logger;
  verificationMailer?: VerificationMailer;
  jobDispatcher?: JobDispatcher;
  accountCreationStarter?: { start(accountId: string, email: string): Promise<void> };
}

type AppEnv = { Variables: { auth: AuthContext; authorizationVerified?: boolean } };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function page<K extends string, T>(key: K, items: T[], nextCursor?: string): Record<K, T[]> & { pagination: Pagination } {
  return { [key]: items, pagination: { cursor: nextCursor ?? null } } as Record<K, T[]> & { pagination: Pagination };
}

const ACCOUNT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function generateAccountId(): string {
  const bytes = randomBytes(10);
  let rawId = "";
  for (let i = 0; i < 10; i++) {
    rawId += ACCOUNT_ID_ALPHABET[bytes[i]! % ACCOUNT_ID_ALPHABET.length];
  }
  const checkBits = createHash("sha256").update(rawId).digest("base64")
    .replace(/[^abcdefghijklmnopqrstuvwxyz0123456789]/g, "")
    .slice(0, 3);
  return `acc-${rawId}${checkBits}`;
}

export function createApp({ store, auth, access, logger, verificationMailer, jobDispatcher, accountCreationStarter }: AppDeps) {
  const app = new OpenAPIHono<AppEnv>().basePath('/api');

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "SES Email Adapter", version: "1.0.0" },
  });

  app.get("/", (c) => c.redirect("/api/openapi.json", 301));

  function err(c: Context<AppEnv>, status: number, title: string, errorCode?: string, details?: unknown) {
    return c.json(
      { title, ...(errorCode ? { errorCode } : {}), ...(details !== undefined ? { details } : {}) },
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
      const accountResult = await store.getAccount(accountId);
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
    const now = new Date().toISOString();
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
      const createResult = await store.createAccount(candidate);
      if (createResult.isOk()) {
        account = candidate;
        break;
      }
      // ConditionalCheckFailedException means ID collision — retry with a new ID
    }
    if (!account) return err(c, 500, "Internal Server Error");

    // Grant owner role in Authress
    const accessResult = await access.addUser(account.id, userId, "owner");
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
      const result = await store.searchArcs(accountId, q, params);
      if (result.isErr()) return err(c, 500, "Internal Server Error");
      return c.json(page("arcs", result.value.items, result.value.nextCursor));
    }
    const params: ListArcsParams = {
      ...(query["workflow"] ? { workflow: query["workflow"] as Workflow } : {}),
      ...(query["label"] ? { label: query["label"] } : {}),
      ...(query["status"] ? { status: query["status"] as ArcStatus } : {}),
      ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
      ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
    };
    const result = await store.listArcs(accountId, params);
    if (result.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(page("arcs", result.value.items, result.value.nextCursor));
  });

  app.get("/accounts/:accountId/arcs/:id", authz("arcs:read", c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const arcResult = await store.getArc(accountId, c.req.param("id"));
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    if (arc.accountId !== accountId) return err(c, 403, "Forbidden");
    return c.json(arc);
  });

  app.patch("/accounts/:accountId/arcs/:id", authz("arcs:write", c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const arcResult = await store.getArc(accountId, c.req.param("id"));
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    if (arc.accountId !== accountId) return err(c, 403, "Forbidden");
    const body = await zParse(UpdateArcRequest, c.req.raw);
    const updateResult = await store.updateArc(accountId, arc.id, { ...body, lastSignalAt: arc.lastSignalAt });
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(updateResult.value);
  });

  // -------------------------------------------------------------------------
  // Signals  —  /accounts/:accountId/arcs/:arcId/signals  &  /signals/:id
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/arcs/:arcId/signals", authz("signals:read", c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("arcId")}/signals`), async (c) => {
    const { accountId } = c.get("auth");
    const arcResult = await store.getArc(accountId, c.req.param("arcId"));
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    if (arc.accountId !== accountId) return err(c, 403, "Forbidden");
    const query = c.req.query();
    const params: PageParams = {
      ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
      ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
    };
    const result = await store.listSignals(accountId, arc.id, params);
    if (result.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(page("signals", result.value.items, result.value.nextCursor));
  });

  app.post("/accounts/:accountId/arcs/:arcId/signals", authz("signals:write", c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("arcId")}/signals`), async (c) => {
    const { accountId } = c.get("auth");
    const arcResult = await store.getArc(accountId, c.req.param("arcId"));
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    if (arc.accountId !== accountId) return err(c, 403, "Forbidden");
    const body = await zParse(CreateDraftSignalRequest, c.req.raw);
    const now = new Date().toISOString();
    const signal: Signal = {
      id: `USR#${randomUUID()}`,
      arcId: arc.id,
      accountId,
      source: "user",
      receivedAt: now,
      from: body.from as Signal["from"],
      to: body.to as Signal["to"],
      cc: [],
      subject: body.subject,
      ...(body.textBody != null ? { textBody: body.textBody } : {}),
      attachments: [],
      headers: {},
      recipientAddress: body.from.address,
      workflow: arc.workflow,
      workflowData: { workflow: arc.workflow } as Signal["workflowData"],
      spamScore: 0,
      summary: "",
      classificationModelId: "",
      s3Key: "",
      status: "draft",
      createdAt: now,
    };
    const createResult = await store.createSignal(signal);
    if (createResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(createResult.value, 201);
  });

  app.put("/accounts/:accountId/arcs/:arcId/signals/:id", authz("signals:write", c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("arcId")}/signals/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const arcResult = await store.getArc(accountId, c.req.param("arcId"));
    if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
    const arc = arcResult.value;
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    if (arc.accountId !== accountId) return err(c, 403, "Forbidden");
    const signalResult = await store.getSignal(accountId, c.req.param("id"));
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.arcId !== arc.id) return err(c, 400, "Signal does not belong to this arc", "SIGNAL_ARC_MISMATCH");
    if (signal.status !== "draft") return err(c, 400, "Only draft signals can be replaced", "SIGNAL_NOT_DRAFT");
    const body = await zParse(ReplaceDraftSignalRequest, c.req.raw);
    const updateResult = await store.updateSignal(accountId, signal.id, {
      from: body.from as Signal["from"],
      to: body.to as Signal["to"],
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
    const result = await store.listPreArcSignals(accountId, "quarantined", params);
    if (result.isErr()) return err(c, 500, "Internal Server Error");
    const items = (status === "quarantine_visible" || status === "quarantine_hidden")
      ? result.value.items.filter(s => s.status === status)
      : result.value.items;
    return c.json(page("signals", items, result.value.nextCursor));
  });

  app.post("/accounts/:accountId/signals/:id/quarantineResponse", authz("signals:write", c => `accounts/${c.req.param("accountId")}/signals/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const signalResult = await store.getSignal(accountId, c.req.param("id"));
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.accountId !== accountId) return err(c, 403, "Forbidden");
    if (signal.status !== "quarantine_visible" && signal.status !== "quarantine_hidden") {
      return err(c, 400, "Only quarantined signals can have their status updated", "SIGNAL_NOT_REVIEWABLE");
    }

    const body = await zParse(UpdateSignalStatusRequest, c.req.raw);

    // Determine if quarantine was caused by unknown sender (no status-changing rule fired)
    const wasQuarantinedByUnknownSender = !(signal.matchedRules ?? []).some(r => r.statusChange);

    if (body.status === "block_hidden" || body.status === "block_reject" || body.status === "violate_report") {
      const blockResult = await store.updateSignalStatus(accountId, signal.id, body.status);
      if (blockResult.isErr()) return err(c, 500, "Internal Server Error");

      // When quarantined by unknown sender, persist sender disposition for future auto-blocking
      if (wasQuarantinedByUnknownSender) {
        const senderDomain = signal.from.address.includes("@") ? signal.from.address.split("@").pop()! : signal.from.address;
        const senderETLD1 = getDomain(senderDomain) ?? senderDomain;
        const saveSenderResult = await store.saveSender(accountId, signal.recipientAddress, senderETLD1, body.status);
        if (saveSenderResult.isErr()) return err(c, 500, "Internal Server Error");
      }

      return c.json(blockResult.value);
    }

    // status === "active": find existing arc or create one, bypassing rule evaluation
    const senderDomain = signal.from.address.includes("@") ? signal.from.address.split("@").pop()! : signal.from.address;
    const senderETLD1 = getDomain(senderDomain) ?? senderDomain;
    const groupingKey = deriveGroupingKey(signal.workflow, signal.workflowData, signal.recipientAddress, senderETLD1);
    const matchedArcResult = groupingKey ? await store.findArcByGroupingKey(accountId, groupingKey) : null;
    if (matchedArcResult && matchedArcResult.isErr()) return err(c, 500, "Internal Server Error");
    const matchedArc = matchedArcResult ? matchedArcResult.value : null;

    const now = new Date().toISOString();
    let arc: Arc;
    if (matchedArc) {
      arc = matchedArc;
      if (signal.receivedAt > arc.lastSignalAt) {
        arc = { ...arc, lastSignalAt: signal.receivedAt, updatedAt: now };
        const saveResult = await store.saveArc(arc);
        if (saveResult.isErr()) return err(c, 500, "Internal Server Error");
      }
    } else {
      arc = {
        id: randomUUID(),
        accountId,
        workflow: signal.workflow,
        labels: [],
        status: "active",
        summary: signal.summary,
        lastSignalAt: signal.receivedAt,
        createdAt: now,
        updatedAt: now,
        ...(groupingKey ? { groupingKey } : {}),
      };
      const createResult = await store.createArc(arc);
      if (createResult.isErr()) return err(c, 500, "Internal Server Error");
    }

    const unblockResult = await store.unblockSignal(accountId, signal.id, arc.id);
    if (unblockResult.isErr()) return err(c, 500, "Internal Server Error");

    // When quarantined by unknown sender, approve the sender for future emails
    if (wasQuarantinedByUnknownSender) {
      const saveSenderResult = await store.saveSender(accountId, signal.recipientAddress, senderETLD1, "allow");
      if (saveSenderResult.isErr()) return err(c, 500, "Internal Server Error");
    }

    return c.json({ arc, signal: { ...signal, status: "active", arcId: arc.id } });
  });

  app.get("/accounts/:accountId/signals/:id", authz("signals:read", c => `accounts/${c.req.param("accountId")}/signals/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const signalResult = await store.getSignal(accountId, c.req.param("id"));
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.accountId !== accountId) return err(c, 403, "Forbidden");
    return c.json(signal);
  });

  app.patch("/accounts/:accountId/signals/:id", authz("signals:write", c => `accounts/${c.req.param("accountId")}/signals/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const signalResult = await store.getSignal(accountId, c.req.param("id"));
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.accountId !== accountId) return err(c, 403, "Forbidden");
    if (signal.status !== "draft") return err(c, 400, "Only draft signals can be updated", "SIGNAL_NOT_DRAFT");
    const body = await zParse(UpdateSignalRequest, c.req.raw);
    const updateResult = await store.updateSignal(accountId, signal.id, body as Parameters<typeof store.updateSignal>[2]);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(updateResult.value);
  });

  app.post("/accounts/:accountId/signals/:id/send", authz("signals:write", c => `accounts/${c.req.param("accountId")}/signals/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const signalResult = await store.getSignal(accountId, c.req.param("id"));
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.accountId !== accountId) return err(c, 403, "Forbidden");
    if (signal.status !== "draft") return err(c, 400, "Only draft signals can be sent", "SIGNAL_NOT_DRAFT");
    // Flip to active — the actual SES send is wired at the handler layer outside the API
    const sendResult = await store.updateSignal(accountId, signal.id, {});
    if (sendResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(sendResult.value);
  });

  app.delete("/accounts/:accountId/signals/:id", authz("signals:write", c => `accounts/${c.req.param("accountId")}/signals/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const signalResult = await store.getSignal(accountId, c.req.param("id"));
    if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
    const signal = signalResult.value;
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.accountId !== accountId) return err(c, 403, "Forbidden");
    if (signal.status !== "draft") return err(c, 400, "Only draft signals can be deleted", "SIGNAL_NOT_DRAFT");
    const deleteResult = await store.deleteSignal(accountId, signal.id);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Views  —  /accounts/:accountId/views
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/views", authz("views:read", c => `accounts/${c.req.param("accountId")}/views`), async (c) => {
    const { accountId } = c.get("auth");
    const viewsResult = await store.listViews(accountId);
    if (viewsResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(page("views", viewsResult.value));
  });

  app.post("/accounts/:accountId/views", authz("views:write", c => `accounts/${c.req.param("accountId")}/views`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreateViewRequest, c.req.raw);
    const viewResult = await store.createView(accountId, body);
    if (viewResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(viewResult.value, 201);
  });

  app.patch("/accounts/:accountId/views/:id", authz("views:write", c => `accounts/${c.req.param("accountId")}/views/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const viewResult = await store.getView(accountId, c.req.param("id"));
    if (viewResult.isErr()) return err(c, 500, "Internal Server Error");
    const view = viewResult.value;
    if (!view) return err(c, 404, "View not found", "VIEW_NOT_FOUND");
    const body = await zParse(UpdateViewRequest, c.req.raw);
    const updateResult = await store.updateView(accountId, view.id, body);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(updateResult.value);
  });

  app.delete("/accounts/:accountId/views/:id", authz("views:write", c => `accounts/${c.req.param("accountId")}/views/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const viewResult = await store.getView(accountId, c.req.param("id"));
    if (viewResult.isErr()) return err(c, 500, "Internal Server Error");
    const view = viewResult.value;
    if (!view) return err(c, 404, "View not found", "VIEW_NOT_FOUND");
    const deleteResult = await store.deleteView(accountId, view.id);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Labels  —  /accounts/:accountId/labels
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/labels", authz("labels:read", c => `accounts/${c.req.param("accountId")}/labels`), async (c) => {
    const { accountId } = c.get("auth");
    const labelsResult = await store.listLabels(accountId);
    if (labelsResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(page("labels", labelsResult.value));
  });

  app.post("/accounts/:accountId/labels", authz("labels:write", c => `accounts/${c.req.param("accountId")}/labels`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreateLabelRequest, c.req.raw);
    const labelResult = await store.createLabel(accountId, body);
    if (labelResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(labelResult.value, 201);
  });

  app.patch("/accounts/:accountId/labels/:id", authz("labels:write", c => `accounts/${c.req.param("accountId")}/labels/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const labelsResult = await store.listLabels(accountId);
    if (labelsResult.isErr()) return err(c, 500, "Internal Server Error");
    const label = labelsResult.value.find((l) => l.id === c.req.param("id"));
    if (!label) return err(c, 404, "Label not found", "LABEL_NOT_FOUND");
    const body = await zParse(UpdateLabelRequest, c.req.raw);
    const updateResult = await store.updateLabel(accountId, label.id, body);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(updateResult.value);
  });

  app.delete("/accounts/:accountId/labels/:id", authz("labels:write", c => `accounts/${c.req.param("accountId")}/labels/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const labelsResult = await store.listLabels(accountId);
    if (labelsResult.isErr()) return err(c, 500, "Internal Server Error");
    const label = labelsResult.value.find((l) => l.id === c.req.param("id"));
    if (!label) return err(c, 404, "Label not found", "LABEL_NOT_FOUND");
    const deleteResult = await store.deleteLabel(accountId, label.id);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Rules  —  /accounts/:accountId/rules
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/rules", authz("rules:read", c => `accounts/${c.req.param("accountId")}/rules`), async (c) => {
    const { accountId } = c.get("auth");
    const rulesResult = await store.listRules(accountId);
    if (rulesResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(page("rules", rulesResult.value));
  });

  app.post("/accounts/:accountId/rules", authz("rules:write", c => `accounts/${c.req.param("accountId")}/rules`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreateRuleRequest, c.req.raw);
    if (body.condition) {
      const conditionError = validateRuleCondition(body.condition);
      if (conditionError) return err(c, 400, conditionError, "INVALID_CONDITION");
    }
    const forwardError = await validateForwardTargets(accountId, body.actions as Rule["actions"], store);
    if (forwardError) return err(c, 400, forwardError, "UNVERIFIED_FORWARD_TARGET");
    const ruleResult = await store.createRule(accountId, body as Parameters<typeof store.createRule>[1]);
    if (ruleResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(ruleResult.value, 201);
  });

  app.patch("/accounts/:accountId/rules/:id", authz("rules:write", c => `accounts/${c.req.param("accountId")}/rules/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const rulesResult = await store.listRules(accountId);
    if (rulesResult.isErr()) return err(c, 500, "Internal Server Error");
    const rule = rulesResult.value.find((r) => r.id === c.req.param("id"));
    if (!rule) return err(c, 404, "Rule not found", "RULE_NOT_FOUND");
    const body = await zParse(UpdateRuleRequest, c.req.raw);
    if (body.condition) {
      const conditionError = validateRuleCondition(body.condition);
      if (conditionError) return err(c, 400, conditionError, "INVALID_CONDITION");
    }
    if (body.actions) {
      const forwardError = await validateForwardTargets(accountId, body.actions as Rule["actions"], store);
      if (forwardError) return err(c, 400, forwardError, "UNVERIFIED_FORWARD_TARGET");
    }
    const updateResult = await store.updateRule(accountId, rule.id, body as Parameters<typeof store.updateRule>[2]);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(updateResult.value);
  });

  app.delete("/accounts/:accountId/rules/:id", authz("rules:write", c => `accounts/${c.req.param("accountId")}/rules/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const rulesResult = await store.listRules(accountId);
    if (rulesResult.isErr()) return err(c, 500, "Internal Server Error");
    const rule = rulesResult.value.find((r) => r.id === c.req.param("id"));
    if (!rule) return err(c, 404, "Rule not found", "RULE_NOT_FOUND");
    const deleteResult = await store.deleteRule(accountId, rule.id);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Domains  —  /accounts/:accountId/domains
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/domains", authz("domains:read", c => `accounts/${c.req.param("accountId")}/domains`), async (c) => {
    const { accountId } = c.get("auth");
    const domainsResult = await store.listDomains(accountId);
    if (domainsResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(page("domains", domainsResult.value));
  });

  app.post("/accounts/:accountId/domains", authz("domains:write", c => `accounts/${c.req.param("accountId")}/domains`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreateDomainRequest, c.req.raw);
    const domainResult = await store.createDomain(accountId, body.domain);
    if (domainResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(domainResult.value, 201);
  });

  app.get("/accounts/:accountId/domains/:id", authz("domains:read", c => `accounts/${c.req.param("accountId")}/domains/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const domainResult = await store.getDomain(accountId, c.req.param("id"));
    if (domainResult.isErr()) return err(c, 500, "Internal Server Error");
    const domain = domainResult.value;
    if (!domain) return err(c, 404, "Domain not found", "DOMAIN_NOT_FOUND");
    if (domain.accountId !== accountId) return err(c, 403, "Forbidden");
    const records = buildDnsRecords(domain);
    return c.json({ ...domain, records });
  });

  app.patch("/accounts/:accountId/domains/:id", authz("domains:write", c => `accounts/${c.req.param("accountId")}/domains/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const domainResult = await store.getDomain(accountId, c.req.param("id"));
    if (domainResult.isErr()) return err(c, 500, "Internal Server Error");
    const domain = domainResult.value;
    if (!domain) return err(c, 404, "Domain not found", "DOMAIN_NOT_FOUND");
    if (domain.accountId !== accountId) return err(c, 403, "Forbidden");
    const records = await checkDomain(domain);
    const now = new Date().toISOString();
    const failingRecords = records.filter((r) => r.status === "failing").map((r) => r.name);
    const receivingHealthy = records.find((r) => r.type === "MX")?.status === "verified";
    const senderHealthy = records.filter((r) => r.type !== "MX").every((r) => r.status === "verified");
    const healthResult = await store.updateDomainHealth(accountId, domain.id, {
      receivingHealthy,
      senderHealthy,
      failingRecords,
      lastCheckedAt: now,
      ...(failingRecords.length === 0 ? { lastHealthyAt: now } : {}),
    });
    if (healthResult.isErr()) return err(c, 500, "Internal Server Error");
    const updatedResult = await store.getDomain(accountId, domain.id);
    if (updatedResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json({ ...updatedResult.value, records });
  });

  app.delete("/accounts/:accountId/domains/:id", authz("domains:write", c => `accounts/${c.req.param("accountId")}/domains/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const domainResult = await store.getDomain(accountId, c.req.param("id"));
    if (domainResult.isErr()) return err(c, 500, "Internal Server Error");
    const domain = domainResult.value;
    if (!domain) return err(c, 404, "Domain not found", "DOMAIN_NOT_FOUND");
    if (domain.accountId !== accountId) return err(c, 403, "Forbidden");
    const deleteResult = await store.deleteDomain(accountId, domain.id);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Account  —  /accounts/:accountId
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId", authz("accounts:read", c => `accounts/${c.req.param("accountId")}`), async (c) => {
    const { accountId } = c.get("auth");
    const accountResult = await store.getAccount(accountId);
    if (accountResult.isErr()) return err(c, 500, "Internal Server Error");
    const account = accountResult.value;
    if (!account) return err(c, 404, "Account not found", "ACCOUNT_NOT_FOUND");
    return c.json(account);
  });

  app.patch("/accounts/:accountId", authz("accounts:write", c => `accounts/${c.req.param("accountId")}`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(UpdateAccountRequest, c.req.raw);
    const updateResult = await store.updateAccount(accountId, body as Partial<Pick<Account, "name" | "deletionRetentionDays" | "notifications" | "filtering" | "onboarding">>);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(updateResult.value);
  });

  app.get("/accounts/:accountId/stats", authz("stats:read", c => `accounts/${c.req.param("accountId")}/stats`), async (c) => {
    const { accountId } = c.get("auth");
    const statsResult = await store.getStats(accountId);
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

  app.post("/accounts/:accountId/users", authz("users:write", c => `accounts/${c.req.param("accountId")}/users`), async (c) => {
    if (!access) return err(c, 501, "Not implemented");
    const { accountId } = c.get("auth");
    const body = await zParse(InviteUserRequest, c.req.raw);
    const result = await access.addUser(accountId, body.userId, body.role);
    if (result.isErr()) {
      logger.warn("Authress service unavailable while adding user.", { code: "api.authress_unavailable", accountId, userId: body.userId, error: result.error });
      return err(c, 503, "Service temporarily unavailable");
    }
    return c.json({ userId: body.userId, role: body.role }, 201);
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
    const aliasesResult = await store.listAliases(accountId);
    if (aliasesResult.isErr()) return err(c, 500, "Internal Server Error");
    let aliases = aliasesResult.value;
    if (domain) aliases = aliases.filter(a => a.createdForOrigin?.includes(domain));
    return c.json(page("aliases", aliases));
  });

  app.get("/accounts/:accountId/aliases/:address", authz("aliases:read", c => `accounts/${c.req.param("accountId")}/aliases/${c.req.param("address")}`), async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const aliasResult = await store.getAlias(accountId, address);
    if (aliasResult.isErr()) return err(c, 500, "Internal Server Error");
    const alias = aliasResult.value;
    if (!alias) return err(c, 404, "Alias not found", "ALIAS_NOT_FOUND");
    return c.json(alias);
  });

  app.post("/accounts/:accountId/aliases", authz("aliases:write", c => `accounts/${c.req.param("accountId")}/aliases`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreateAliasRequest, c.req.raw);
    const existingResult = await store.getAlias(accountId, body.address);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    if (existingResult.value) return err(c, 409, "Alias already exists", "ALIAS_EXISTS");
    const now = new Date().toISOString();
    const createResult = await store.createAlias({
      id: randomUUID(),
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
      const renameResult = await store.renameAlias(accountId, address, body.newAddress);
      if (renameResult.isErr()) {
        if (renameResult.error.kind === "not_found") return err(c, 404, "Alias not found", "ALIAS_NOT_FOUND");
        return err(c, 500, "Internal Server Error");
      }
      return c.json(renameResult.value);
    }
    const existingResult = await store.getAlias(accountId, address);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    const existing = existingResult.value;
    const now = new Date().toISOString();
    const upsertResult = await store.upsertAlias({
      id: existing?.id ?? randomUUID(),
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
    const deleteResult = await store.deleteAlias(accountId, address);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Alias Senders  —  /accounts/:accountId/aliases/:address/senders
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/aliases/:address/senders", authz("aliases:read", c => `accounts/${c.req.param("accountId")}/aliases/${c.req.param("address")}/senders`), async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const sendersResult = await store.listSenders(accountId, address);
    if (sendersResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json({ senders: sendersResult.value });
  });

  app.post("/accounts/:accountId/aliases/:address/senders", authz("aliases:write", c => `accounts/${c.req.param("accountId")}/aliases/${c.req.param("address")}/senders`), async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const body = await zParse(CreateSenderRequest, c.req.raw);
    const saveResult = await store.saveSender(accountId, address, body.domain, body.policy);
    if (saveResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 201 });
  });

  app.delete("/accounts/:accountId/aliases/:address/senders/:domain", authz("aliases:write", c => `accounts/${c.req.param("accountId")}/aliases/${c.req.param("address")}/senders/${c.req.param("domain")}`), async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const domain = decodeURIComponent(c.req.param("domain"));
    const removeResult = await store.removeSender(accountId, address, domain);
    if (removeResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Email Templates  —  /accounts/:accountId/templates
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/templates", authz("templates:read", c => `accounts/${c.req.param("accountId")}/templates`), async (c) => {
    const { accountId } = c.get("auth");
    const templatesResult = await store.listTemplates(accountId);
    if (templatesResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json({ templates: templatesResult.value });
  });

  app.post("/accounts/:accountId/templates", authz("templates:write", c => `accounts/${c.req.param("accountId")}/templates`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreateTemplateRequest, c.req.raw);
    const now = new Date().toISOString();
    const templateResult = await store.createTemplate({
      id: randomUUID(), accountId, name: body.name, subject: body.subject, body: body.body,
      createdAt: now, updatedAt: now,
    });
    if (templateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(templateResult.value, 201);
  });

  app.patch("/accounts/:accountId/templates/:id", authz("templates:write", c => `accounts/${c.req.param("accountId")}/templates/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(UpdateTemplateRequest, c.req.raw);
    const existingResult = await store.getTemplate(accountId, c.req.param("id"));
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    if (!existingResult.value) return err(c, 404, "Template not found", "TEMPLATE_NOT_FOUND");
    const updateResult = await store.updateTemplate(accountId, c.req.param("id"), body as Parameters<typeof store.updateTemplate>[2]);
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(updateResult.value);
  });

  app.put("/accounts/:accountId/templates/:id", authz("templates:write", c => `accounts/${c.req.param("accountId")}/templates/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(ReplaceTemplateRequest, c.req.raw);
    const existingResult = await store.getTemplate(accountId, c.req.param("id"));
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    if (!existingResult.value) return err(c, 404, "Template not found", "TEMPLATE_NOT_FOUND");
    const updateResult = await store.updateTemplate(accountId, c.req.param("id"), { name: body.name, subject: body.subject, body: body.body });
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(updateResult.value);
  });

  app.delete("/accounts/:accountId/templates/:id", authz("templates:write", c => `accounts/${c.req.param("accountId")}/templates/${c.req.param("id")}`), async (c) => {
    const { accountId } = c.get("auth");
    const existingResult = await store.getTemplate(accountId, c.req.param("id"));
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    if (!existingResult.value) return err(c, 404, "Template not found", "TEMPLATE_NOT_FOUND");
    const deleteResult = await store.deleteTemplate(accountId, c.req.param("id"));
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });


  // -------------------------------------------------------------------------
  // Verified forwarding addresses  —  /accounts/:accountId/forwarding-addresses
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/forwarding-addresses", authz("forwarding-addresses:read", c => `accounts/${c.req.param("accountId")}/forwarding-addresses`), async (c) => {
    const { accountId } = c.get("auth");
    const addressesResult = await store.listVerifiedForwardingAddresses(accountId);
    if (addressesResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(page("forwardingAddresses", addressesResult.value));
  });

  app.post("/accounts/:accountId/forwarding-addresses", authz("forwarding-addresses:write", c => `accounts/${c.req.param("accountId")}/forwarding-addresses`), async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreateForwardingAddressRequest, c.req.raw);

    const existingResult = await store.getVerifiedForwardingAddress(accountId, body.address);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    const existing = existingResult.value;
    if (existing?.status === "verified") return c.json(existing, 200);

    const now = new Date().toISOString();
    const addr: VerifiedForwardingAddress = {
      id: existing?.id ?? randomUUID(),
      accountId,
      address: body.address,
      status: "pending",
      token: randomUUID(),
      createdAt: existing?.createdAt ?? now,
      ...(existing?.verifiedAt !== undefined ? { verifiedAt: existing.verifiedAt } : {}),
    };
    const saveResult = await store.saveVerifiedForwardingAddress(addr);
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

    const existingResult = await store.getVerifiedForwardingAddress(accountId, address);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    const existing = existingResult.value;
    if (!existing) return err(c, 404, "Forwarding address not found", "FORWARDING_ADDRESS_NOT_FOUND");
    if (existing.status === "verified") return c.json(existing);
    if (existing.token !== body.token) return err(c, 400, "Invalid token", "INVALID_TOKEN");

    const verified: VerifiedForwardingAddress = { ...existing, status: "verified", verifiedAt: new Date().toISOString() };
    const saveResult = await store.saveVerifiedForwardingAddress(verified);
    if (saveResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(verified);
  });

  app.delete("/accounts/:accountId/forwarding-addresses/:address", authz("forwarding-addresses:write", c => `accounts/${c.req.param("accountId")}/forwarding-addresses/${c.req.param("address")}`), async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const deleteResult = await store.deleteVerifiedForwardingAddress(accountId, address);
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
    const result = await store.listAuditEvents(accountId, params);
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
  store: Pick<ApiDatabase, "listVerifiedForwardingAddresses">,
): Promise<string | null> {
  const forwardTargets = actions.filter((a) => a.type === "forward" && a.value).map((a) => a.value!);
  if (forwardTargets.length === 0) return null;
  const verifiedResult = await store.listVerifiedForwardingAddresses(accountId);
  if (verifiedResult.isErr()) return "Internal error validating forward targets";
  const verifiedSet = new Set(verifiedResult.value.filter((v) => v.status === "verified").map((v) => v.address));
  const unverified = forwardTargets.filter((t) => !verifiedSet.has(t));
  return unverified.length > 0 ? `Forward targets not verified: ${unverified.join(", ")}` : null;
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
