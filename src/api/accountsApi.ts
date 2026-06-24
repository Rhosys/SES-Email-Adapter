import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { DateTime } from "luxon";
import { generateAccountId } from "../utils/id.js";
import { zParse } from "./validate.js";
import { toApiAccount } from "./transform.js";
import { aggregateStatsRows } from "../database/stats-writer.js";
import { isValidEmail } from "../email/validate-email.js";
import { renderTemplate } from "../email/template-renderer.js";
import { buildEmailTags } from "../email/tag-sanitizer.js";
import { buildUnsubscribeHeaders } from "../email/unsubscribe-headers.js";
import { generateUnsubscribeToken } from "../email/unsubscribe-token.js";
import { UpdateAccountRequest, InviteUserRequest, UpdateUserRequest } from "./requests.js";
import { Account as AccountSchema, ErrorCode, Pagination as PaginationSchema } from "./schemas.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";
import type { AccessService } from "./app.js";
import type { AppEnv } from "./app.js";
import type { Account, Pagination } from "../types/index.js";
import type { EmailService } from "../email/email-service.js";

type ErrorCodeLiteral = z.infer<typeof ErrorCode>;

const MAIL_DOMAIN = process.env["MAIL_DOMAIN"] ?? "platform.email.rhosys.cloud";
const API_DOMAIN = process.env["API_DOMAIN"] ?? "";
const KMS_KEY_ARN = process.env["AUTHRESS_KMS_KEY_ARN"] ?? "";
const KEY_ID = process.env["AUTHRESS_KEY_ID"] ?? "";

export interface AccountsApiDeps {
  accountDb: AccountDatabase;
  access: AccessService;
  logger: Logger;
  accountCreationStarter: { start(accountId: string, email: string): Promise<void> };
  emailService: EmailService;
  appBaseUrl: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authz: (permission: string, resourceUri: string | ((c: Context<AppEnv>) => string)) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  err: (c: Context<AppEnv>, status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 501 | 503, title: string, errorCode?: ErrorCodeLiteral, details?: unknown) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  route: (config: any) => any;
}

function page<K extends string, T>(key: K, items: T[], nextCursor?: string): Record<K, T[]> & { pagination: Pagination } {
  return { [key]: items, pagination: { cursor: nextCursor ?? null } } as Record<K, T[]> & { pagination: Pagination };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerAccountsRoutes(app: OpenAPIHono<any>, deps: AccountsApiDeps): void {
  const { accountDb, access, logger, accountCreationStarter, emailService, appBaseUrl, authz, err, route } = deps;

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

    // Validate forwardingTargetId references a verified forwarding address
    if (body.digest) {
      const targetResult = await accountDb.getVerifiedForwardingAddress(accountId, body.digest.forwardingTargetId);
      if (targetResult.isErr()) return err(c, 500, "Internal Server Error");
      if (!targetResult.value || targetResult.value.status !== "verified") {
        return err(c, 422, "Forwarding target not found or not verified", "UNVERIFIED_FORWARD_TARGET");
      }
    }

    // Merge onboarding sub-object with existing to avoid overwriting fields not sent
    if (body.onboarding) {
      const existingResult = await accountDb.getAccount(accountId);
      if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
      const existing = existingResult.value;
      body.onboarding = { ...existing?.onboarding, ...body.onboarding };
    }

    const updateResult = await accountDb.updateAccount(accountId, body as Partial<Pick<Account, "name" | "retentionDuration" | "digest" | "filtering" | "onboarding" | "afterSendAction">>);
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
    return c.json(aggregateStatsRows(statsResult.value), 200);
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

    // Load account for name in subject
    const accountResult = await accountDb.getAccount(accountId);
    if (accountResult.isErr()) return err(c, 500, "Internal Server Error");
    const account = accountResult.value;
    const accountName = account?.name ?? accountId;

    const fullDate = DateTime.utc().toISODate()!;
    const triggerId = `invite-${inviteId}`;

    const unsubscribeCode = await generateUnsubscribeToken({
      accountId,
      forwardingTargetId: accountId,
      emailType: "team-invite",
      apiDomain: API_DOMAIN,
      kmsKeyArn: KMS_KEY_ARN,
      keyId: KEY_ID,
    });

    const htmlBody = await renderTemplate("team-invite", {
      accountName,
      inviteUrl,
      unsubscribeCode,
      domain: appBaseUrl.replace(/^https?:\/\//, ""),
      emailType: "team-invite",
    });

    const tags = buildEmailTags({
      accountId,
      fullDate,
      invocationId: logger.getInvocationId(),
      triggerId,
    });
    const headers = buildUnsubscribeHeaders(accountId, API_DOMAIN, unsubscribeCode);

    const textBody = `You've been invited to join ${accountName} on Numaeel.\n\nAccept your invite: ${inviteUrl}\n\nView your account: ${appBaseUrl}/a/`;
    const sendResult = await emailService.send({
      to: body.email,
      subject: `You've been invited to join ${accountName} on Numaeel`,
      textBody,
      htmlBody,
      headers,
      tags,
      fromOverride: `"Numaeel" <noreply@${MAIL_DOMAIN}>`,
      accountId,
    });

    if (sendResult.isErr()) {
      logger.warn("Team invite email send failed (transient SES error).", {
        code: "invite.email_send_failed",
        accountId,
        email: body.email,
        inviteId,
      });
      return err(c, 503, "Email delivery temporarily unavailable");
    }

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
}
