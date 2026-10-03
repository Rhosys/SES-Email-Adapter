// Helpers that construct multipart MIME strings for integration test scenarios.

const BASE_HEADERS = (from: string, to: string, subject: string, messageId: string) => [
  `From: ${from}`,
  `To: ${to}`,
  `Subject: ${subject}`,
  `Message-ID: <${messageId}>`,
  `Date: Thu, 15 Jan 2026 10:00:00 +0000`,
  `MIME-Version: 1.0`,
].join('\r\n');

function boundary(tag: string): string {
  return `----=_Part_${tag}_boundary`;
}

export function buildEmailWithAttachments(
  pdf: Buffer,
  image: Buffer,
  opts: { from?: string; to?: string; subject?: string; messageId?: string } = {},
): string {
  const from = opts.from ?? 'sender@example.com';
  const to = opts.to ?? 'recipient@example.com';
  const subject = opts.subject ?? 'Test email with attachments';
  const messageId = opts.messageId ?? 'attach-test-001@example.com';
  const b = boundary('attachments');

  return [
    BASE_HEADERS(from, to, subject, messageId),
    `Content-Type: multipart/mixed; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'This email has two attachments: a PDF and a PNG image.',
    '',
    `--${b}`,
    'Content-Type: application/pdf',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="document.pdf"',
    '',
    pdf.toString('base64'),
    '',
    `--${b}`,
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="photo.png"',
    '',
    image.toString('base64'),
    '',
    `--${b}--`,
  ].join('\r\n');
}

export function buildEmailWithCidImages(
  cidPng: Buffer,
  opts: { from?: string; to?: string; subject?: string; messageId?: string } = {},
): string {
  const from = opts.from ?? 'sender@example.com';
  const to = opts.to ?? 'recipient@example.com';
  const subject = opts.subject ?? 'Test email with CID image';
  const messageId = opts.messageId ?? 'cid-test-001@example.com';
  const b = boundary('related');

  return [
    BASE_HEADERS(from, to, subject, messageId),
    `Content-Type: multipart/related; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    '<html><body><p>Logo: <img src="cid:logo@test" alt="logo"></p></body></html>',
    '',
    `--${b}`,
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <logo@test>',
    'Content-Disposition: inline; filename="logo.png"',
    '',
    cidPng.toString('base64'),
    '',
    `--${b}--`,
  ].join('\r\n');
}

export function buildEmailWithRegularImages(
  opts: { from?: string; to?: string; subject?: string; messageId?: string } = {},
): string {
  const from = opts.from ?? 'sender@example.com';
  const to = opts.to ?? 'recipient@example.com';
  const subject = opts.subject ?? 'Test email with linked images';
  const messageId = opts.messageId ?? 'img-test-001@example.com';

  return [
    BASE_HEADERS(from, to, subject, messageId),
    'Content-Type: text/html; charset="UTF-8"',
    '',
    '<html><body><p>Check out this image: <img src="https://example.com/logo.png" alt="logo"></p></body></html>',
  ].join('\r\n');
}

export const MINIMAL_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//Test//EN',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:test-event-uid-001@example.com',
  'DTSTART:20260201T100000Z',
  'DTEND:20260201T110000Z',
  'SUMMARY:Team Standup',
  'ORGANIZER;CN=Alice:mailto:alice@example.com',
  'ATTENDEE;CN=Bob;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bob@example.com',
  'SEQUENCE:0',
  'STATUS:CONFIRMED',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

export function buildCalendarEmail(
  icsContent: string,
  opts: { from?: string; to?: string; subject?: string; messageId?: string } = {},
): string {
  const from = opts.from ?? 'alice@example.com';
  const to = opts.to ?? 'recipient@example.com';
  const subject = opts.subject ?? 'Team Standup Invite';
  const messageId = opts.messageId ?? 'cal-test-001@example.com';
  const b = boundary('calendar');

  return [
    BASE_HEADERS(from, to, subject, messageId),
    `Content-Type: multipart/mixed; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'You are invited to Team Standup.',
    '',
    `--${b}`,
    'Content-Type: text/calendar; charset="UTF-8"; method=REQUEST',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="invite.ics"',
    '',
    Buffer.from(icsContent).toString('base64'),
    '',
    `--${b}--`,
  ].join('\r\n');
}
