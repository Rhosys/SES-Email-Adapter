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
import type { Arc, Signal } from '../../src/api/schemas.js';

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

async function getArc(accountId: string): Promise<Arc> {
  const res = await apiReq('GET', `/accounts/${accountId}/arcs`);
  const json = await res.json() as { arcs: Arc[] };
  if (!json.arcs?.length) throw new Error('No arcs found');
  return json.arcs[0]!;
}

async function getSignals(accountId: string, arcId: string): Promise<Signal[]> {
  const res = await apiReq('GET', `/accounts/${accountId}/arcs/${arcId}/signals`);
  const json = await res.json() as { signals: Signal[] };
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
  assert(typeof arc.arcId === 'string', `arc created (arcId=${arc.arcId})`);

  const signals = await getSignals(h.accountId, arc.arcId);
  assert(signals.length === 1, `one signal created (got ${signals.length})`);

  const signal = signals[0];
  assert(signal?.type === 'email', `signal type is email (got ${signal?.type})`);

  if (signal?.type === 'email') {
    const { attachments } = signal.data;
    assert(attachments.length === 2, `two attachments extracted (got ${attachments.length})`);

    if (attachments.length === 2) {
      const pdf = attachments.find(a => a.filename === 'document.pdf');
      const png = attachments.find(a => a.filename === 'photo.png');
      assert(!!pdf, 'PDF attachment present');
      assert(pdf?.mimeType === 'application/pdf', `PDF mimeType (got ${pdf?.mimeType})`);
      assert(typeof pdf?.sizeBytes === 'number' && pdf.sizeBytes > 0, 'PDF sizeBytes > 0');
      assert(typeof pdf?.url === 'string' && pdf.url.includes('/content/accounts/'), `PDF url present (got ${pdf?.url})`);
      assert(!!png, 'PNG attachment present');
      assert(png?.mimeType === 'image/png', `PNG mimeType (got ${png?.mimeType})`);
      assert(typeof png?.url === 'string' && png.url.includes('/content/accounts/'), `PNG url present (got ${png?.url})`);
    }
  }
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

  const arcsRes = await apiReq('GET', `/accounts/${h.accountId}/arcs`);
  const arcsJson = await arcsRes.json() as { arcs: Arc[] };

  let cidSignal: Signal | undefined;
  for (const arc of arcsJson.arcs ?? []) {
    const sigs = await getSignals(h.accountId, arc.arcId);
    for (const sig of sigs) {
      if (sig.type === 'email' && sig.data.body?.includes('data:image/png;base64,')) {
        cidSignal = sig;
      }
    }
  }

  assert(!!cidSignal, 'CID email signal found');
  if (cidSignal?.type === 'email') {
    assert(cidSignal.data.attachments.length === 0, `no attachments in signal (CID image was inlined) — got ${cidSignal.data.attachments.length}`);
    assert(typeof cidSignal.data.body === 'string' && cidSignal.data.body.includes('data:image/png;base64,'), 'body contains data: URI for CID image');
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
  const arcsJson = await arcsRes.json() as { arcs: Arc[] };

  let imgSignal: Signal | undefined;
  for (const arc of arcsJson.arcs ?? []) {
    const sigs = await getSignals(h.accountId, arc.arcId);
    for (const sig of sigs) {
      if (sig.type === 'email' && sig.data.body?.includes('<img')) {
        imgSignal = sig;
      }
    }
  }

  assert(!!imgSignal, 'email signal with <img> tag found');
  if (imgSignal?.type === 'email') {
    assert(imgSignal.data.attachments.length === 0, `no attachments (linked images are not attachments) — got ${imgSignal.data.attachments.length}`);
    assert(typeof imgSignal.data.body === 'string' && imgSignal.data.body.includes('<img'), 'body contains <img> tag');
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

  const arcsRes = await apiReq('GET', `/accounts/${h.accountId}/arcs`);
  const arcsJson = await arcsRes.json() as { arcs: Arc[] };

  let emailSignal: Signal | undefined;
  let calendarSignal: Signal | undefined;

  for (const arc of arcsJson.arcs ?? []) {
    const sigs = await getSignals(h.accountId, arc.arcId);
    const calSig = sigs.find(s => s.type === 'calendar_event');
    if (calSig) {
      calendarSignal = calSig;
      emailSignal = sigs.find(s => s.type === 'email');
      break;
    }
  }

  assert(!!calendarSignal, 'calendar_event signal created');
  assert(!!emailSignal, 'email signal present alongside calendar_event');

  if (calendarSignal?.type === 'calendar_event' && emailSignal) {
    const calData = calendarSignal.data;
    assert(calData.title === 'Team Standup', `calendar title (got ${calData.title})`);
    assert(typeof calData.startTime === 'string', `calendar startTime present (got ${calData.startTime})`);

    assert(calData.attendees.length >= 1, `calendar has attendees (got ${calData.attendees.length})`);
    const bob = calData.attendees.find(a => a.address.includes('bob@'));
    assert(!!bob, 'attendee bob@example.com found');

    assert(calData.linkedSignalId === emailSignal.signalId, `calendar linkedSignalId matches email signal (${emailSignal.signalId})`);
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
