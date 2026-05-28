// Integration test — email round-trip via MiniStack
//
// Run from the repo root:
//   ACCOUNTS_TABLE=... SIGNALS_TABLE=... PROCESSING_TABLE=... AUDIT_TABLE=... \
//   EMAIL_BUCKET=ses-it-email CONTENT_BUCKET=ses-it-content \
//   SIGNAL_QUEUE_URL=http://localhost:4566/000000000000/ses-it-signals \
//   CONTENT_CDN_BASE_URL=http://localhost:4566/ses-it-content \
//   AWS_ENDPOINT_URL=http://localhost:4566 \
//   AUTHRESS_API_URL=http://localhost:4500 \
//   npx tsx tests/integration/email-roundtrip.ts
//
// CI sets all env vars automatically; see .github/workflows/build.yml.

import { createProcessorHarness } from './processor-harness.js';
import {
  buildEmailWithAttachments,
  buildEmailWithCidImages,
  buildEmailWithRegularImages,
  buildCalendarEmail,
  MINIMAL_ICS,
} from './mime-builders.js';

// ---------------------------------------------------------------------------
// Assertion helpers (same pattern as post-accounts.ts)
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
  const isOk = res.status === expected;
  assert(isOk, `${label} (got ${res.status})`);
  if (!isOk) {
    const body = await res.text().catch(() => '(unreadable)');
    console.error(`    response body: ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Shared fixtures — minimal buffers that satisfy MIME parsers
// ---------------------------------------------------------------------------

// Minimal 1×1 PNG (67 bytes)
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6260000000000200e221bc330000000049454e44ae426082',
  'hex',
);
// Minimal valid PDF stub
const TINY_PDF = Buffer.from('%PDF-1.0\n1 0 obj<</Type /Catalog>>endobj\nxref\n0 1\n0000000000 65535 f \ntrailer<</Size 1>>\nstartxref\n9\n%%EOF\n');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const h = await createProcessorHarness();
const token = await h.mockAuthress.createToken(`user-rt-${h.accountId}`);

async function apiReq(method: string, path: string, body?: unknown): Promise<Response> {
  return h.app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function getArc(accountId: string): Promise<Record<string, unknown>> {
  const res = await apiReq('GET', `/accounts/${accountId}/arcs`);
  const json = await res.json() as { arcs: Record<string, unknown>[] };
  if (!json.arcs?.length) throw new Error('No arcs found');
  return json.arcs[0]!;
}

async function getSignals(accountId: string, arcId: string): Promise<Record<string, unknown>[]> {
  const res = await apiReq('GET', `/accounts/${accountId}/arcs/${arcId}/signals`);
  const json = await res.json() as { signals: Record<string, unknown>[] };
  return json.signals ?? [];
}

// ---------------------------------------------------------------------------
// Scenario 1 — multiple regular attachments
// ---------------------------------------------------------------------------
{
  console.log('\nScenario 1: email with multiple regular attachments');
  const sesId = `ses-attach-${Date.now()}`;
  const mime = buildEmailWithAttachments(TINY_PDF, TINY_PNG, { messageId: sesId });

  await h.sendEmail(sesId, mime);
  await h.consumeAndProcess();

  const arc = await getArc(h.accountId);
  const arcId = arc['arcId'] as string;
  assert(typeof arcId === 'string', `arc created (arcId=${arcId})`);

  const signals = await getSignals(h.accountId, arcId);
  assert(signals.length === 1, `one signal created (got ${signals.length})`);

  const signal = signals[0] as Record<string, unknown>;
  assert(signal['type'] === 'email', `signal type is email (got ${signal['type']})`);

  const data = signal['data'] as Record<string, unknown>;
  const attachments = data['attachments'] as Record<string, unknown>[];
  assert(attachments?.length === 2, `two attachments extracted (got ${attachments?.length})`);

  if (attachments?.length === 2) {
    const pdf = attachments.find(a => a['filename'] === 'document.pdf');
    const png = attachments.find(a => a['filename'] === 'photo.png');
    assert(!!pdf, 'PDF attachment present');
    assert(pdf?.['mimeType'] === 'application/pdf', `PDF mimeType (got ${pdf?.['mimeType']})`);
    assert(typeof pdf?.['sizeBytes'] === 'number' && (pdf['sizeBytes'] as number) > 0, 'PDF sizeBytes > 0');
    assert(typeof pdf?.['url'] === 'string' && (pdf['url'] as string).includes('/content/accounts/'), `PDF url present (got ${pdf?.['url']})`);
    assert(!!png, 'PNG attachment present');
    assert(png?.['mimeType'] === 'image/png', `PNG mimeType (got ${png?.['mimeType']})`);
    assert(typeof png?.['url'] === 'string' && (png['url'] as string).includes('/content/accounts/'), `PNG url present (got ${png?.['url']})`);
  }

  // clean up arcs between scenarios by checking we get a fresh arc per scenario
}

// ---------------------------------------------------------------------------
// Scenario 2 — CID inline images
// ---------------------------------------------------------------------------
{
  console.log('\nScenario 2: email with CID inline image');
  const sesId = `ses-cid-${Date.now()}`;
  const mime = buildEmailWithCidImages(TINY_PNG, { messageId: sesId });

  await h.sendEmail(sesId, mime);
  await h.consumeAndProcess();

  // The new email creates a new arc (different sender/recipient match is based on embeddings
  // which we stub; the processor will create a new arc or reuse — either is fine for assertion)
  const arcsRes = await apiReq('GET', `/accounts/${h.accountId}/arcs`);
  const arcsJson = await arcsRes.json() as { arcs: Record<string, unknown>[] };
  const latestArc = arcsJson.arcs?.find(a => {
    // Find the arc whose lastSignalAt is most recent
    return true;
  }) as Record<string, unknown> | undefined;

  // Get signals for all arcs and find the one matching our sesId
  let cidSignal: Record<string, unknown> | undefined;
  for (const arc of arcsJson.arcs ?? []) {
    const arcId = arc['arcId'] as string;
    const sigs = await getSignals(h.accountId, arcId);
    for (const sig of sigs) {
      const sigData = sig['data'] as Record<string, unknown>;
      const body = sigData['body'] as string | undefined;
      if (body?.includes('data:image/png;base64,')) {
        cidSignal = sig;
      }
    }
  }

  assert(!!cidSignal, 'CID email signal found');
  if (cidSignal) {
    const data = cidSignal['data'] as Record<string, unknown>;
    const attachments = data['attachments'] as unknown[] ?? [];
    assert(attachments.length === 0, `no attachments in signal (CID image was inlined) — got ${attachments.length}`);
    const body = data['body'] as string | undefined;
    assert(typeof body === 'string' && body.includes('data:image/png;base64,'), 'body contains data: URI for CID image');
  }
}

// ---------------------------------------------------------------------------
// Scenario 3 — regular linked images in HTML
// ---------------------------------------------------------------------------
{
  console.log('\nScenario 3: email with regular linked images');
  const sesId = `ses-img-${Date.now()}`;
  const mime = buildEmailWithRegularImages({ messageId: sesId });

  await h.sendEmail(sesId, mime);
  await h.consumeAndProcess();

  const arcsRes = await apiReq('GET', `/accounts/${h.accountId}/arcs`);
  const arcsJson = await arcsRes.json() as { arcs: Record<string, unknown>[] };

  let imgSignal: Record<string, unknown> | undefined;
  for (const arc of arcsJson.arcs ?? []) {
    const arcId = arc['arcId'] as string;
    const sigs = await getSignals(h.accountId, arcId);
    for (const sig of sigs) {
      const sigData = sig['data'] as Record<string, unknown>;
      const body = sigData['body'] as string | undefined;
      if (body?.includes('<img')) {
        imgSignal = sig;
      }
    }
  }

  assert(!!imgSignal, 'email signal with <img> tag found');
  if (imgSignal) {
    const data = imgSignal['data'] as Record<string, unknown>;
    const attachments = data['attachments'] as unknown[] ?? [];
    assert(attachments.length === 0, `no attachments (linked images are not attachments) — got ${attachments.length}`);
    const body = data['body'] as string | undefined;
    assert(typeof body === 'string' && body.includes('<img'), 'body contains <img> tag');
  }
}

// ---------------------------------------------------------------------------
// Scenario 4 — calendar invite
// ---------------------------------------------------------------------------
{
  console.log('\nScenario 4: email with .ics calendar invite');
  const sesId = `ses-cal-${Date.now()}`;
  const mime = buildCalendarEmail(MINIMAL_ICS, {
    from: 'alice@example.com',
    to: 'bob@example.com',
    messageId: sesId,
  });

  await h.sendEmail(sesId, mime);
  await h.consumeAndProcess();

  // Find the arc and signals for this scenario by looking for a calendar_event signal
  const arcsRes = await apiReq('GET', `/accounts/${h.accountId}/arcs`);
  const arcsJson = await arcsRes.json() as { arcs: Record<string, unknown>[] };

  let emailSignal: Record<string, unknown> | undefined;
  let calendarSignal: Record<string, unknown> | undefined;

  for (const arc of arcsJson.arcs ?? []) {
    const arcId = arc['arcId'] as string;
    const sigs = await getSignals(h.accountId, arcId);
    const calSig = sigs.find(s => s['type'] === 'calendar_event');
    if (calSig) {
      calendarSignal = calSig;
      emailSignal = sigs.find(s => s['type'] === 'email');
      break;
    }
  }

  assert(!!calendarSignal, 'calendar_event signal created');
  assert(!!emailSignal, 'email signal present alongside calendar_event');

  if (calendarSignal && emailSignal) {
    const calData = calendarSignal['data'] as Record<string, unknown>;
    assert(calData['title'] === 'Team Standup', `calendar title (got ${calData['title']})`);
    assert(typeof calData['startTime'] === 'string', `calendar startTime present (got ${calData['startTime']})`);

    const attendees = calData['attendees'] as Record<string, unknown>[] ?? [];
    assert(attendees.length >= 1, `calendar has attendees (got ${attendees.length})`);
    const bob = attendees.find(a => (a['address'] as string)?.includes('bob@'));
    assert(!!bob, 'attendee bob@example.com found');

    const emailSignalId = emailSignal['signalId'] as string;
    assert(calData['linkedSignalId'] === emailSignalId, `calendar linkedSignalId matches email signal (${emailSignalId})`);
  }
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
