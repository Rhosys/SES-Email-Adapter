// Reusable integration test harness.
//
// Wires the shared IntegrationCompositeRoot (real Hono app + DynamoDB tables
// pre-provisioned by Tofu — see tests-integration/infrastructure/) and a local
// Ed25519 JWKS server that stands in for Authress.
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

import type { AccessService } from '../src/api/app.js';
import { startMockAuthressServer } from './mock-authress.js';
import type { MockAuthressServer } from './mock-authress.js';
import { IntegrationCompositeRoot } from './integration-composite-root.js';

// ---------------------------------------------------------------------------
// Harness interface
// ---------------------------------------------------------------------------

export interface IntegrationHarness {
  root: IntegrationCompositeRoot;
  app: IntegrationCompositeRoot['app'];
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

  const root = new IntegrationCompositeRoot();

  return {
    root,
    app: root.app,
    mockAuthress,
    access: root.access,
    async teardown() {
      mockAuthress.close();
    },
  };
}
