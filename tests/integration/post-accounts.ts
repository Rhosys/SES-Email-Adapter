// Integration test — POST /accounts
//
// Run from the repo root:
//   ACCOUNTS_TABLE=ses-email-adapter-accounts \
//   SIGNALS_TABLE=ses-email-adapter-signals \
//   AUDIT_TABLE=ses-email-adapter-audit \
//   AWS_ENDPOINT_URL=http://localhost:4566 \
//   AUTHRESS_API_URL=http://localhost:4500 \
//   npx tsx tests/integration/post-accounts.ts
//
// CI sets all env vars automatically; see .github/workflows/build.yml.

import { createHarness } from './harness.js';
import { ok } from '../../src/errors.js';

const h = await createHarness();

// ---------------------------------------------------------------------------
// Tiny assertion helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

async function assertStatus(res: Response, expected: number, label: string): Promise<void> {
  const ok = res.status === expected;
  assert(ok, `${label} (got ${res.status})`);
  if (!ok) {
    const body = await res.text().catch(() => '(unreadable)');
    console.error(`    response body: ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ── Missing Authorization header returns 401 ──────────────────────────────
{
  console.log('\nTest: POST /accounts — no Authorization header');
  const res = await h.app.request('/accounts', { method: 'POST' });
  await assertStatus(res, 401, 'returns 401');
}

// ── Invalid token returns 401 ─────────────────────────────────────────────
{
  console.log('\nTest: POST /accounts — invalid token');
  const res = await h.app.request('/accounts', {
    method: 'POST',
    headers: { Authorization: 'Bearer not-a-valid-jwt' },
  });
  await assertStatus(res, 401, 'returns 401');
}

// ── Valid token creates an account ────────────────────────────────────────
{
  console.log('\nTest: POST /accounts — valid JWT creates account');
  const token = await h.mockAuthress.createToken('user-it-001');
  const res = await h.app.request('/accounts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  await assertStatus(res, 201, 'returns 201');

  if (res.status === 201) {
    const body = await res.json() as Record<string, unknown>;
    assert(typeof body['accountId'] === 'string' && (body['accountId'] as string).startsWith('acc-'), `account id starts with 'acc-' (got ${body['accountId']})`);
    assert(body['billingPlan'] === 'Trial', `billingPlan is Trial (got ${body['billingPlan']})`);
    assert(body['onboarding'] !== undefined, 'onboarding field is present');
  }
}

// ── Second call with the same user returns 409 if user already has account ─
{
  console.log('\nTest: POST /accounts — 409 when user already has an account');
  const token = await h.mockAuthress.createToken('user-it-002');

  // Override: pretend user already has account 'acc-existing'
  const original = h.access.listAccountsForUser;
  h.access.listAccountsForUser = async () => ok(['acc-existing-001']);

  const res = await h.app.request('/accounts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  await assertStatus(res, 409, 'returns 409');

  // Restore
  h.access.listAccountsForUser = original;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

await h.teardown();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const total = passed + failed;
console.log(`\n${total} test${total !== 1 ? 's' : ''}: ${passed} passed, ${failed} failed`);

if (failed > 0) process.exit(1);
