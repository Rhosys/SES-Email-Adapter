import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { EmailContentStore } from "./content-store.js";
import type { AuditDatabase } from "../database/audit-database.js";
import type { ThreadDatabase } from "../database/thread-database.js";
import type { ResourceDatabase } from "../database/resource-database.js";
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
import type { Result } from "neverthrow";
import type { AuthError } from "../errors.js";

import type { AccessService } from "./accountsApi.js";
import type { JobDispatcher } from "./adminApi.js";
import type { SignalReprocessor } from "./threadsApi.js";
import type { IForwardingService } from "../forwarding/forwarding-service.js";
import type { EmbeddingGenerator } from "../embedding/embedding-generator.js";
import type { ThreadMatcher } from "../database/thread-matcher.js";
import type { GmailProvider } from "../external-exchanges/gmail-provider.js";
import type { OutlookProvider } from "../external-exchanges/outlook-provider.js";
import type { ProviderAdapter } from "../external-exchanges/provider-adapter.js";
import type { EncryptionManager } from "../secrets/encryption-manager.js";
import type { SignalQueue } from "../messaging/signal-queue.js";

import { WellKnownApi } from "./wellKnownApi.js";
import { AccountsApi } from "./accountsApi.js";

import { ViewsApi } from "./viewsApi.js";
import { LabelsApi } from "./labelsApi.js";
import { RulesApi } from "./rulesApi.js";
import { DomainsApi } from "./domainsApi.js";
import { AliasesApi } from "./aliasesApi.js";
import { TemplatesApi } from "./templatesApi.js";
import { AuditApi } from "./auditApi.js";
import { AdminApi } from "./adminApi.js";
import type { HealthCheckValidatorPort } from "./adminApi.js";
import { UnsubscribeApi } from "./unsubscribeApi.js";
import type { UnsubscribeTokenGenerator } from "../email/unsubscribe-token-generator.js";
import { ExternalExchangesApi } from "./externalExchangesApi.js";
import type { ExchangesDatabase } from "../database/exchanges-database.js";
import type { JmapAdapter } from "../external-exchanges/jmap-adapter.js";
import { ThreadsApi } from "./threadsApi.js";
import { ResourcesApi } from "./resourcesApi.js";
import { SignalsApi } from "./signalsApi.js";
import { UserApi } from "./userApi.js";

import { authorizationGuard, ROUTE_NOT_FOUND_KEY } from "./authorization-guard.js";
import { createAuthorize } from "./authorization-middleware.js";
import { ErrorResponse, ErrorCode } from "./schemas.js";

export type { AppEnv } from "./route-helpers.js";
export type { EmailContentStore } from "./content-store.js";
export type { AccessService, AccountRole, AccountUser, UserProfile } from "./accountsApi.js";
export type { JobDispatcher } from "./adminApi.js";
export type { SignalReprocessor } from "./threadsApi.js";
export type { ListThreadsParams } from "./threadsApi.js";
export type { IForwardingService } from "../forwarding/forwarding-service.js";
export type { CreateViewRequest, UpdateViewRequest, CreateLabelRequest, UpdateLabelRequest, CreateRuleRequest, UpdateRuleRequest } from "./requests.js";

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
// App factory
// ---------------------------------------------------------------------------

export interface AppDeps {
  threadDb: ThreadDatabase;
  resourceDb: ResourceDatabase;
  accountDb: AccountDatabase;
  exchangesDb: ExchangesDatabase;
  auditDb: AuditDatabase;
  auth: AuthService;
  access: AccessService;
  logger: Logger;
  forwardingService: IForwardingService;
  jobDispatcher: JobDispatcher;
  healthCheckValidator: HealthCheckValidatorPort;
  signalReprocessor: SignalReprocessor;
  draftSendDispatcher: DraftSendDispatcher;
  accountCreationStarter: { start(accountId: string, email: string): Promise<void> };
  contentCdnBaseUrl: string;
  astValidator: UserCodeExecutorClient;
  billingHandler: BillingHandler;
  emailService: EmailService;
  domainIdentityService: DomainIdentityService;
  rsvpComposer: typeof SendRsvpFn;
  postApprovalCalendarDeps: PostApprovalCalendarHandlerDeps;
  schedulerClient: SchedulerClient;
  emailContentStore: EmailContentStore;
  triggerDigest: (accountId: string) => Promise<void>;
  embeddingGenerator: EmbeddingGenerator;
  threadMatcher: ThreadMatcher;
  unsubscribeTokenGenerator: UnsubscribeTokenGenerator;
  gmailProvider: GmailProvider;
  outlookProvider: OutlookProvider;
  adapters: Record<string, ProviderAdapter>;
  encryptionManager: EncryptionManager;
  getProviderToken: (userId: string, connectionId: string, connectionUserId: string) => Promise<string>;
  signalQueue: SignalQueue;
  jmapAdapter: JmapAdapter;
}

export function createApp({ threadDb, resourceDb, accountDb, exchangesDb, auditDb, auth, access, logger, forwardingService, jobDispatcher, healthCheckValidator, signalReprocessor, draftSendDispatcher, accountCreationStarter, contentCdnBaseUrl, astValidator, billingHandler, emailService, domainIdentityService, rsvpComposer, postApprovalCalendarDeps, schedulerClient, emailContentStore, triggerDigest, embeddingGenerator, threadMatcher, unsubscribeTokenGenerator, gmailProvider, outlookProvider, adapters, encryptionManager, signalQueue, jmapAdapter }: AppDeps) {
  type AppEnv = { Variables: { auth: AuthContext; authorizationVerified?: boolean; [ROUTE_NOT_FOUND_KEY]?: boolean } };
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const flat = result.error.flatten();
        const fieldErrors = flat.fieldErrors;
        const fields = Object.keys(fieldErrors);
        const title = fields.length > 0
          ? `Invalid ${result.target}: ${fields.join(", ")} ${fields.length === 1 ? "is" : "are"} invalid`
          : `Invalid ${result.target}`;
        return c.json({ title, errorCode: "INVALID_REQUEST", details: flat }, 400);
      }
    },
  });

  // Shared error responses
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
  type ErrorBody = { title: string; errorCode?: ErrorCodeLiteral; details?: unknown };

  function err<S extends ErrorStatus>(c: Context<AppEnv>, status: S, title: string, errorCode?: ErrorCodeLiteral, details?: unknown) {
    logger.info("API error response", { code: "api.error", method: c.req.method, path: c.req.path, status, title, errorCode, details });
    return c.json(
      { title, ...(errorCode ? { errorCode } : {}), ...(details !== undefined ? { details } : {}) } as ErrorBody,
      status,
    );
  }

  const route = <const R extends Parameters<typeof createRoute>[0]>(config: R) =>
    createRoute({ ...config, responses: { ...errResponses, ...config.responses } } as unknown as R & { responses: R["responses"] & typeof errResponses });

  // Per-route authorization middleware factory
  const authorize = access ? createAuthorize(access, logger) : null;

  function authz(permission: string, resourceUri: string | ((c: Context<AppEnv>) => string)): ReturnType<NonNullable<typeof authorize>> {
    if (authorize) {
      return authorize(permission, resourceUri as string | ((c: Context) => string));
    }
    return async (c, next) => {
      c.set("authorizationVerified", true);
      await next();
    };
  }

  const helpers = { authz, err, route };

  // Public routes — no authorization required (discoverable metadata)
  app.use("/healthcheck", async (c, next) => { c.set("authorizationVerified", true); await next(); });
  app.use("/.well-known/*", async (c, next) => { c.set("authorizationVerified", true); await next(); });
  app.use("/", async (c, next) => {
    if (c.req.method === "GET") c.set("authorizationVerified", true);
    await next();
  });

  // Well-known routes (before auth middleware)
  new WellKnownApi().register(app, helpers);

  // Device ID cookie — generate and set if not present (httpOnly, Secure, 10yr, .numaeel.com)
  const DEVICE_COOKIE = "numaeel-device-id";
  app.use("*", async (c, next) => {
    const cookies = c.req.header("cookie") ?? "";
    const existing = cookies.match(new RegExp(`(?:^|;\\s*)${DEVICE_COOKIE}=([^;]+)`));
    if (!existing) {
      const deviceId = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      c.header("Set-Cookie", `${DEVICE_COOKIE}=${deviceId}; Path=/; Domain=.numaeel.com; Max-Age=315360000; HttpOnly; Secure; SameSite=Lax`);
    }
    await next();
  });

  // Attach x-request-id header to every response and errorId to 4XX/5XX JSON bodies
  app.use("*", async (c, next) => {
    await next();
    const requestId = logger.getInvocationId();
    c.res.headers.set("x-request-id", requestId);

    if (c.res.status >= 400 && c.res.headers.get("content-type")?.includes("application/json")) {
      const body = await c.res.json() as Record<string, unknown>;
      body["errorId"] = requestId;
      c.res = Response.json(body, { status: c.res.status, headers: c.res.headers });
    }
  });

  // RequestLogger — log every API request/response
  app.use("*", async (c, next) => {
    const start = Date.now();
    const body = c.req.method !== "GET" && c.req.method !== "HEAD"
      ? await c.req.raw.clone().text()
      : undefined;

    // Fires on its own clock at the 25s mark regardless of whether next() ever settles —
    // a stuck downstream handler would never reach code after `await next()`, since the
    // await itself never returns. This is a plain timer, not a check after the await,
    // precisely so it still fires even if the request hangs all the way to Lambda timeout.
    const slowRequestTimer = setTimeout(() => {
      logger.track("Request exceeded 25s — at risk of Lambda timeout.", { code: "api.slow_request", method: c.req.method, path: c.req.path, elapsedMs: Date.now() - start });
    }, 25_000);

    try {
      await next();
    } finally {
      clearTimeout(slowRequestTimer);
    }

    const elapsed = Date.now() - start;
    const status = c.res.status;

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
    // Public one-click unsubscribe (RFC 8058) — no bearer token; the signed code is the credential
    if (c.req.method === "POST" && /^\/accounts\/[^/]+\/unsubscribe$/.test(c.req.path)) {
      await next();
      return;
    }

    // Public webhook endpoints — provider-verified at application layer (OIDC JWT in handler)
    if (c.req.method === "POST" && c.req.path.startsWith("/external-exchanges/")) {
      await next();
      return;
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

  // -------------------------------------------------------------------------
  // JMAP push webhook handler (public — verified by HMAC token in JmapAdapter)
  // -------------------------------------------------------------------------
  async function handleJmapWebhook(c: Context<AppEnv>): Promise<Response> {
    const token = c.req.query("token");

    let body: Record<string, unknown>;
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      return c.json({ title: "Bad Request" }, 400);
    }

    const result = await jmapAdapter.handleWebhook(body, token ?? "");
    return c.json({}, result.isOk() ? 200 : 400);
  }

  // -------------------------------------------------------------------------
  // Webhook routes (public — provider-verified at application layer)
  // -------------------------------------------------------------------------
  app.post("/external-exchanges/:platform/target", async (c) => {
    const platform = c.req.param("platform");

    if (platform === "gmail") {
      const response = await gmailProvider.handle(c);
      c.set("authorizationVerified", true);
      return response;
    }

    if (platform === "outlook") {
      const response = await outlookProvider.handle(c);
      c.set("authorizationVerified", true);
      return response;
    }

    if (platform === "jmap") {
      const response = await handleJmapWebhook(c);
      c.set("authorizationVerified", true);
      return response;
    }

    return c.json({ title: "Not Found" }, 404);
  });

  // -------------------------------------------------------------------------
  // Route registrations
  // -------------------------------------------------------------------------
  new AccountsApi(accountDb, access, logger, accountCreationStarter, emailService, triggerDigest).register(app, helpers);
  new ThreadsApi(threadDb, accountDb, logger, draftSendDispatcher, schedulerClient, emailService, rsvpComposer, postApprovalCalendarDeps, signalReprocessor, emailContentStore, contentCdnBaseUrl, embeddingGenerator, threadMatcher, signalQueue).register(app, helpers);
  new ResourcesApi(resourceDb, logger, contentCdnBaseUrl).register(app, helpers);
  new SignalsApi(threadDb, accountDb, logger, postApprovalCalendarDeps, contentCdnBaseUrl).register(app, helpers);
  new ViewsApi(accountDb, logger).register(app, helpers);
  new LabelsApi(accountDb, logger).register(app, helpers);
  new RulesApi(accountDb, auditDb, astValidator, billingHandler, logger).register(app, helpers);
  new DomainsApi(accountDb, auditDb, domainIdentityService, logger).register(app, helpers);
  new AliasesApi(accountDb, auditDb, logger, forwardingService).register(app, helpers);
  new TemplatesApi(accountDb, auditDb, astValidator, logger).register(app, helpers);
  new AuditApi(auditDb, logger).register(app, helpers);
  new AdminApi(jobDispatcher, healthCheckValidator).register(app, helpers);
  new UnsubscribeApi(unsubscribeTokenGenerator, accountDb, logger).register(app, helpers);
  new UserApi(accountDb, access, logger).register(app, helpers);
  // Resolved per call, not bound at construction: `access` is optional here (see the
  // `authorize` guard above), and only the OAuth connect path ever reaches this.
  new ExternalExchangesApi(accountDb, exchangesDb, adapters, (userId, connectionId) => access.getLinkedIdentity(userId, connectionId), encryptionManager, signalQueue, logger).register(app, helpers);

  // ---------------------------------------------------------------------------
  // Not Found & Method Not Allowed — must be registered after all routes
  // ---------------------------------------------------------------------------

  app.notFound((c) => {
    c.set(ROUTE_NOT_FOUND_KEY, true);

    const requestMethod = c.req.method;
    const requestPath = c.req.path;

    const registeredMethods = new Set<string>();
    for (const r of app.routes) {
      if (r.method === "ALL") continue;
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
