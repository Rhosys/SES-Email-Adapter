import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { S3Client } from "@aws-sdk/client-s3";
import type { AuditDatabase } from "../database/audit-database.js";
import type { Result } from "neverthrow";
import type { NotFoundError, AuthressServiceError, AuthError, TransientSesError } from "../errors.js";
import type { Signal, PageParams, ArcStatus, Workflow, Pagination } from "../types/index.js";
import type { ArcDatabase } from "../database/arc-database.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";
import type { UserCodeExecutorClient } from "../processor/user-code-client.js";
import type { BillingHandler } from "../billing/billing-handler.js";
import type { DraftSendDispatcher } from "../processor/draft-send-dispatcher.js";
import type { EmailService } from "../email/email-service.js";
import type { DomainIdentityService } from "../email/domain-identity-service.js";
import type { sendRsvp as SendRsvpFn } from "../processor/calendar/rsvp-composer.js";
import type { PostApprovalCalendarHandlerDeps } from "../processor/calendar/post-approval-handler.js";
import type { SchedulerClient } from "../scheduler/scheduler-client.js";
import { registerViewsRoutes } from "./viewsApi.js";
import { registerLabelsRoutes } from "./labelsApi.js";
import { registerRulesRoutes } from "./rulesApi.js";
import { registerTemplatesRoutes } from "./templatesApi.js";
import { registerDomainsRoutes } from "./domainsApi.js";
import { registerAliasesRoutes } from "./aliasesApi.js";
import { registerAccountsRoutes } from "./accountsApi.js";
import { registerAuditRoutes } from "./auditApi.js";
import { registerAdminRoutes } from "./adminApi.js";
import { registerArcsRoutes } from "./arcsApi.js";

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
  CreateViewRequest, UpdateViewRequest,
  CreateLabelRequest, UpdateLabelRequest,
  CreateRuleRequest, UpdateRuleRequest,
} from "./requests.js";
import {
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

export type { CreateViewRequest, UpdateViewRequest, CreateLabelRequest, UpdateLabelRequest, CreateRuleRequest, UpdateRuleRequest };

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
  // Arcs & Signals
  // -------------------------------------------------------------------------
  registerArcsRoutes(app, { arcDb, accountDb, logger, draftSendDispatcher, schedulerClient, emailService, rsvpComposer, postApprovalCalendarDeps, signalReprocessor, s3Client, emailBucket, contentCdnBaseUrl, authz, err, route });

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
