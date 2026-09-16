import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReplySenderService } from "../../src/notifier/reply-sender.js";
import type { EmailService } from "../../src/email/email-service.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import type { ExchangesDatabase } from "../../src/database/exchanges-database.js";
import type { ProviderAdapter } from "../../src/external-exchanges/provider-adapter.js";
import type { Alias, ExternalMailExchange, EmxPlatform } from "../../src/types/index.js";
import { ok, err } from "../../src/errors.js";
import type { Logger } from "../../src/logger.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { makeMockAdapters } from "../helpers/provider-adapters.js";
import { TAG_ACCOUNT_ID, TAG_SIGNAL_ID, TAG_THREAD_ID } from "../../src/email/ses-tags.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The SES route now builds raw MIME and calls sendRaw, so these helpers read the built message
 * back to assert on the same behaviour the old Simple-send tests checked (subject, headers, body).
 */
function rawOf(sendRawMock: ReturnType<typeof vi.fn>, callIndex = 0): string {
  const opts = sendRawMock.mock.calls[callIndex]![0] as { rawData: Uint8Array };
  return Buffer.from(opts.rawData).toString("utf8");
}

/** Extracts a single header's value from a raw MIME message's top-level header block. */
function headerValue(raw: string, name: string): string | undefined {
  const headerBlock = raw.split("\r\n\r\n")[0]!;
  const match = new RegExp(`^${name}:\\s*(.*)$`, "im").exec(headerBlock);
  return match?.[1]?.trim();
}

/** Base64-decodes the first body part matching a content type (text/plain or text/html). */
function bodyPart(raw: string, contentType: string): string {
  const marker = `Content-Type: ${contentType}`;
  const idx = raw.indexOf(marker);
  if (idx === -1) {
    // Single-part message — body is everything after the first blank line.
    const body = raw.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    return Buffer.from(body.split("\r\n\r\n")[0]!.replace(/\r\n/g, ""), "base64").toString("utf8");
  }
  const afterHeaders = raw.slice(idx).split("\r\n\r\n")[1] ?? "";
  const b64 = afterHeaders.split("\r\n--")[0]!.replace(/\r\n/g, "");
  return Buffer.from(b64, "base64").toString("utf8");
}

function makeEmailService(overrides: Partial<EmailService> = {}): EmailService {
  return {
    send: vi.fn(),
    sendRaw: vi.fn(),
    ...overrides,
  } as unknown as EmailService;
}

function makeLogger(): Logger {
  return { track: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Logger;
}

/**
 * Account DB stub. Default: the from-address is a plain address with no exchange, on a domain the
 * account has verified for sending — so it sends as itself over SES (the common aligned case).
 * Pass senderSetupComplete: false to model an unverified domain (drives the platform-fallback
 * decision).
 */
function makeAccountDb(overrides: {
  alias?: Alias | null;
  senderSetupComplete?: boolean;
} = {}): AccountDatabase {
  const verified = overrides.senderSetupComplete ?? true;
  return {
    getAlias: vi.fn().mockResolvedValue(ok(overrides.alias ?? null)),
    getDomainByName: vi.fn().mockResolvedValue(ok(verified ? { senderSetupComplete: true } : null)),
  } as unknown as AccountDatabase;
}

function makeExchangesDb(overrides: {
  exchange?: ExternalMailExchange | null;
} = {}): ExchangesDatabase {
  return {
    getExternalExchange: vi.fn().mockResolvedValue(ok(overrides.exchange ?? null)),
  } as unknown as ExchangesDatabase;
}

function makeSender(opts: {
  emailService: EmailService;
  logger?: Logger;
  accountDb?: AccountDatabase;
  exchangesDb?: ExchangesDatabase;
  adapters?: Partial<Record<EmxPlatform, ProviderAdapter>>;
} ): ReplySenderService {
  return new ReplySenderService({
    emailService: opts.emailService,
    logger: opts.logger ?? makeLogger(),
    accountDb: opts.accountDb ?? makeAccountDb(),
    exchangesDb: opts.exchangesDb ?? makeExchangesDb(),
    adapters: makeMockAdapters(opts.adapters),
  });
}

const ALIAS_WITH_EXCHANGE: Alias = {
  id: "user@gmail.com",
  accountId: "acct-test",
  aliasAddress: "user@gmail.com",
  domain: "gmail.com",
  aliasName: "user",
  unknownSenderPolicy: "allow_all",
  emxId: "emx-1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

/** The same alias with no exchange behind it — a plain address that should route to SES. */
function aliasWithoutExchange(): Alias {
  const { emxId: _emxId, ...rest } = ALIAS_WITH_EXCHANGE;
  return rest;
}

const ACTIVE_GMAIL_EXCHANGE: ExternalMailExchange = {
  id: "emx-1",
  accountId: "acct-test",
  platform: "gmail",
  emailAddress: "user@gmail.com",
  status: "active",
  userId: "authress-user-9",
  connectionUserId: "google-sub-12345",
  connectionId: "google",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

// ─── sendReply ───────────────────────────────────────────────────────────────

describe("ReplySenderService.sendReply()", () => {
  let emailService: EmailService;
  let handler: ReplySenderService;

  beforeEach(() => {
    emailService = makeEmailService();
    handler = makeSender({ emailService });
  });

  it("calls emailService.sendRaw with the built MIME and correct envelope", async () => {
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "msg-123" }));

    await handler.sendReply({
      sendType: "reply",
      to: [{ address: "recipient@example.com" }],
      from: { address: "sender@example.com" },
      subject: "Original Subject",
      body: "Reply body text",
      inReplyTo: "<original-id@mail.example.com>",
      accountId: "acct-test",
      allowFallbackToPlatformSending: false,
    });

    // The SES route builds raw MIME and calls sendRaw. Envelope fields (to, from, accountId),
    // sendType, and correlation tags are passed as structured args; subject, threading headers,
    // hop count, and both body parts live in the MIME bytes.
    const sendRaw = emailService.sendRaw as ReturnType<typeof vi.fn>;
    const call = sendRaw.mock.calls[0]![0];
    expect(call.to).toEqual(["recipient@example.com"]);
    expect(call.fromSender).toBe("sender@example.com");
    expect(call.accountId).toBe("acct-test");
    expect(call.sendType).toBe("reply");
    expect(call.tags).toEqual([{ Name: "X-Numaeel-AccountId", Value: "acct-test" }]);

    const raw = rawOf(sendRaw);
    expect(headerValue(raw, "Subject")).toBe("Re: Original Subject");
    expect(headerValue(raw, "In-Reply-To")).toBe("<original-id@mail.example.com>");
    expect(headerValue(raw, "References")).toBe("<original-id@mail.example.com>");
    expect(headerValue(raw, "X-Numaeel-Hop-Count")).toBe("1");
    // Bcc must never appear in the SES MIME — it routes through Destination only.
    expect(headerValue(raw, "Bcc")).toBeUndefined();
    expect(bodyPart(raw, "text/plain")).toBe("Reply body text");
    expect(bodyPart(raw, "text/html")).toBe("<p>Reply body text</p>\n");
  });

  it("formats to/cc/bcc as separate SES array entries, each carrying its own display name", async () => {
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "msg-cc-bcc" }));

    await handler.sendReply({
      sendType: "reply",
      to: [{ address: "a@example.com", name: "Ada" }, { address: "b@example.com" }],
      cc: [{ address: "c@example.com", name: "Carl" }],
      bcc: [{ address: "d@example.com" }],
      from: { address: "sender@example.com" },
      subject: "Hi",
      body: "Hello",
      accountId: "acct-test",
      allowFallbackToPlatformSending: false,
    });

    const call = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // To/Cc are formatted string arrays passed to sendRaw and into the MIME headers; Bcc goes to
    // Destination only, never into the MIME.
    expect(call.to).toEqual(["Ada <a@example.com>", "b@example.com"]);
    expect(call.cc).toEqual(["Carl <c@example.com>"]);
    expect(call.bcc).toEqual(["d@example.com"]);
    const raw = rawOf(emailService.sendRaw as ReturnType<typeof vi.fn>);
    expect(headerValue(raw, "To")).toBe("Ada <a@example.com>, b@example.com");
    expect(headerValue(raw, "Cc")).toBe("Carl <c@example.com>");
    expect(headerValue(raw, "Bcc")).toBeUndefined();
  });

  it("omits cc/bcc from the emailService call entirely when none are given", async () => {
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "msg-no-cc" }));

    await handler.sendReply({
      sendType: "reply",
      to: [{ address: "a@example.com" }],
      from: { address: "sender@example.com" },
      subject: "Hi",
      body: "Hello",
      accountId: "acct-test",
      allowFallbackToPlatformSending: false,
    });

    const call = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call).not.toHaveProperty("cc");
    expect(call).not.toHaveProperty("bcc");
  });

  it("returns the messageId from emailService", async () => {
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "ses-reply-456" }));

    const result = await handler.sendReply({
      sendType: "reply",
      to: [{ address: "user@test.com" }],
      from: { address: "noreply@test.com" },
      subject: "Test",
      body: "Content",
      inReplyTo: "<abc@test.com>",
      accountId: "acct-test",
      allowFallbackToPlatformSending: false,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().messageId).toBe("ses-reply-456");
  });

  it("derives the outbound Message-ID from the SES id, for reply threading", async () => {
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "ses-reply-456" }));

    const result = await handler.sendReply({
      sendType: "reply",
      to: [{ address: "user@test.com" }],
      from: { address: "noreply@test.com" },
      subject: "Test",
      body: "Content",
      inReplyTo: "<abc@test.com>",
      accountId: "acct-test",
      allowFallbackToPlatformSending: false,
    });

    expect(result._unsafeUnwrap().outboundMsgId).toMatch(/^ses-reply-456@.*amazonses\.com$/);
  });

  // The composer (DraftSignalCard.vue, TemplatesView.vue) stores the body as Markdown and
  // only ever renders it client-side for a live preview — the server has to do the same
  // rendering at send time so SES gets a real HTML part, not raw "**bold**" markup.
  it("renders the Markdown body to HTML and passes both parts through", async () => {
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "m-md" }));

    await handler.sendReply({
      sendType: "reply",
      to: [{ address: "recipient@example.com" }],
      from: { address: "sender@example.com" },
      subject: "Original Subject",
      body: "Hello **world**\n\n- one\n- two",
      accountId: "acct-test",
      allowFallbackToPlatformSending: false,
    });

    const raw = rawOf(emailService.sendRaw as ReturnType<typeof vi.fn>);
    expect(bodyPart(raw, "text/plain")).toBe("Hello **world**\n\n- one\n- two");
    const html = bodyPart(raw, "text/html");
    expect(html).toContain("<strong>world</strong>");
    expect(html).toContain("<li>one</li>");
  });
});



// ─── Tag Integration ─────────────────────────────────────────────────────────

describe("ReplySenderService tag integration", () => {
  let emailService: EmailService;
  let handler: ReplySenderService;

  beforeEach(() => {
    emailService = makeEmailService();
    handler = makeSender({ emailService });
  });

  describe("sendReply tags", () => {
    // The send-type tag is stamped by EmailService from `sendType`; reply-sender's `tags` now
    // carry correlation IDs only, and the type is passed through the `sendType` field.
    it("without optional fields → sendType passed through, tags = [AccountId]", async () => {
      (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "m-1" }));

      await handler.sendReply({
        sendType: "reply",
        to: [{ address: "a@b.com" }],
        from: { address: "c@d.com" },
        subject: "Hi",
        body: "Hello",
        inReplyTo: "<ref@x.com>",
        accountId: "acct-test",
        allowFallbackToPlatformSending: false,
      });

      const call = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.sendType).toBe("reply");
      expect(call.tags).toEqual([
        { Name: TAG_ACCOUNT_ID, Value: "acct-test" },
      ]);
    });

    it("passes the caller's sendType through unchanged (draft-send)", async () => {
      (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "m-ds" }));

      await handler.sendReply({
        sendType: "draft-send",
        to: [{ address: "a@b.com" }],
        from: { address: "c@d.com" },
        subject: "Hi",
        body: "Hello",
        accountId: "acct-test",
        allowFallbackToPlatformSending: false,
      });

      expect((emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0].sendType).toBe("draft-send");
    });

    it("with all fields → tags include AccountId, SignalId, ThreadId", async () => {
      (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "m-2" }));

      await handler.sendReply({
        sendType: "reply",
        to: [{ address: "a@b.com" }],
        from: { address: "c@d.com" },
        subject: "Hi",
        body: "Hello",
        inReplyTo: "<ref@x.com>",
        accountId: "acct-1",
        signalId: "sig-2",
        threadId: "arc-3",
        allowFallbackToPlatformSending: false,
      });

      const call = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.tags).toEqual([
        { Name: TAG_ACCOUNT_ID, Value: "acct-1" },
        { Name: TAG_SIGNAL_ID, Value: "sig-2" },
        { Name: TAG_THREAD_ID, Value: "arc-3" },
      ]);
    });
  });

});

// ─── Provider routing ────────────────────────────────────────────────────────

describe("ReplySenderService — routing to an external mailbox", () => {
  function makeGmailAdapter(sendResult: unknown) {
    return {
      activate: vi.fn(), renew: vi.fn(), deactivate: vi.fn(), fetchMessage: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(sendResult),
    } as unknown as ProviderAdapter;
  }

  const REPLY = {
    sendType: "reply" as const,
    to: [{ address: "recipient@example.com" }],
    from: { address: "user@gmail.com" },
    subject: "Original",
    body: "Reply body",
    inReplyTo: "<original@mail.example.com>",
    accountId: "acct-test",
    allowFallbackToPlatformSending: false,
  };

  it("sends through the provider when the from-alias is exchange-backed, not through SES", async () => {
    const emailService = makeEmailService();
    const adapter = makeGmailAdapter(ok({ providerMessageId: "gmail-msg-1", messageId: "abc@mail.gmail.com" }));
    const handler = makeSender({
      emailService,
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE }), exchangesDb: makeExchangesDb({ exchange: ACTIVE_GMAIL_EXCHANGE }),
      adapters: { gmail: adapter },
    });

    const result = await handler.sendReply(REPLY);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ messageId: "gmail-msg-1", outboundMsgId: "abc@mail.gmail.com" });
    expect(emailService.sendRaw).not.toHaveBeenCalled();
    expect(adapter.sendMessage).toHaveBeenCalledOnce();
  });

  it("passes the exchange record through to the adapter untouched — credential resolution (including which connection to use) is the adapter's job now, not the router's", async () => {
    // A connection renamed in the Authress portal — a platform-derived "google" would miss it,
    // which is exactly why that resolution lives on the adapter's own emx-backed lookup
    // (see GmailProvider.resolveToken in provider-send.test.ts) rather than being redone here.
    const exchange = { ...ACTIVE_GMAIL_EXCHANGE, connectionId: "google-prod" };
    const adapter = makeGmailAdapter(ok({ providerMessageId: "gmail-msg-1" }));
    const handler = makeSender({
      emailService: makeEmailService(),
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE }),
      exchangesDb: makeExchangesDb({ exchange }),
      adapters: { gmail: adapter },
    });

    await handler.sendReply(REPLY);

    expect((adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual(exchange);
  });

  // Note: whether an exchange can actually mint a token (e.g. one predating connection tracking)
  // is the adapter's concern, verified in provider-send.test.ts — the router no longer inspects
  // credentials, so there is no router-level "refuses on missing identity" case here.

  it("hands the provider a complete RFC 5322 message as the first argument", async () => {
    const adapter = makeGmailAdapter(ok({ providerMessageId: "gmail-msg-1" }));
    const handler = makeSender({
      emailService: makeEmailService(),
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE }), exchangesDb: makeExchangesDb({ exchange: ACTIVE_GMAIL_EXCHANGE }),
      adapters: { gmail: adapter },
    });

    await handler.sendReply(REPLY);

    expect((adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBeInstanceOf(Uint8Array);
  });

  it("hands the provider a complete RFC 5322 message carrying the reply headers", async () => {
    const adapter = makeGmailAdapter(ok({ providerMessageId: "gmail-msg-1" }));
    const handler = makeSender({
      emailService: makeEmailService(),
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE }), exchangesDb: makeExchangesDb({ exchange: ACTIVE_GMAIL_EXCHANGE }),
      adapters: { gmail: adapter },
    });

    await handler.sendReply(REPLY);

    const rawMime = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Uint8Array;
    const message = Buffer.from(rawMime).toString("utf8");
    expect(message).toContain("From: user@gmail.com");
    expect(message).toContain("To: recipient@example.com");
    expect(message).toContain("Subject: Re: Original");
    expect(message).toContain("In-Reply-To: <original@mail.example.com>");
    expect(message).toContain("References: <original@mail.example.com>");
  });

  it("carries Cc (with its display name) in the provider MIME message, and Bcc only there — never as an SES header", async () => {
    const adapter = makeGmailAdapter(ok({ providerMessageId: "gmail-msg-1" }));
    const handler = makeSender({
      emailService: makeEmailService(),
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE }), exchangesDb: makeExchangesDb({ exchange: ACTIVE_GMAIL_EXCHANGE }),
      adapters: { gmail: adapter },
    });

    await handler.sendReply({
      ...REPLY,
      cc: [{ address: "cc@example.com", name: "Cc Person" }],
      bcc: [{ address: "bcc@example.com" }],
    });

    const rawMime = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Uint8Array;
    const message = Buffer.from(rawMime).toString("utf8");
    expect(message).toContain("Cc: Cc Person <cc@example.com>");
    // A provider's own Bcc header is stripped from the copy other recipients see — this is
    // the one send route where it's actually correct for the header to be present.
    expect(message).toContain("Bcc: bcc@example.com");
  });

  it("builds a multipart/alternative message carrying the rendered HTML alongside the Markdown source", async () => {
    const adapter = makeGmailAdapter(ok({ providerMessageId: "gmail-msg-1" }));
    const handler = makeSender({
      emailService: makeEmailService(),
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE }), exchangesDb: makeExchangesDb({ exchange: ACTIVE_GMAIL_EXCHANGE }),
      adapters: { gmail: adapter },
    });

    await handler.sendReply({ ...REPLY, body: "Hi **there**" });

    const rawMime = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Uint8Array;
    const message = Buffer.from(rawMime).toString("utf8");
    expect(message).toContain("Content-Type: multipart/alternative");
    expect(message).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(message).toContain("Content-Type: text/html; charset=UTF-8");
  });

  it("surfaces a missing send scope as a permanent error rather than falling back to SES", async () => {
    const emailService = makeEmailService();
    const adapter = makeGmailAdapter(err({ kind: "provider_send_scope_missing", cause: "insufficient permissions" }));
    const handler = makeSender({
      emailService,
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE }), exchangesDb: makeExchangesDb({ exchange: ACTIVE_GMAIL_EXCHANGE }),
      adapters: { gmail: adapter },
    });

    const result = await handler.sendReply(REPLY);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("provider_send_scope_missing");
    expect(emailService.sendRaw).not.toHaveBeenCalled();
  });

  it("refuses to send when the exchange is gone and the domain is not ours to send for", async () => {
    const emailService = makeEmailService();
    const logger = createMockLogger();
    const handler = makeSender({
      emailService,
      logger,
      // Alias still points at emx-1, but the exchange has been deleted. Domain unverified, and
      // REPLY does not permit platform fallback — so the send is refused.
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE, senderSetupComplete: false }), exchangesDb: makeExchangesDb({ exchange: null }),
      adapters: {},
    });

    const result = await handler.sendReply(REPLY);

    expect(result.isErr()).toBe(true);
    expect(emailService.sendRaw).not.toHaveBeenCalled();
    expect(logger.calls.some(c => c.method === "error" && c.context?.code === "reply_sender.provider_unavailable")).toBe(true);
  });

  it("falls back to SES when the alias's exchange is gone but the account has verified the domain", async () => {
    const emailService = makeEmailService();
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "ses-1" }));
    // The alias points at a deleted exchange, but on a domain the account registered with us:
    // SES is a legitimate, DMARC-aligned sender for it, so refusing the send would be wrong.
    const handler = makeSender({
      emailService,
      accountDb: makeAccountDb({
        alias: { ...ALIAS_WITH_EXCHANGE, aliasAddress: "me@owned.com", domain: "owned.com" },
        senderSetupComplete: true,
      }),
      exchangesDb: makeExchangesDb({ exchange: null }),
    });

    const result = await handler.sendReply({ ...REPLY, from: { address: "me@owned.com" } });

    expect(result.isOk()).toBe(true);
    expect(emailService.sendRaw).toHaveBeenCalledOnce();
  });

  it("sends platform-originated mail under the platform tenant without looking for an exchange", async () => {
    // A pong from the platform domain carries no account. There is no alias to route on, and
    // the SES tenant has to be the platform one or the send is rejected for tenant mismatch.
    const emailService = makeEmailService();
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "ses-1" }));
    (emailService as unknown as { platformTenant: string }).platformTenant = "platform-tenant";
    const accountDb = makeAccountDb({ alias: ALIAS_WITH_EXCHANGE });
    const exchangesDb = makeExchangesDb({ exchange: ACTIVE_GMAIL_EXCHANGE });
    const handler = makeSender({ emailService, accountDb, exchangesDb });

    const result = await handler.sendReply({
      sendType: "pong",
      to: [{ address: "recipient@example.com" }],
      from: { address: "noreply@platform.email.rhosys.cloud" },
      subject: "Original",
      body: "Reply body",
      inReplyTo: "<original@mail.example.com>",
      allowFallbackToPlatformSending: true,
    });

    expect(result.isOk()).toBe(true);
    expect(accountDb.getAlias).not.toHaveBeenCalled();
    expect((emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0].accountId).toBe("platform-tenant");
  });

  it("goes to SES for an alias with no exchange behind it", async () => {
    const emailService = makeEmailService();
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "ses-1" }));
    const handler = makeSender({ emailService, accountDb: makeAccountDb({ alias: aliasWithoutExchange() }) });

    await handler.sendReply({ ...REPLY, from: { address: "me@owned.com" } });

    expect(emailService.sendRaw).toHaveBeenCalledOnce();
  });

  it("matches the alias on the bare address when From carries a display name", async () => {
    const accountDb = makeAccountDb({ alias: ALIAS_WITH_EXCHANGE });
    const exchangesDb = makeExchangesDb({ exchange: ACTIVE_GMAIL_EXCHANGE });
    const adapter = makeGmailAdapter(ok({ providerMessageId: "gmail-msg-1" }));
    const handler = makeSender({ emailService: makeEmailService(), accountDb, exchangesDb, adapters: { gmail: adapter } });

    await handler.sendReply({ ...REPLY, from: { address: "User@Gmail.com", name: "Ada Lovelace" } });

    expect(accountDb.getAlias).toHaveBeenCalledWith("acct-test", "user@gmail.com");
    expect(adapter.sendMessage).toHaveBeenCalledOnce();
  });
});

// ─── Platform-fallback flag ──────────────────────────────────────────────────
//
// The from-address is on a domain the account never verified for sending, and there is no
// exchange that can send as it. Whether that degrades to a platform-domain send or hard-fails
// is decided solely by the caller via allowFallbackToPlatformSending: a pong may degrade, a
// user's draft send must not (it errors so the draft can be parked with a reason).

describe("ReplySenderService — allowFallbackToPlatformSending", () => {
  const MAIL_DOMAIN = process.env["MAIL_DOMAIN"] ?? "platform.email.rhosys.cloud";

  const REPLY_UNVERIFIED = {
    sendType: "reply" as const,
    to: [{ address: "recipient@example.com" }],
    from: { address: "me@unverified.com" },
    subject: "Original",
    body: "Reply body",
    inReplyTo: "<original@mail.example.com>",
    accountId: "acct-test",
  };

  it("rewrites to the platform sender + tenant when fallback is allowed and the address cannot send as itself", async () => {
    const emailService = makeEmailService();
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "ses-1" }));
    (emailService as unknown as { platformTenant: string }).platformTenant = "platform-tenant";
    // No alias, unverified domain → cannot send as itself.
    const handler = makeSender({ emailService, accountDb: makeAccountDb({ alias: null, senderSetupComplete: false }) });

    const result = await handler.sendReply({ ...REPLY_UNVERIFIED, allowFallbackToPlatformSending: true });

    expect(result.isOk()).toBe(true);
    const call = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.fromSender).toBe(`Numaeel <noreply@${MAIL_DOMAIN}>`);
    expect(call.accountId).toBe("platform-tenant");
  });

  it("errors instead of degrading when fallback is NOT allowed and the address cannot send as itself", async () => {
    const emailService = makeEmailService();
    const handler = makeSender({ emailService, accountDb: makeAccountDb({ alias: null, senderSetupComplete: false }) });

    const result = await handler.sendReply({ ...REPLY_UNVERIFIED, allowFallbackToPlatformSending: false });

    expect(result.isErr()).toBe(true);
    expect(emailService.sendRaw).not.toHaveBeenCalled();
  });

  it("does not rewrite when the address can send as itself via a verified SES domain, even with fallback allowed", async () => {
    const emailService = makeEmailService();
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "ses-1" }));
    // No exchange, but the domain is verified — a legitimate aligned SES send.
    const handler = makeSender({ emailService, accountDb: makeAccountDb({ alias: aliasWithoutExchange(), senderSetupComplete: true }) });

    const result = await handler.sendReply({ ...REPLY_UNVERIFIED, from: { address: "user@gmail.com" },allowFallbackToPlatformSending: true });

    expect(result.isOk()).toBe(true);
    const call = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.fromSender).toBe("user@gmail.com");
    expect(call.accountId).toBe("acct-test");
  });

  it("decorates the From with the alias's display name when one is set", async () => {
    const emailService = makeEmailService();
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "ses-1" }));
    const handler = makeSender({ emailService, accountDb: makeAccountDb({ alias: { ...aliasWithoutExchange(), name: "Support Team" }, senderSetupComplete: true }) });

    const result = await handler.sendReply({ ...REPLY_UNVERIFIED, from: { address: "user@gmail.com" }, allowFallbackToPlatformSending: false });

    expect(result.isOk()).toBe(true);
    const call = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.fromSender).toBe(`Support Team <user@gmail.com>`);
  });

  it("errors (never degrades) when the alias's exchange is gone and the domain is unverified, regardless of the flag", async () => {
    const emailService = makeEmailService();
    // Alias points at an exchange that has been deleted, on an unverified domain — the address
    // cannot send as itself. With fallback NOT allowed, the send is refused.
    const handler = makeSender({
      emailService,
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE, senderSetupComplete: false }),
      exchangesDb: makeExchangesDb({ exchange: null }),
    });

    const result = await handler.sendReply({ ...REPLY_UNVERIFIED, from: { address: "user@gmail.com" },allowFallbackToPlatformSending: false });

    expect(result.isErr()).toBe(true);
    expect(emailService.sendRaw).not.toHaveBeenCalled();
  });

  it("degrades to platform when the alias's exchange is gone and fallback is allowed", async () => {
    const emailService = makeEmailService();
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "ses-1" }));
    (emailService as unknown as { platformTenant: string }).platformTenant = "platform-tenant";
    const handler = makeSender({
      emailService,
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE, senderSetupComplete: false }),
      exchangesDb: makeExchangesDb({ exchange: null }),
    });

    const result = await handler.sendReply({ ...REPLY_UNVERIFIED, from: { address: "user@gmail.com" },allowFallbackToPlatformSending: true });

    expect(result.isOk()).toBe(true);
    const call = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.fromSender).toBe(`Numaeel <noreply@${MAIL_DOMAIN}>`);
    expect(call.accountId).toBe("platform-tenant");
  });
});

// ─── Reply subject normalization ────────────────────────────────────────────

describe("ReplySenderService — reply subject normalization", () => {
  it.each([
    ["Original Subject", "Re: Original Subject"],
    ["Re: Original Subject", "Re: Original Subject"],
    ["re: Original Subject", "Re: Original Subject"],
    ["RE: RE: Original Subject", "Re: Original Subject"],
    ["Fwd: Original Subject", "Re: Original Subject"],
    ["FW: Original Subject", "Re: Original Subject"],
    ["Fwd: Re: Original Subject", "Re: Original Subject"],
  ])("normalizes %j to %j", async (input, expected) => {
    const emailService = makeEmailService();
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "m-1" }));
    const handler = makeSender({ emailService });

    await handler.sendReply({ sendType: "reply", to: [{ address: "a@b.com" }], from: { address: "c@d.com" }, subject: input, body: "Hello", accountId: "acct-test", allowFallbackToPlatformSending: false });

    expect(headerValue(rawOf(emailService.sendRaw as ReturnType<typeof vi.fn>), "Subject")).toBe(expected);
  });
});

// ─── Mail-loop guard (hop count + Auto-Submitted) ───────────────────────────

describe("ReplySenderService — mail-loop guard", () => {
  it("stamps hop count 1 when the message being replied to carried none", async () => {
    const emailService = makeEmailService();
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "m-1" }));
    const handler = makeSender({ emailService });

    await handler.sendReply({ sendType: "reply", to: [{ address: "a@b.com" }], from: { address: "c@d.com" }, subject: "Hi", body: "Hello", accountId: "acct-test", allowFallbackToPlatformSending: false });

    expect(headerValue(rawOf(emailService.sendRaw as ReturnType<typeof vi.fn>), "X-Numaeel-Hop-Count")).toBe("1");
  });

  it("increments the hop count carried on the message being replied to", async () => {
    const emailService = makeEmailService();
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "m-1" }));
    const handler = makeSender({ emailService });

    await handler.sendReply({ sendType: "reply", to: [{ address: "a@b.com" }], from: { address: "c@d.com" }, subject: "Hi", body: "Hello", accountId: "acct-test", hopCount: 41, allowFallbackToPlatformSending: false });

    expect(headerValue(rawOf(emailService.sendRaw as ReturnType<typeof vi.fn>), "X-Numaeel-Hop-Count")).toBe("42");
  });

  it("refuses to send and logs an error once the hop count would exceed the guard limit", async () => {
    const emailService = makeEmailService();
    const logger = createMockLogger();
    const handler = makeSender({ emailService, logger });

    const result = await handler.sendReply({ sendType: "reply", to: [{ address: "a@b.com" }], from: { address: "c@d.com" }, subject: "Hi", body: "Hello", accountId: "acct-test", hopCount: 100, allowFallbackToPlatformSending: false });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ kind: "loop_guard_tripped", hopCount: 101 });
    expect(emailService.sendRaw).not.toHaveBeenCalled();
    expect(logger.calls.some(c => c.method === "error" && c.context?.code === "reply_sender.loop_guard_tripped")).toBe(true);
  });

  it("stamps Auto-Submitted: auto-replied only when the caller marks the send as automated", async () => {
    const emailService = makeEmailService();
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValue(ok({ messageId: "m-1" }));
    const handler = makeSender({ emailService });

    await handler.sendReply({ sendType: "reply", to: [{ address: "a@b.com" }], from: { address: "c@d.com" }, subject: "Hi", body: "Hello", accountId: "acct-test", allowFallbackToPlatformSending: false });
    expect(headerValue(rawOf(emailService.sendRaw as ReturnType<typeof vi.fn>, 0), "Auto-Submitted")).toBeUndefined();

    await handler.sendReply({ sendType: "pong", to: [{ address: "a@b.com" }], from: { address: "c@d.com" }, subject: "Hi", body: "Hello", accountId: "acct-test", autoSubmitted: true, allowFallbackToPlatformSending: false });
    expect(headerValue(rawOf(emailService.sendRaw as ReturnType<typeof vi.fn>, 1), "Auto-Submitted")).toBe("auto-replied");
  });
});

// ─── Permanent SES error handling ────────────────────────────────────────────

describe("ReplySenderService — permanent SES error", () => {
  it("returns ok and logs WARN on permanent SES error — no retry", async () => {
    const emailService = makeEmailService();
    const logger = createMockLogger();
    const handler = makeSender({ emailService, logger });
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(err({ kind: "permanent_ses_error", errorName: "MessageRejected", httpStatus: 400, message: "Email address is not verified", cause: new Error("test") }));

    const result = await handler.sendReply({
      sendType: "reply",
      to: [{ address: "bounce@example.com" }],
      from: { address: "sender@example.com" },
      subject: "Test",
      body: "Content",
      inReplyTo: "<ref@test.com>",
      accountId: "acct-test",
      allowFallbackToPlatformSending: false,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ messageId: "" });
    expect(logger.calls.some(c => c.method === "warn" && c.context?.code === "reply_sender.send_permanent")).toBe(true);
  });
});
