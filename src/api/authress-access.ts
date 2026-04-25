import { AuthressClient } from "@authress/sdk";
import type { AccessRecord } from "@authress/sdk";
import type { AccessService, AccountUser, AccountRole } from "./app.js";

const AUTHRESS_DOMAIN = process.env["AUTHRESS_DOMAIN"] ?? "";
const AUTHRESS_SERVICE_CLIENT_ACCESS_KEY = process.env["AUTHRESS_SERVICE_CLIENT_ACCESS_KEY"] ?? "";

const ACCOUNT_ROLES: AccountRole[] = ["owner", "admin", "member", "viewer"];

let _client: AuthressClient | null = null;

function getClient(): AuthressClient {
  if (!_client) {
    _client = new AuthressClient({ authressApiUrl: AUTHRESS_DOMAIN }, AUTHRESS_SERVICE_CLIENT_ACCESS_KEY);
  }
  return _client;
}

function roleToRoleId(role: AccountRole): string {
  return `account:${role}`;
}

function roleIdToRole(roleId: string): AccountRole | null {
  const r = roleId.replace("account:", "");
  return ACCOUNT_ROLES.includes(r as AccountRole) ? (r as AccountRole) : null;
}

function parseUsers(record: AccessRecord): AccountUser[] {
  const users: AccountUser[] = [];
  for (const stmt of record.statements) {
    const roleId = stmt.roles[0];
    if (!roleId) continue;
    const role = roleIdToRole(roleId);
    if (!role) continue;
    for (const user of stmt.users ?? []) {
      users.push({ userId: user.userId, role });
    }
  }
  return users;
}

export class AuthressAccessService implements AccessService {
  private get client() {
    return getClient();
  }

  async listUsers(accountId: string): Promise<AccountUser[]> {
    try {
      const response = await this.client.accessRecords.getRecord(`account-${accountId}`);
      return parseUsers(response.data);
    } catch {
      return [];
    }
  }

  async addUser(accountId: string, userId: string, role: AccountRole): Promise<void> {
    await this._upsertUser(accountId, userId, role);
  }

  async updateUserRole(accountId: string, userId: string, role: AccountRole): Promise<void> {
    await this._upsertUser(accountId, userId, role);
  }

  async removeUser(accountId: string, userId: string): Promise<void> {
    const recordId = `account-${accountId}`;
    let record: AccessRecord;
    try {
      const response = await this.client.accessRecords.getRecord(recordId);
      record = response.data;
    } catch {
      return;
    }

    const statements = record.statements
      .map((stmt) => ({ ...stmt, users: (stmt.users ?? []).filter((u) => u.userId !== userId) }))
      .filter((stmt) => (stmt.users ?? []).length > 0);

    await this.client.accessRecords.updateRecord(recordId, { ...record, statements });
  }

  async checkAccess(userId: string, accountId: string, permission: string): Promise<void> {
    await this.client.userPermissions.authorizeUser(userId, `accounts/${accountId}`, permission);
  }

  private async _upsertUser(accountId: string, userId: string, role: AccountRole): Promise<void> {
    const recordId = `account-${accountId}`;
    const resourceUri = `accounts/${accountId}`;
    const roleId = roleToRoleId(role);

    let existing: AccessRecord | null = null;
    try {
      const response = await this.client.accessRecords.getRecord(recordId);
      existing = response.data;
    } catch { /* record doesn't exist yet — will create */ }

    if (!existing) {
      await this.client.accessRecords.createRecord({
        recordId,
        name: `Account ${accountId}`,
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

    await this.client.accessRecords.updateRecord(recordId, { ...existing, statements });
  }
}
