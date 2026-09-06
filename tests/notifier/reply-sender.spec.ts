import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReplySenderService } from "../../src/notifier/reply-sender.js";
import type { EmailService } from "../../src/email/email-service.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import type { ExchangesDatabase } from "../../src/database/exchanges-database.js";
import type { ProviderAdapter } from "../../src/external-exchanges/provider-adapter.js";
import type { Alias, ExternalMailExchange } from "../../src/types/index.js";
import { ok, err } from "../../src/errors.js";
import type { Logger } from "../../src/logger.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { TAG_TYPE, TAG_ACCOUNT_ID, TAG_SIGNAL_ID, TAG_THREAD_ID } from "../../src/email/ses-tags.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  adapters?: Record<string, ProviderAdapter>;
} ): ReplySenderService {
  return new ReplySenderService({
    emailService: opts.emailService,
    logger: opts.logger ?? makeLogger(),
    accountDb: opts.accountDb ?? makeAccountDb(),
    exchangesDb: opts.exchangesDb ?? makeExchangesDb(),
    adapters: opts.adapters ?? {},
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

  it("calls emailService.send with correct options", async () => {
    (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "msg-123" }));

    await handler.sendReply({
      to: "recipient@example.com",
      from: "sender@example.com",
      subject: "Original Subject",
      body: "Reply body text",
      inReplyTo: "<original-id@mail.example.com>",
      accountId: "acct-test",
      allowFallbackToPlatformSending: false,
    });

    expect(emailService.send).toHaveBeenCalledWith({
      to: "recipient@example.com",
      fromSender: "sender@example.com",
      subject: "Re: Original Subject",
      textBody: "Reply body text",
      htmlBody: "<p>Reply body text</p>\n",
      accountId: "acct-test",
      headers: [
        { Name: "In-Reply-To", Value: "<original-id@mail.example.com>" },
        { Name: "References", Value: "<original-id@mail.example.com>" },
        { Name: "X-Numaeel-Hop-Count", Value: "1" },
      ],
      tags: [
        { Name: "X-Numaeel-Type", Value: "reply" },
        { Name: "X-Numaeel-AccountId", Value: "acct-test" },
      ],
    });
  });

  it("returns the messageId from emailService", async () => {
    (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "ses-reply-456" }));

    const result = await handler.sendReply({
      to: "user@test.com",
      from: "noreply@test.com",
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
    (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "ses-reply-456" }));

    const result = await handler.sendReply({
      to: "user@test.com",
      from: "noreply@test.com",
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
    (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "m-md" }));

    await handler.sendReply({
      to: "recipient@example.com",
      from: "sender@example.com",
      subject: "Original Subject",
      body: "Hello **world**\n\n- one\n- two",
      accountId: "acct-test",
      allowFallbackToPlatformSending: false,
    });

    const call = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.textBody).toBe("Hello **world**\n\n- one\n- two");
    expect(call.htmlBody).toContain("<strong>world</strong>");
    expect(call.htmlBody).toContain("<li>one</li>");
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
    it("without optional fields → tags = [Type:reply]", async () => {
      (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "m-1" }));

      await handler.sendReply({
        to: "a@b.com",
        from: "c@d.com",
        subject: "Hi",
        body: "Hello",
        inReplyTo: "<ref@x.com>",
        accountId: "acct-test",
        allowFallbackToPlatformSending: false,
      });

      const call = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.tags).toEqual([
        { Name: TAG_TYPE, Value: "reply" },
        { Name: TAG_ACCOUNT_ID, Value: "acct-test" },
      ]);
    });

    it("with all fields → tags include AccountId, SignalId, ThreadId", async () => {
      (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "m-2" }));

      await handler.sendReply({
        to: "a@b.com",
        from: "c@d.com",
        subject: "Hi",
        body: "Hello",
        inReplyTo: "<ref@x.com>",
        accountId: "acct-1",
        signalId: "sig-2",
        threadId: "arc-3",
        allowFallbackToPlatformSending: false,
      });

      const call = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.tags).toEqual([
        { Name: TAG_TYPE, Value: "reply" },
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
    to: "recipient@example.com",
    from: "user@gmail.com",
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
    expect(emailService.send).not.toHaveBeenCalled();
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

  it("refuses to send when the exchange predates connection tracking", async () => {
    const emailService = makeEmailService();
    const legacy = { ...ACTIVE_GMAIL_EXCHANGE };
    delete legacy.userId;
    delete legacy.connectionId;
    const handler = makeSender({
      emailService,
      // Unverified domain + REPLY forbids platform fallback → the unusable exchange refuses.
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE, senderSetupComplete: false }), exchangesDb: makeExchangesDb({ exchange: legacy }),
      adapters: { gmail: makeGmailAdapter(ok({ providerMessageId: "unused" })) },
    });

    const result = await handler.sendReply(REPLY);

    expect(result.isErr()).toBe(true);
    expect(emailService.send).not.toHaveBeenCalled();
  });

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
    expect(emailService.send).not.toHaveBeenCalled();
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
    expect(emailService.send).not.toHaveBeenCalled();
    expect(logger.calls.some(c => c.method === "error" && c.context?.code === "reply_sender.provider_unavailable")).toBe(true);
  });

  it("falls back to SES when the exchange cannot send but the account has verified the domain", async () => {
    const emailService = makeEmailService();
    (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "ses-1" }));
    // An IMAP exchange on a domain the account registered with us: SES is a legitimate,
    // DMARC-aligned sender for it, so refusing the send would be wrong.
    const handler = makeSender({
      emailService,
      accountDb: makeAccountDb({
        alias: { ...ALIAS_WITH_EXCHANGE, aliasAddress: "me@owned.com", domain: "owned.com" },
        senderSetupComplete: true,
      }),
      exchangesDb: makeExchangesDb({ exchange: { ...ACTIVE_GMAIL_EXCHANGE, platform: "imap" } }),
      adapters: {},
    });

    const result = await handler.sendReply({ ...REPLY, from: "me@owned.com" });

    expect(result.isOk()).toBe(true);
    expect(emailService.send).toHaveBeenCalledOnce();
  });

  it("sends platform-originated mail under the platform tenant without looking for an exchange", async () => {
    // A pong from the platform domain carries no account. There is no alias to route on, and
    // the SES tenant has to be the platform one or the send is rejected for tenant mismatch.
    const emailService = makeEmailService();
    (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "ses-1" }));
    (emailService as unknown as { platformTenant: string }).platformTenant = "platform-tenant";
    const accountDb = makeAccountDb({ alias: ALIAS_WITH_EXCHANGE });
    const exchangesDb = makeExchangesDb({ exchange: ACTIVE_GMAIL_EXCHANGE });
    const handler = makeSender({ emailService, accountDb, exchangesDb });

    const result = await handler.sendReply({
      to: "recipient@example.com",
      from: "noreply@platform.email.rhosys.cloud",
      subject: "Original",
      body: "Reply body",
      inReplyTo: "<original@mail.example.com>",
      allowFallbackToPlatformSending: true,
    });

    expect(result.isOk()).toBe(true);
    expect(accountDb.getAlias).not.toHaveBeenCalled();
    expect((emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].accountId).toBe("platform-tenant");
  });

  it("goes to SES for an alias with no exchange behind it", async () => {
    const emailService = makeEmailService();
    (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "ses-1" }));
    const handler = makeSender({ emailService, accountDb: makeAccountDb({ alias: aliasWithoutExchange() }) });

    await handler.sendReply({ ...REPLY, from: "me@owned.com" });

    expect(emailService.send).toHaveBeenCalledOnce();
  });

  it("matches the alias on the bare address when From carries a display name", async () => {
    const accountDb = makeAccountDb({ alias: ALIAS_WITH_EXCHANGE });
    const exchangesDb = makeExchangesDb({ exchange: ACTIVE_GMAIL_EXCHANGE });
    const adapter = makeGmailAdapter(ok({ providerMessageId: "gmail-msg-1" }));
    const handler = makeSender({ emailService: makeEmailService(), accountDb, exchangesDb, adapters: { gmail: adapter } });

    await handler.sendReply({ ...REPLY, from: '"Ada Lovelace" <User@Gmail.com>' });

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
    to: "recipient@example.com",
    from: "me@unverified.com",
    subject: "Original",
    body: "Reply body",
    inReplyTo: "<original@mail.example.com>",
    accountId: "acct-test",
  };

  function makeImapAdapter(): ProviderAdapter {
    // No sendMessage — an IMAP-style adapter that cannot send.
    return { activate: vi.fn(), renew: vi.fn(), deactivate: vi.fn(), fetchMessage: vi.fn() } as unknown as ProviderAdapter;
  }

  it("rewrites to the platform sender + tenant when fallback is allowed and the address cannot send as itself", async () => {
    const emailService = makeEmailService();
    (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "ses-1" }));
    (emailService as unknown as { platformTenant: string }).platformTenant = "platform-tenant";
    // No alias, unverified domain → cannot send as itself.
    const handler = makeSender({ emailService, accountDb: makeAccountDb({ alias: null, senderSetupComplete: false }) });

    const result = await handler.sendReply({ ...REPLY_UNVERIFIED, allowFallbackToPlatformSending: true });

    expect(result.isOk()).toBe(true);
    const call = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.fromSender).toBe(`noreply@${MAIL_DOMAIN}`);
    expect(call.accountId).toBe("platform-tenant");
  });

  it("errors instead of degrading when fallback is NOT allowed and the address cannot send as itself", async () => {
    const emailService = makeEmailService();
    const handler = makeSender({ emailService, accountDb: makeAccountDb({ alias: null, senderSetupComplete: false }) });

    const result = await handler.sendReply({ ...REPLY_UNVERIFIED, allowFallbackToPlatformSending: false });

    expect(result.isErr()).toBe(true);
    expect(emailService.send).not.toHaveBeenCalled();
  });

  it("does not rewrite when the address can send as itself via a verified SES domain, even with fallback allowed", async () => {
    const emailService = makeEmailService();
    (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "ses-1" }));
    // No exchange, but the domain is verified — a legitimate aligned SES send.
    const handler = makeSender({ emailService, accountDb: makeAccountDb({ alias: aliasWithoutExchange(), senderSetupComplete: true }) });

    const result = await handler.sendReply({ ...REPLY_UNVERIFIED, from: "user@gmail.com", allowFallbackToPlatformSending: true });

    expect(result.isOk()).toBe(true);
    const call = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.fromSender).toBe("user@gmail.com");
    expect(call.accountId).toBe("acct-test");
  });

  it("errors (never degrades) when an exchange-backed alias cannot send, regardless of the flag", async () => {
    const emailService = makeEmailService();
    // Exchange-backed alias on an unverified domain, exchange is IMAP (cannot send). Even with
    // fallback allowed, the provider-capability failure is an error — but only because the
    // domain is unverified; the flag then decides platform rewrite vs error.
    const handler = makeSender({
      emailService,
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE, senderSetupComplete: false }),
      exchangesDb: makeExchangesDb({ exchange: { ...ACTIVE_GMAIL_EXCHANGE, platform: "imap" } }),
      adapters: { imap: makeImapAdapter() },
    });

    const result = await handler.sendReply({ ...REPLY_UNVERIFIED, from: "user@gmail.com", allowFallbackToPlatformSending: false });

    expect(result.isErr()).toBe(true);
    expect(emailService.send).not.toHaveBeenCalled();
  });

  it("degrades an exchange-backed alias that cannot send to platform when fallback is allowed", async () => {
    const emailService = makeEmailService();
    (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "ses-1" }));
    (emailService as unknown as { platformTenant: string }).platformTenant = "platform-tenant";
    const handler = makeSender({
      emailService,
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE, senderSetupComplete: false }),
      exchangesDb: makeExchangesDb({ exchange: { ...ACTIVE_GMAIL_EXCHANGE, platform: "imap" } }),
      adapters: { imap: makeImapAdapter() },
    });

    const result = await handler.sendReply({ ...REPLY_UNVERIFIED, from: "user@gmail.com", allowFallbackToPlatformSending: true });

    expect(result.isOk()).toBe(true);
    const call = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.fromSender).toBe(`noreply@${MAIL_DOMAIN}`);
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
    (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "m-1" }));
    const handler = makeSender({ emailService });

    await handler.sendReply({ to: "a@b.com", from: "c@d.com", subject: input, body: "Hello", accountId: "acct-test", allowFallbackToPlatformSending: false });

    expect((emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].subject).toBe(expected);
  });
});

// ─── Mail-loop guard (hop count + Auto-Submitted) ───────────────────────────

describe("ReplySenderService — mail-loop guard", () => {
  it("stamps hop count 1 when the message being replied to carried none", async () => {
    const emailService = makeEmailService();
    (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "m-1" }));
    const handler = makeSender({ emailService });

    await handler.sendReply({ to: "a@b.com", from: "c@d.com", subject: "Hi", body: "Hello", accountId: "acct-test", allowFallbackToPlatformSending: false });

    const call = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.headers).toContainEqual({ Name: "X-Numaeel-Hop-Count", Value: "1" });
  });

  it("increments the hop count carried on the message being replied to", async () => {
    const emailService = makeEmailService();
    (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "m-1" }));
    const handler = makeSender({ emailService });

    await handler.sendReply({ to: "a@b.com", from: "c@d.com", subject: "Hi", body: "Hello", accountId: "acct-test", hopCount: 41, allowFallbackToPlatformSending: false });

    const call = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.headers).toContainEqual({ Name: "X-Numaeel-Hop-Count", Value: "42" });
  });

  it("refuses to send and logs an error once the hop count would exceed the guard limit", async () => {
    const emailService = makeEmailService();
    const logger = createMockLogger();
    const handler = makeSender({ emailService, logger });

    const result = await handler.sendReply({ to: "a@b.com", from: "c@d.com", subject: "Hi", body: "Hello", accountId: "acct-test", hopCount: 100, allowFallbackToPlatformSending: false });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ kind: "loop_guard_tripped", hopCount: 101 });
    expect(emailService.send).not.toHaveBeenCalled();
    expect(logger.calls.some(c => c.method === "error" && c.context?.code === "reply_sender.loop_guard_tripped")).toBe(true);
  });

  it("stamps Auto-Submitted: auto-replied only when the caller marks the send as automated", async () => {
    const emailService = makeEmailService();
    (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValue(ok({ messageId: "m-1" }));
    const handler = makeSender({ emailService });

    await handler.sendReply({ to: "a@b.com", from: "c@d.com", subject: "Hi", body: "Hello", accountId: "acct-test", allowFallbackToPlatformSending: false });
    expect((emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].headers).not.toContainEqual(expect.objectContaining({ Name: "Auto-Submitted" }));

    await handler.sendReply({ to: "a@b.com", from: "c@d.com", subject: "Hi", body: "Hello", accountId: "acct-test", autoSubmitted: true, allowFallbackToPlatformSending: false });
    expect((emailService.send as ReturnType<typeof vi.fn>).mock.calls[1]![0].headers).toContainEqual({ Name: "Auto-Submitted", Value: "auto-replied" });
  });
});

// ─── Permanent SES error handling ────────────────────────────────────────────

describe("ReplySenderService — permanent SES error", () => {
  it("returns ok and logs WARN on permanent SES error — no retry", async () => {
    const emailService = makeEmailService();
    const logger = createMockLogger();
    const handler = makeSender({ emailService, logger });
    (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(err({ kind: "permanent_ses_error", errorName: "MessageRejected", httpStatus: 400, message: "Email address is not verified", cause: new Error("test") }));

    const result = await handler.sendReply({
      to: "bounce@example.com",
      from: "sender@example.com",
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
