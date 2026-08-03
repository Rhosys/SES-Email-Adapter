import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildWebhookPayload, deliverWebhook, type WebhookPayload } from "../../src/processor/webhook.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";
import type { Signal, Thread } from "../../src/types/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSignal(overrides: Partial<Omit<Signal, "data">> & { data?: Partial<Signal["data"]> } = {}): Signal {
  const { data: dataOverrides, ...baseOverrides } = overrides;
  return {
    id: "sgn-test123",
    signalLookupId: "ses-abc123",
    threadId: "arc-xyz",
    accountId: "acct-001",
    source: "email",
    type: "email",
    status: "active",
    createdAt: "2024-06-15T10:30:00.000Z",
    ttl: 1700000000,
    retentionDuration: "P1Y",
    ...baseOverrides,
    data: {
      receivedAt: "2024-06-15T10:30:00.000Z",
      from: { address: "sender@example.com", name: "Alice" },
      to: [{ address: "me@myalias.com" }],
      cc: [{ address: "cc@other.com", name: "Bob" }],
      replyTo: { address: "reply@example.com" },
      subject: "Test Subject",
      recipientAddress: "me@myalias.com",
      workflow: "crm",
      workflowData: { workflow: "crm", crmType: "client_message", urgency: "high", requiresReply: true },
      tags: [],
      summary: "A test signal summary",
      s3Key: "emails/2024/06/test.eml",
      attachments: [],
      headers: { "message-id": "<abc@example.com>" },
      textBody: "Hello world",
      htmlBody: "<p>Hello world</p>",
      embeddings: { "model-v3": [0.1, 0.2, 0.3] },
      matchedRules: [{ ruleId: "rule-1", actions: [{ type: "webhook", value: '{"url":"https://hook.example.com"}' }], labelsAdded: [] }],
      sesMessageId: "ses-msg-id-123",
      ...dataOverrides,
    },
  } as Signal;
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "arc-xyz",
    accountId: "acct-001",
    workflow: "crm",
    labels: ["invoices", "system:workflow:crm"],
    status: "active",
    summary: "Arc summary",
    lastSignalAt: "2024-06-15T10:30:00.000Z",
    createdAt: "2024-06-01T00:00:00.000Z",
    updatedAt: "2024-06-15T10:30:00.000Z",
    sender: { address: "sender@example.com" },
    recipientAddress: "user@example.com",
    subject: "Test email",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildWebhookPayload
// ---------------------------------------------------------------------------

describe("buildWebhookPayload", () => {
  it("projects the correct fields from signal and arc", () => {
    const signal = makeSignal();
    const arc = makeThread();
    const payload = buildWebhookPayload(signal, arc);

    expect(payload).toEqual({
      id: "sgn-test123",
      threadId: "arc-xyz",
      receivedAt: "2024-06-15T10:30:00.000Z",
      from: { address: "sender@example.com", name: "Alice" },
      to: [{ address: "me@myalias.com" }],
      cc: [{ address: "cc@other.com", name: "Bob" }],
      replyTo: { address: "reply@example.com" },
      subject: "Test Subject",
      alias: "me@myalias.com",
      workflow: "crm",
      workflowData: { workflow: "crm", crmType: "client_message", urgency: "high", requiresReply: true },
      summary: "A test signal summary",
      labels: ["invoices", "system:workflow:crm"],
    });
  });

  const INTERNAL_FIELDS = [
    "signalLookupId", "s3Key", "embeddings", "ttl", "sesMessageId",
    "sendInitiatedAt", "sendFailureReason",
    "retentionDuration", "bouncedRecipients", "relatedSignalId",
    "matchedRules", "textBody", "htmlBody",
  ] as const;

  it.each(INTERNAL_FIELDS.map(f => ({ field: f })))(
    "excludes internal field: $field",
    ({ field }) => {
      const signal = makeSignal();
      const arc = makeThread();
      const payload = buildWebhookPayload(signal, arc) as unknown as Record<string, unknown>;
      expect(payload[field]).toBeUndefined();
    },
  );

  it("returns labels from arc", () => {
    const signal = makeSignal();
    const arc = makeThread({ labels: ["custom-label", "another"] });
    const payload = buildWebhookPayload(signal, arc);
    expect(payload.labels).toEqual(["custom-label", "another"]);
  });

  it("returns empty labels array when arc is null", () => {
    const signal = makeSignal();
    const payload = buildWebhookPayload(signal, null);
    expect(payload.labels).toEqual([]);
  });

  it("omits replyTo when signal has no replyTo", () => {
    const base = makeSignal();
    const { replyTo: _, ...dataWithoutReplyTo } = base.data;
    const signal = { ...base, data: dataWithoutReplyTo } as Signal;
    const payload = buildWebhookPayload(signal, makeThread());
    expect("replyTo" in payload).toBe(false);
  });

  it("omits name from address objects when name is absent", () => {
    const signal = makeSignal({
      data: {
        from: { address: "no-name@example.com" },
        to: [{ address: "to@example.com" }],
        cc: [{ address: "cc@example.com" }],
      },
    });
    const payload = buildWebhookPayload(signal, makeThread());
    expect(payload.from).toEqual({ address: "no-name@example.com" });
    expect(payload.to).toEqual([{ address: "to@example.com" }]);
    expect(payload.cc).toEqual([{ address: "cc@example.com" }]);
  });
});

// ---------------------------------------------------------------------------
// deliverWebhook
// ---------------------------------------------------------------------------

describe("deliverWebhook", () => {
  let logger: MockLogger;
  const testPayload: WebhookPayload = {
    id: "sgn-test123",
    threadId: "arc-xyz",
    receivedAt: "2024-06-15T10:30:00.000Z",
    from: { address: "sender@example.com" },
    to: [{ address: "me@myalias.com" }],
    cc: [],
    subject: "Test",
    alias: "me@myalias.com",
    workflow: "crm",
    workflowData: {},
    summary: "Summary",
    labels: [],
  };

  beforeEach(() => {
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns success with status 200 on successful delivery", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    const result = await deliverWebhook("https://hook.example.com/endpoint", testPayload, logger);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ statusCode: 200 });
    expect(logger.calls).toEqual([
      { method: "info", message: "Webhook delivered", context: { code: "processor.webhook.delivered", url: "https://hook.example.com/endpoint", statusCode: 200 } },
    ]);
  });

  it("sends Content-Type application/json header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);

    await deliverWebhook("https://hook.example.com/endpoint", testPayload, logger);

    const [, options] = mockFetch.mock.calls[0]!;
    expect(options.headers["Content-Type"]).toBe("application/json");
  });

  it("sends POST method with JSON body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);

    await deliverWebhook("https://hook.example.com/endpoint", testPayload, logger);

    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://hook.example.com/endpoint");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual(testPayload);
  });

  it("returns failure and logs at TRACK level on non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const result = await deliverWebhook("https://hook.example.com/endpoint", testPayload, logger);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "webhook_error", statusCode: 500 });
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]!.method).toBe("track");
    expect(logger.calls[0]!.context).toMatchObject({ statusCode: 500 });
  });

  it("returns failure and logs at TRACK level on abort/timeout", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));

    const result = await deliverWebhook("https://hook.example.com/endpoint", testPayload, logger);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "webhook_error", cause: abortError });
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]!.method).toBe("track");
    expect(logger.calls[0]!.context).toMatchObject({ error: abortError });
  });

  it("returns failure and logs at TRACK level on network error", async () => {
    const networkError = new Error("getaddrinfo ENOTFOUND hook.example.com");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));

    const result = await deliverWebhook("https://hook.example.com/endpoint", testPayload, logger);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "webhook_error", cause: networkError });
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]!.method).toBe("track");
    expect(logger.calls[0]!.context).toMatchObject({ error: networkError });
  });
});
