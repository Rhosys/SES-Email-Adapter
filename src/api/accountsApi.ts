import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
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
import type { Account, Pagination } from "../types/index.js";
import type { EmailService } from "../email/email-service.js";
import type { Result } from "neverthrow";
import type { AuthressServiceError } from "../errors.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";

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

const MAIL_DOMAIN = process.env["MAIL_DOMAIN"] ?? "platform.email.rhosys.cloud";
const API_DOMAIN = process.env["API_DOMAIN"] ?? "";
const KMS_KEY_ARN = process.env["AUTHRESS_KMS_KEY_ARN"] ?? "";
const KEY_ID = process.env["AUTHRESS_KEY_ID"] ?? "";

function page<K extends string, T>(key: K, items: T[], nextCursor?: string): Record<K, T[]> & { pagination: Pagination } {
  return { [key]: items, pagination: { cursor: nextCursor ?? null } } as Record<K, T[]> & { pagination: Pagination };
}

export class AccountsApi {
  constructor(
    private readonly accountDb: AccountDatabase,
    private readonly access: AccessService,
    private readonly logger: Logger,
    private readonly accountCreationStarter: { start(accountId: string, email: string): Promise<void> },
    private readonly emailService: EmailService,
    private readonly appBaseUrl: string,
    private readonly triggerDigest: (accountId: string) => Promise<void>,
  ) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { accountDb, access, logger, accountCreationStarter, emailService, appBaseUrl } = this;

    app.openapi(route({
      method: "get",
      path: "/accounts",
      tags: ["Accounts"],
      responses: { 200: { content: { "application/json": { schema: z.object({ accounts: z.array(AccountSchema) }) } }, description: "List accounts" } },
    }), async (c) => {
      const { userId } = c.get("auth");
      if (!access) { logger.error("Service dependency not available.", { code: "api.accounts.list.not_configured" }); return err(c, 501, "Not implemented"); }
      const usersResult = await access.listAccountsForUser(userId);
      if (usersResult.isErr()) { logger.error("Failed to list accounts for user.", { code: "api.accounts.list_failed", error: usersResult.error }); return err(c, 500, "Internal Server Error"); }
      const accountIds = usersResult.value;
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
      responses: { 201: { content: { "application/json": { schema: AccountSchema } }, description: "Account created" } },
    }), async (c) => {
      const { userId } = c.get("auth");
      if (!access) { logger.error("Service dependency not available.", { code: "api.accounts.create.not_configured" }); return err(c, 501, "Not implemented"); }
      const existingResult = await access.listAccountsForUser(userId);
      if (existingResult.isErr()) { logger.error("Failed to list existing accounts for user.", { code: "api.accounts.create.list_existing_failed", error: existingResult.error }); return err(c, 500, "Internal Server Error"); }
      if (existingResult.value.length > 0) return err(c, 409, "Account already exists", "ACCOUNT_EXISTS");
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
        if (accountCreationStarter) {
          await accountCreationStarter.start(candidate.id, userId);
        }
        const createResult = await accountDb.createAccount(candidate);
        if (createResult.isOk()) {
          account = candidate;
          break;
        }
      }
      if (!account) { logger.error("Failed to create account after 5 attempts.", { code: "api.accounts.create.exhausted_retries", userId }); return err(c, 500, "Internal Server Error"); }
      const accessResult = await access.addUser(account.id, userId, "admin");
      if (accessResult.isErr()) {
        logger.error("Failed to create Authress access record for new account.", { code: "api.account_create.authress_failed", userId, accountId: account.id, error: accessResult.error });
        return err(c, 500, "Internal Server Error");
      }
      return c.json(toApiAccount(account), 201);
    });

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
      if (accountResult.isErr()) { logger.error("Failed to get account.", { code: "api.accounts.get_failed", accountId, error: accountResult.error }); return err(c, 500, "Internal Server Error"); }
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
      if (body.digest) {
        const targetResult = await accountDb.getForwardingTarget(accountId, body.digest.forwardingTargetId);
        if (targetResult.isErr()) { logger.error("Failed to get forwarding target for digest.", { code: "api.accounts.patch.get_target_failed", accountId, error: targetResult.error }); return err(c, 500, "Internal Server Error"); }
        if (!targetResult.value || targetResult.value.status !== "verified") {
          return err(c, 422, "Forwarding target not found or not verified", "UNVERIFIED_FORWARD_TARGET");
        }
      }
      if (body.defaultCalendarInviteForwardingTargetId) {
        const targetResult = await accountDb.getForwardingTarget(accountId, body.defaultCalendarInviteForwardingTargetId);
        if (targetResult.isErr()) { logger.error("Failed to get forwarding target for calendar.", { code: "api.accounts.patch.get_target_failed", accountId, error: targetResult.error }); return err(c, 500, "Internal Server Error"); }
        if (!targetResult.value || targetResult.value.status !== "verified") {
          return err(c, 422, "Calendar forwarding address must be a verified forwarding address", "UNVERIFIED_CALENDAR_TARGET");
        }
      }

      // Read existing digest to detect changes
      let previousDigest: { frequency: string; forwardingTargetId: string } | null | undefined;
      if (body.digest !== undefined) {
        const existingResult = await accountDb.getAccount(accountId);
        if (existingResult.isOk()) {
          previousDigest = existingResult.value?.digest;
        }
      }

      if (body.onboarding) {
        const existingResult = await accountDb.getAccount(accountId);
        if (existingResult.isErr()) { logger.error("Failed to get existing account for patch.", { code: "api.accounts.patch.get_existing_failed", accountId, error: existingResult.error }); return err(c, 500, "Internal Server Error"); }
        const existing = existingResult.value;
        body.onboarding = { ...existing?.onboarding, ...body.onboarding };
      }
      const updateResult = await accountDb.updateAccount(accountId, body as Partial<Pick<Account, "name" | "retentionDuration" | "digest" | "filtering" | "onboarding" | "defaultCalendarInviteForwardingTargetId">>);
      if (updateResult.isErr()) { logger.error("Failed to update account.", { code: "api.accounts.patch.update_failed", accountId, error: updateResult.error }); return err(c, 500, "Internal Server Error"); }

      // Trigger immediate digest only on frequency increase or target change
      const FREQ_RANK: Record<string, number> = { monthly: 0, weekly: 1, daily: 2 };
      if (body.digest && (
        previousDigest?.forwardingTargetId !== body.digest.forwardingTargetId ||
        (FREQ_RANK[body.digest.frequency] ?? 0) > (FREQ_RANK[previousDigest?.frequency ?? ""] ?? 0)
      )) {
        void this.triggerDigest(accountId).then(undefined, e => {
          logger.warn("Failed to trigger immediate digest after config change", { code: "accounts.digest_trigger_failed", accountId, error: e });
        });
      }

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
      if (statsResult.isErr()) { logger.error("Failed to get account stats.", { code: "api.accounts.stats_failed", accountId, error: statsResult.error }); return err(c, 500, "Internal Server Error"); }
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
      if (!access) { logger.error("Service dependency not available.", { code: "api.users.list.not_configured" }); return err(c, 501, "Not implemented"); }
      const accountId = c.req.param("accountId")!;
      const result = await access.listUsers(accountId);
      if (result.isErr()) {
        logger.warn("Authress service unavailable while listing account users.", { code: "api.authress_unavailable", accountId, error: result.error });
        return err(c, 503, "Service temporarily unavailable");
      }
      const users = result.value;
      const profiles = await Promise.all(users.map(async (u) => {
        const profileResult = await access.getUserProfile(u.userId);
        if (profileResult.isErr()) {
          logger.track("Failed to fetch user profile from Authress — returning user without profile data", { code: "accounts.authress_profile_fetch_failed", userId: u.userId, error: profileResult.error });
          return u;
        }
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
      if (!access) { logger.error("Service dependency not available.", { code: "api.users.update.not_configured" }); return err(c, 501, "Not implemented"); }
      const accountId = c.req.param("accountId")!;
      const body = await zParse(InviteUserRequest, c.req.raw);
      if (!isValidEmail(body.email, logger)) {
        return err(c, 400, "Invalid email address", "INVALID_EMAIL");
      }
      const inviteResult = await access.createInvite(accountId, body.email, body.role);
      if (inviteResult.isErr()) {
        logger.track("Authress invite creation failed. The Authress API rejected the invite request.", { code: "invite.authress_creation_failed", accountId, email: body.email, error: inviteResult.error });
        return err(c, 422, "Failed to create invite", "INVITE_CREATION_FAILED");
      }
      const { inviteId } = inviteResult.value;
      const inviteUrl = `${appBaseUrl}/invite?inviteId=${inviteId}`;
      const accountResult = await accountDb.getAccount(accountId);
      if (accountResult.isErr()) { logger.error("Failed to get account for invite.", { code: "api.users.invite.get_account_failed", accountId, error: accountResult.error }); return err(c, 500, "Internal Server Error"); }
      const account = accountResult.value;
      const accountName = account?.name ?? accountId;
      const fullDate = DateTime.utc().toISODate()!;
      const triggerId = `invite-${inviteId}`;
      const unsubscribeCode = await generateUnsubscribeToken({ accountId, forwardingTargetId: accountId, emailType: "team-invite", apiDomain: API_DOMAIN, kmsKeyArn: KMS_KEY_ARN, keyId: KEY_ID });
      const htmlBody = await renderTemplate("team-invite", { accountName, inviteUrl, unsubscribeCode, domain: appBaseUrl.replace(/^https?:\/\//, ""), emailType: "team-invite" });
      const tags = buildEmailTags({ accountId, fullDate, invocationId: logger.getInvocationId(), triggerId });
      const headers = buildUnsubscribeHeaders(accountId, API_DOMAIN, unsubscribeCode);
      const textBody = `You've been invited to join ${accountName} on Numaeel.\n\nAccept your invite: ${inviteUrl}\n\nView your account: ${appBaseUrl}/a/`;
      const sendResult = await emailService.send({ to: body.email, subject: `You've been invited to join ${accountName} on Numaeel`, textBody, htmlBody, headers, tags, fromOverride: `"Numaeel" <noreply@${MAIL_DOMAIN}>`, accountId });
      if (sendResult.isErr()) {
        logger.warn("Team invite email send failed (transient SES error).", { code: "invite.email_send_failed", accountId, email: body.email, inviteId });
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
      if (!access) { logger.error("Service dependency not available.", { code: "api.users.update.not_configured" }); return err(c, 501, "Not implemented"); }
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
      if (!access) { logger.error("Service dependency not available.", { code: "api.users.delete.not_configured" }); return err(c, 501, "Not implemented"); }
      const accountId = c.req.param("accountId")!;
      const result = await access.removeUser(accountId, c.req.param("userId")!);
      if (result.isErr()) {
        logger.warn("Authress service unavailable while removing user.", { code: "api.authress_unavailable", accountId, userId: c.req.param("userId")!, error: result.error });
        return err(c, 503, "Service temporarily unavailable");
      }
      return new Response(null, { status: 204 });
    });
  }
}
