import { describe, it, expect } from "vitest";
import { toApiSignal, withResolvedContentUrls } from "../../src/api/signal-transforms.js";
import type { Signal, InboundEmailSignalData, Attachment } from "../../src/types/index.js";
import type { Signal as ApiSignal, InboundEmailSignalData as ApiInboundEmailSignalData, Attachment as ApiAttachment } from "../../src/api/schemas.js";

function makeInboundSignal(overrides: { data?: Partial<Signal<InboundEmailSignalData>["data"]> } & Partial<Omit<Signal<InboundEmailSignalData>, "data">> = {}): Signal<InboundEmailSignalData> {
  const { data: dataOverrides, ...baseOverrides } = overrides;
  return {
    id: "sgn-test-001",
    signalLookupId: "SES#msg-001",
    accountId: "acct-test-001",
    source: "email" as const,
    type: "email" as const,
    status: "block_hidden" as const,
    labels: [],
    createdAt: "2024-01-20T12:00:00Z",
    ...baseOverrides,
    data: {
      receivedAt: "2024-01-20T12:00:00Z",
      from: { address: "sender@example.com", name: "Sender" },
      to: [{ address: "user@example.com" }],
      cc: [],
      subject: "Test email",
      attachments: [],
      headers: {},
      recipientAddress: "user@example.com",
      workflow: "conversation",
      workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
      actions: [],
      tags: [],
      summary: "A test signal.",
      s3Key: "emails/msg-001",
      ...dataOverrides,
    },
  };
}

describe("toApiSignal — matchedRules collapse", () => {
  it("collapses a repeated ruleId down to the last entry found, keeping distinct ruleIds separate", () => {
    const signal = makeInboundSignal({
      data: {
        matchedRules: [
          { ruleId: "SR-05", actions: [{ type: "quarantine_hidden" }], labelsAdded: [], statusChange: "quarantine_hidden" },
          { ruleId: "SR-00", actions: [{ type: "quarantine_visible" }], labelsAdded: [], statusChange: "quarantine_visible", text: "Sender not approved" },
          { ruleId: "SR-00", actions: [{ type: "block_hidden" }], labelsAdded: [], statusChange: "block_hidden", text: "Sender not approved — dismissed by user from quarantine" },
        ],
      },
    });

    const apiSignal = toApiSignal(signal);

    expect(apiSignal.type).toBe("email");
    const data = apiSignal.data as { matchedRules?: Array<{ ruleId: string; text?: string }> };
    expect(data.matchedRules).toEqual([
      { ruleId: "SR-05", actions: [{ type: "quarantine_hidden" }], labelsAdded: [], statusChange: "quarantine_hidden" },
      { ruleId: "SR-00", actions: [{ type: "block_hidden" }], labelsAdded: [], statusChange: "block_hidden", text: "Sender not approved — dismissed by user from quarantine" },
    ]);
  });

  it("passes through a single-entry matchedRules list unchanged", () => {
    const signal = makeInboundSignal({
      data: {
        matchedRules: [{ ruleId: "SR-02", actions: [{ type: "quarantine_visible" }], labelsAdded: [], statusChange: "quarantine_visible" }],
      },
    });

    const apiSignal = toApiSignal(signal);
    const data = apiSignal.data as { matchedRules?: Array<{ ruleId: string }> };
    expect(data.matchedRules).toEqual([{ ruleId: "SR-02", actions: [{ type: "quarantine_visible" }], labelsAdded: [], statusChange: "quarantine_visible" }]);
  });
});

// ---------------------------------------------------------------------------
// withResolvedContentUrls — s3Key -> CDN url resolution, computed lazily at read
// time (never stored). Covers both Attachment.url and the inline-image cid:
// substitution for images the sanitizer routed to S3 instead of embedding as a
// data URI (see MAX_INLINE_DATA_URI_SIZE / MAX_INLINE_DATA_URI_COUNT).
// ---------------------------------------------------------------------------
describe("withResolvedContentUrls", () => {
  it("adds a CDN url to each attachment computed from its s3Key", () => {
    const signal = makeInboundSignal({
      data: {
        attachments: [
          { filename: "doc.pdf", mimeType: "application/pdf", sizeBytes: 1024, s3Key: "emails/msg-001/0" },
        ],
      },
    });

    const result = withResolvedContentUrls(signal, "https://cdn.example.com");
    const attachments = result.data.attachments as Array<{ url?: string }>;
    expect(attachments[0]?.url).toBe("https://cdn.example.com/emails/msg-001/0");
  });

  it("replaces a leftover cid: reference in htmlBody with the matching inline image's CDN url", () => {
    const signal = makeInboundSignal({
      data: {
        htmlBody: '<p>Logo: <img src="cid:logo123"></p>',
        inlineImages: [{ contentId: "logo123", mimeType: "image/png", sizeBytes: 500_000, s3Key: "emails/msg-001/inline-0" }],
      },
    });

    const result = withResolvedContentUrls(signal, "https://cdn.example.com");
    expect((result.data as { htmlBody?: string }).htmlBody).toBe(
      '<p>Logo: <img src="https://cdn.example.com/emails/msg-001/inline-0"></p>',
    );
  });

  it("does not touch htmlBody when there are no inline images to resolve", () => {
    const signal = makeInboundSignal({ data: { htmlBody: "<p>Hello</p>" } });
    const result = withResolvedContentUrls(signal, "https://cdn.example.com");
    expect((result.data as { htmlBody?: string }).htmlBody).toBe("<p>Hello</p>");
  });

  it("resolves multiple inline images independently", () => {
    const signal = makeInboundSignal({
      data: {
        htmlBody: '<img src="cid:a"><img src="cid:b">',
        inlineImages: [
          { contentId: "a", mimeType: "image/png", sizeBytes: 500_000, s3Key: "emails/msg-001/inline-0" },
          { contentId: "b", mimeType: "image/jpeg", sizeBytes: 600_000, s3Key: "emails/msg-001/inline-1" },
        ],
      },
    });

    const result = withResolvedContentUrls(signal, "https://cdn.example.com");
    expect((result.data as { htmlBody?: string }).htmlBody).toBe(
      '<img src="https://cdn.example.com/emails/msg-001/inline-0"><img src="https://cdn.example.com/emails/msg-001/inline-1">',
    );
  });
});


// ---------------------------------------------------------------------------
// Full pipeline: withResolvedContentUrls → toApiSignal — proves attachment
// URLs survive through to the API response shape. This is the gap the
// unit-level withResolvedContentUrls tests above don't cover: they verify the
// intermediate enriched signal, but not that toApiEmailSignalData preserves the
// dynamically-added `url` property on each attachment through to the final
// consumer-facing JSON.
// ---------------------------------------------------------------------------

const ATTACHMENTS_WITH_S3_KEYS: Attachment[] = [
  { filename: "ticket-ABC123.pdf", mimeType: "application/pdf", sizeBytes: 48_000, s3Key: "content/accounts/acct-test-001/extracted/msg-001/0" },
  { filename: "pass-ABC123.pkpass", mimeType: "application/vnd.apple.pkpass", sizeBytes: 12_000, s3Key: "content/accounts/acct-test-001/extracted/msg-001/1" },
  { filename: "invite.ics", mimeType: "application/ics", sizeBytes: 3_200, s3Key: "content/accounts/acct-test-001/extracted/msg-001/2" },
];

const CDN_BASE = "https://cdn.example.com";

describe("withResolvedContentUrls → toApiSignal — full attachment pipeline", () => {
  it("quarantined signal: attachments carry resolved CDN urls in the API response", () => {
    const signal = makeInboundSignal({
      status: "quarantine_visible",
      data: {
        attachments: ATTACHMENTS_WITH_S3_KEYS,
        matchedRules: [{ ruleId: "SR-00", actions: [{ type: "quarantine_visible" }], labelsAdded: [], statusChange: "quarantine_visible", text: "Sender not approved" }],
      },
    });

    const enriched = withResolvedContentUrls(signal, CDN_BASE);
    const apiSignal: ApiSignal = toApiSignal(enriched);

    expect(apiSignal.type).toBe("email");
    const data = apiSignal.data as ApiInboundEmailSignalData;
    // The .ics is filtered out (surfaced as a calendar_event signal instead), leaving pdf + pkpass.
    expect(data.attachments).toHaveLength(2);
    for (const attachment of data.attachments) {
      expect(attachment.url).toBeDefined();
      expect(attachment.url).toMatch(/^https:\/\/cdn\.example\.com\/content\/accounts\//);
    }

    // Verify each attachment's URL matches its s3Key
    const expected: ApiAttachment[] = [
      { filename: "ticket-ABC123.pdf", mimeType: "application/pdf", sizeBytes: 48_000, url: `${CDN_BASE}/content/accounts/acct-test-001/extracted/msg-001/0` },
      { filename: "pass-ABC123.pkpass", mimeType: "application/vnd.apple.pkpass", sizeBytes: 12_000, url: `${CDN_BASE}/content/accounts/acct-test-001/extracted/msg-001/1` },
    ];
    expect(data.attachments).toEqual(expected);
  });

  it("active signal: attachments carry resolved CDN urls identically to quarantine", () => {
    const signal = makeInboundSignal({
      status: "active",
      threadId: "thr-001",
      data: { attachments: ATTACHMENTS_WITH_S3_KEYS },
    });

    const enriched = withResolvedContentUrls(signal, CDN_BASE);
    const apiSignal: ApiSignal = toApiSignal(enriched);
    const data = apiSignal.data as ApiInboundEmailSignalData;

    // .ics filtered — pdf + pkpass remain.
    expect(data.attachments).toHaveLength(2);
    expect(data.attachments[0]?.url).toBe(`${CDN_BASE}/content/accounts/acct-test-001/extracted/msg-001/0`);
    expect(data.attachments[1]?.url).toBe(`${CDN_BASE}/content/accounts/acct-test-001/extracted/msg-001/1`);
  });

  it("signal with no attachments: empty array preserved through the pipeline", () => {
    const signal = makeInboundSignal({ status: "quarantine_visible", data: { attachments: [] } });
    const enriched = withResolvedContentUrls(signal, CDN_BASE);
    const apiSignal: ApiSignal = toApiSignal(enriched);
    const data = apiSignal.data as ApiInboundEmailSignalData;
    expect(data.attachments).toEqual([]);
  });

  it("attachments and inline images resolve independently in the same signal", () => {
    const signal = makeInboundSignal({
      status: "quarantine_visible",
      data: {
        attachments: [ATTACHMENTS_WITH_S3_KEYS[0]!],
        htmlBody: '<p>See: <img src="cid:logo-cid"></p>',
        inlineImages: [{ contentId: "logo-cid", mimeType: "image/png", sizeBytes: 200_000, s3Key: "content/accounts/acct-test-001/extracted/msg-001/inline-0" }],
      },
    });

    const enriched = withResolvedContentUrls(signal, CDN_BASE);
    const apiSignal: ApiSignal = toApiSignal(enriched);
    const data = apiSignal.data as ApiInboundEmailSignalData;

    // Attachment URL resolved
    expect(data.attachments).toHaveLength(1);
    expect(data.attachments[0]?.url).toBe(`${CDN_BASE}/content/accounts/acct-test-001/extracted/msg-001/0`);

    // Inline image CID resolved in body
    expect(data.body).toBe(`<p>See: <img src="${CDN_BASE}/content/accounts/acct-test-001/extracted/msg-001/inline-0"></p>`);
  });

  it("s3Key is stripped from the API response — only url is exposed", () => {
    const signal = makeInboundSignal({
      status: "quarantine_visible",
      data: { attachments: [ATTACHMENTS_WITH_S3_KEYS[0]!] },
    });

    const enriched = withResolvedContentUrls(signal, CDN_BASE);
    const apiSignal: ApiSignal = toApiSignal(enriched);
    const data = apiSignal.data as ApiInboundEmailSignalData;
    const attachment = data.attachments[0]!;

    // url present
    expect(attachment.url).toBeDefined();
    // s3Key must NOT leak to the API consumer
    expect(attachment).not.toHaveProperty("s3Key");
  });

  it("without withResolvedContentUrls: toApiSignal alone produces attachments without url", () => {
    // This test documents the failure mode: if withResolvedContentUrls is skipped,
    // attachments come through with no url property — the bug this change fixes.
    const signal = makeInboundSignal({
      status: "quarantine_visible",
      data: { attachments: ATTACHMENTS_WITH_S3_KEYS },
    });

    const apiSignal: ApiSignal = toApiSignal(signal);
    const data = apiSignal.data as ApiInboundEmailSignalData;

    // toApiSignal alone does not resolve urls (that's withResolvedContentUrls' job) — and
    // because it does not run the read-side enrichment, it also does not filter the .ics.
    // Production always runs withResolvedContentUrls first, so this path is not consumer-facing.
    expect(data.attachments).toHaveLength(3);
    for (const attachment of data.attachments) {
      expect(attachment.url).toBeUndefined();
    }
  });

  it("filters .ics attachments (both text/calendar and .ics filename) from the resolved response", () => {
    const signal = makeInboundSignal({
      status: "active",
      threadId: "thr-002",
      data: {
        attachments: [
          { filename: "ticket.pdf", mimeType: "application/pdf", sizeBytes: 1000, s3Key: "content/accounts/acct-test-001/extracted/msg-001/0" },
          { filename: "invite.ics", mimeType: "application/ics", sizeBytes: 3200, s3Key: "content/accounts/acct-test-001/extracted/msg-001/1" },
          { filename: "meeting", mimeType: "text/calendar; method=REQUEST", sizeBytes: 2800, s3Key: "content/accounts/acct-test-001/extracted/msg-001/2" },
        ],
      },
    });

    const enriched = withResolvedContentUrls(signal, CDN_BASE);
    const apiSignal: ApiSignal = toApiSignal(enriched);
    const data = apiSignal.data as ApiInboundEmailSignalData;

    expect(data.attachments).toHaveLength(1);
    expect(data.attachments[0]?.filename).toBe("ticket.pdf");
  });
});
