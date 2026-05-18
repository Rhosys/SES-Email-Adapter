// Reusable integration test harness.
//
// Connects to DynamoDB tables pre-provisioned by Tofu (see deploy/integration/)
// and wires a real Hono app against them + a local Ed25519 JWKS server that
// stands in for Authress.
//
// Required env vars (CI sets these; defaults shown in parentheses):
//   AWS_ENDPOINT_URL   — MiniStack endpoint  (http://localhost:4566)
//   AWS_REGION         — AWS region          (eu-central-1)
//   AWS_ACCESS_KEY_ID  — fake cred for MiniStack
//   AWS_SECRET_ACCESS_KEY
//   ACCOUNTS_TABLE     — DynamoDB table name (from tofu output)
//   SIGNALS_TABLE
//   AUDIT_TABLE
//   AUTHRESS_API_URL   — mock JWKS server URL (http://localhost:4500)

import { AccountDatabase } from '../../src/database/account-database.js';
import { ArcDatabase } from '../../src/database/arc-database.js';
import { AuditDatabase } from '../../src/database/audit-database.js';
import { ApiDatabaseAdapter } from '../../src/database/adapters.js';
import { AuthressAuthService } from '../../src/api/authress-auth.js';
import { createApp } from '../../src/api/app.js';
import { createMockLogger } from '../helpers/mock-logger.js';
import { ok } from '../../src/errors.js';
import type { AccessService } from '../../src/api/app.js';
import { startMockAuthressServer } from './mock-authress.js';
import type { MockAuthressServer } from './mock-authress.js';

// ---------------------------------------------------------------------------
// Harness interface
// ---------------------------------------------------------------------------

export interface IntegrationHarness {
  app: ReturnType<typeof createApp>;
  mockAuthress: MockAuthressServer;
  /** Mutable stub — tests may reassign individual methods between calls. */
  access: AccessService;
  teardown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createHarness(): Promise<IntegrationHarness> {
  // Parse port from AUTHRESS_API_URL — CI sets this before the process starts
  // so AuthressAuthService reads the same value at module load time.
  const authressUrl = process.env['AUTHRESS_API_URL'] ?? 'http://localhost:4500';
  const authressPort = parseInt(new URL(authressUrl).port, 10) || 4500;
  const mockAuthress = await startMockAuthressServer(authressPort);

  const logger = createMockLogger();

  // All three databases connect to MiniStack via AWS_ENDPOINT_URL.
  // Tables were provisioned by `tofu apply` before the test runs.
  const accountDb = new AccountDatabase();
  const arcDb = new ArcDatabase(logger);
  const auditDb = new AuditDatabase();
  const store = new ApiDatabaseAdapter(arcDb, accountDb, auditDb);

  // Mutable stub — individual tests can override specific methods.
  const access: AccessService = {
    listUsers: async () => ok([]),
    listAccountsForUser: async () => ok([]),
    addUser: async () => ok(undefined),
    updateUserRole: async () => ok(undefined),
    removeUser: async () => ok(undefined),
    checkAccess: async () => { /* noop */ },
    createInvite: async () => ok({ inviteId: 'mock-invite' }),
  };

  const app = createApp({
    store,
    auth: new AuthressAuthService(),
    access,
    logger,
  });

  return {
    app,
    mockAuthress,
    access,
    async teardown() {
      mockAuthress.close();
    },
  };
}
