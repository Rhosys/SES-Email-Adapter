import { AuthressClient } from "@authress/sdk";
import { KmsServiceClientTokenProvider } from "@authress/sdk";
import type { AccessRecord, Invite } from "@authress/sdk";
import { ok, err, authressServiceError } from "../errors.js";
import type { AuthressServiceError, Result } from "../errors.js";
import type { AccessService, AccountUser, AccountRole } from "./app.js";

const AUTHRESS_API_URL = "https://login.rhosys.cloud";
export const AUTHRESS_APP_ID = "app_2EAWGEdtzaeCj7b45DsDtt";

const AUTHRESS_KMS_KEY_ARN = process.env["AUTHRESS_KMS_KEY_ARN"] ?? "";
const AUTHRESS_CLIENT_ID = "sc_a9RdHnQzsXJeAzTJgaGf98v";
const AUTHRESS_KEY_ID = process.env["AUTHRESS_KEY_ID"] ?? "";
const AUTHRESS_ACCOUNT_ID = "acc-g017y29d874dh";

const ACCOUNT_ROLES: AccountRole[] = ["admin", "member", "viewer"];

const ROLE_TO_ID: Record<AccountRole, string> = {
  admin: "ro_ag2b0hrztp7n84b25qxqijwewm",
  member: "ro_bvy5r9ri47n23zu4n7u6bgj0jx",
  viewer: "ro_a4d58mfmq074p8hdy4s7whwa0e",
};

const ID_TO_ROLE = new Map<string, AccountRole>(
  Object.entries(ROLE_TO_ID).map(([role, id]) => [id, role as AccountRole]),
);

let _client: AuthressClient | null = null;

function getClient(): AuthressClient {
  if (!_client) {
    const tokenProvider = new KmsServiceClientTokenProvider({
      kmsKeyArn: AUTHRESS_KMS_KEY_ARN,
      clientId: AUTHRESS_CLIENT_ID,
      keyId: AUTHRESS_KEY_ID,
      authressAccountId: AUTHRESS_ACCOUNT_ID,
    });
    _client = new AuthressClient({ authressApiUrl: AUTHRESS_API_URL }, tokenProvider);
  }
  return _client;
}

function roleToRoleId(role: AccountRole): string {
  return ROLE_TO_ID[role];
}

function roleIdToRole(roleId: string): AccountRole | null {
  return ID_TO_ROLE.get(roleId) ?? null;
}

function recordId(accountId: string): string {
  return `email:account-${accountId}`;
}

function isNotFound(e: unknown): boolean {
  const status = (e as { status?: number }).status
    ?? (e as { response?: { status?: number } }).response?.status;
  return status === 404;
}

export class AuthressAccessService implements AccessService {
  private get client() {
    return getClient();
  }

  async listAccountsForUser(userId: string): Promise<Result<string[], AuthressServiceError>> {
    try {
      const response = await this.client.userPermissions.getUserResources(userId, "accounts", undefined, undefined, "accounts:read");
      const accountIds = (response.data.resources ?? [])
        .map((r) => r.resourceUri.replace(/^accounts\//, ""))
        .filter((id) => id.length > 0);
      return ok(accountIds);
    } catch (e) {
      if (isNotFound(e)) return ok([]);
      return err(authressServiceError(e));
    }
  }

  async listUsers(accountId: string): Promise<Result<AccountUser[], AuthressServiceError>> {
    try {
      try {
        // Aggregates across every AccessRecord granting this resource (not just our
        // canonical named record), so users whose grant landed in an Authress-generated
        // record (e.g. via invite-accept) still show up here.
        const response = await this.client.resources.getResourceUsers(`accounts/${accountId}`);
        const users: AccountUser[] = [];
        for (const u of response.data.users) {
          const roleId = u.roles[0]?.roleId;
          const role = roleId ? roleIdToRole(roleId) : null;
          if (!role) continue;
          users.push({ userId: u.userId, role });
        }
        return ok(users);
      } catch (e) {
        if (isNotFound(e)) return ok([]);
        throw e;
      }
    } catch (e) {
      return err(authressServiceError(e));
    }
  }

  async getUserProfile(userId: string): Promise<Result<{ name?: string; email?: string; picture?: string }, AuthressServiceError>> {
    try {
      const response = await this.client.users.getUser(userId);
      const { name, email, picture } = response.data;
      return ok({ ...(name ? { name } : {}), ...(email ? { email } : {}), ...(picture ? { picture } : {}) });
    } catch (e) {
      if (isNotFound(e)) return ok({});
      return err(authressServiceError(e));
    }
  }

  async addUser(accountId: string, userId: string, role: AccountRole): Promise<Result<void, AuthressServiceError>> {
    try {
      await this._upsertUser(accountId, userId, role);
      return ok(undefined);
    } catch (e) {
      return err(authressServiceError(e));
    }
  }

  async updateUserRole(accountId: string, userId: string, role: AccountRole): Promise<Result<void, AuthressServiceError>> {
    try {
      await this._upsertUser(accountId, userId, role);
      return ok(undefined);
    } catch (e) {
      return err(authressServiceError(e));
    }
  }

  async removeUser(accountId: string, userId: string): Promise<Result<void, AuthressServiceError>> {
    try {
      const rid = recordId(accountId);
      let record: AccessRecord;
      try {
        const response = await this.client.accessRecords.getRecord(rid);
        record = response.data;
      } catch (e) {
        if (isNotFound(e)) return ok(undefined);
        throw e;
      }

      const statements = record.statements
        .map((stmt) => ({ ...stmt, users: (stmt.users ?? []).filter((u) => u.userId !== userId) }))
        .filter((stmt) => (stmt.users ?? []).length > 0);

      await this.client.accessRecords.updateRecord(rid, { ...record, statements });
      return ok(undefined);
    } catch (e) {
      return err(authressServiceError(e));
    }
  }

  async checkAccess(userId: string, resourceUri: string, permission: string): Promise<void> {
    await this.client.userPermissions.authorizeUser(userId, resourceUri, permission);
  }

  async createInvite(accountId: string, email: string, role: AccountRole): Promise<Result<{ inviteId: string }, AuthressServiceError>> {
    try {
      const response = await this.client.invites.createInvite({
        statements: [{
          roles: [roleToRoleId(role)],
          resources: [{ resourceUri: `accounts/${accountId}` }],
        }],
        // Authress always attempts an automatic safe merge into an existing matching
        // AccessRecord first. If that isn't possible, it falls back to this strategy —
        // default is GENERATE_NEW_RECORD, which creates an orphaned record our
        // listUsers/removeUser/updateUserRole can't manage. Our records are always one
        // statement per role with a users list (see _upsertUser below) — merging a new
        // user into the matching role's statement never changes what any other existing
        // user is granted, so a forced merge is safe for our specific record shape.
        conflictResolutionStrategy: "UNSAFE_FORCE_MERGE" as Invite.ConflictResolutionStrategyEnum,
      });
      return ok({ inviteId: response.data.inviteId! });
    } catch (e) {
      return err(authressServiceError(e));
    }
  }

  private async _upsertUser(accountId: string, userId: string, role: AccountRole): Promise<void> {
    const rid = recordId(accountId);
    const resourceUri = `accounts/${accountId}`;
    const roleId = roleToRoleId(role);

    let existing: AccessRecord | null = null;
    try {
      const response = await this.client.accessRecords.getRecord(rid);
      existing = response.data;
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }

    if (!existing) {
      await this.client.accessRecords.createRecord({
        recordId: rid,
        name: `Email Account: ${accountId}`,
        statements: [{ roles: [roleId], resources: [{ resourceUri }], users: [{ userId }] }],
      });
      return;
    }

    // Remove user from all statements (ensures roles are mutually exclusive)
    const statements = existing.statements
      .map((stmt) => ({ ...stmt, users: (stmt.users ?? []).filter((u) => u.userId !== userId) }))
      .filter((stmt) => (stmt.users ?? []).length > 0);

    const existingStmt = statements.find((s) => s.roles.includes(roleId));
    if (existingStmt) {
      existingStmt.users = [...(existingStmt.users ?? []), { userId }];
    } else {
      statements.push({ roles: [roleId], resources: [{ resourceUri }], users: [{ userId }] });
    }

    await this.client.accessRecords.updateRecord(rid, { ...existing, statements });
  }
}
