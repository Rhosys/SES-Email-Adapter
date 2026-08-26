import { describe, it, expect } from "vitest";
import { toApiSignal, withResolvedContentUrls } from "../../src/api/signal-transforms.js";
import type { Signal } from "../../src/types/index.js";

function makeInboundSignal(overrides: { data?: Partial<Signal["data"]> } & Partial<Omit<Signal, "data">> = {}): Signal {
  const { data: dataOverrides, ...baseOverrides } = overrides;
  return {
    id: "SES#msg-001",
    signalLookupId: "SES#msg-001",
    threadId: undefined,
    accountId: "acct-test-001",
    source: "email" as const,
    type: "email",
    status: "block_hidden",
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
      workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
      tags: [],
      summary: "A test signal.",
      s3Key: "emails/msg-001",
      ...dataOverrides,
    },
  } as Signal;
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
