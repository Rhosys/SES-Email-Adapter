import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReplySenderService } from "../../src/notifier/reply-sender.js";
import type { EmailService } from "../../src/email/email-service.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
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

/** Account DB stub. Default: the from-address is a plain alias with no exchange behind it. */
function makeAccountDb(overrides: {
  alias?: Alias | null;
  exchange?: ExternalMailExchange | null;
  senderSetupComplete?: boolean;
} = {}): AccountDatabase {
  return {
    getAlias: vi.fn().mockResolvedValue(ok(overrides.alias ?? null)),
    getExternalExchange: vi.fn().mockResolvedValue(ok(overrides.exchange ?? null)),
    getDomainByName: vi.fn().mockResolvedValue(ok(overrides.senderSetupComplete ? { senderSetupComplete: true } : null)),
  } as unknown as AccountDatabase;
}

function makeSender(opts: {
  emailService: EmailService;
  logger?: Logger;
  accountDb?: AccountDatabase;
  adapters?: Record<string, ProviderAdapter>;
} ): ReplySenderService {
  return new ReplySenderService({
    emailService: opts.emailService,
    logger: opts.logger ?? makeLogger(),
    accountDb: opts.accountDb ?? makeAccountDb(),
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
    });

    expect(emailService.send).toHaveBeenCalledWith({
      to: "recipient@example.com",
      fromOverride: "sender@example.com",
      subject: "Re: Original Subject",
      textBody: "Reply body text",
      accountId: "acct-test",
      headers: [
        { Name: "In-Reply-To", Value: "<original-id@mail.example.com>" },
        { Name: "References", Value: "<original-id@mail.example.com>" },
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
    });

    expect(result._unsafeUnwrap().outboundMsgId).toMatch(/^ses-reply-456@.*amazonses\.com$/);
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
  };

  it("sends through the provider when the from-alias is exchange-backed, not through SES", async () => {
    const emailService = makeEmailService();
    const adapter = makeGmailAdapter(ok({ providerMessageId: "gmail-msg-1", messageId: "abc@mail.gmail.com" }));
    const handler = makeSender({
      emailService,
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE, exchange: ACTIVE_GMAIL_EXCHANGE }),
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
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE, exchange }),
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
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE, exchange: legacy }),
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
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE, exchange: ACTIVE_GMAIL_EXCHANGE }),
      adapters: { gmail: adapter },
    });

    await handler.sendReply(REPLY);

    expect((adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBeInstanceOf(Uint8Array);
  });

  it("hands the provider a complete RFC 5322 message carrying the reply headers", async () => {
    const adapter = makeGmailAdapter(ok({ providerMessageId: "gmail-msg-1" }));
    const handler = makeSender({
      emailService: makeEmailService(),
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE, exchange: ACTIVE_GMAIL_EXCHANGE }),
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

  it("surfaces a missing send scope as a permanent error rather than falling back to SES", async () => {
    const emailService = makeEmailService();
    const adapter = makeGmailAdapter(err({ kind: "provider_send_scope_missing", cause: "insufficient permissions" }));
    const handler = makeSender({
      emailService,
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE, exchange: ACTIVE_GMAIL_EXCHANGE }),
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
      // Alias still points at emx-1, but the exchange has been deleted.
      accountDb: makeAccountDb({ alias: ALIAS_WITH_EXCHANGE, exchange: null }),
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
        exchange: { ...ACTIVE_GMAIL_EXCHANGE, platform: "imap" },
        senderSetupComplete: true,
      }),
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
    const accountDb = makeAccountDb({ alias: ALIAS_WITH_EXCHANGE, exchange: ACTIVE_GMAIL_EXCHANGE });
    const handler = makeSender({ emailService, accountDb });

    const result = await handler.sendReply({
      to: "recipient@example.com",
      from: "noreply@platform.email.rhosys.cloud",
      subject: "Original",
      body: "Reply body",
      inReplyTo: "<original@mail.example.com>",
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
    const accountDb = makeAccountDb({ alias: ALIAS_WITH_EXCHANGE, exchange: ACTIVE_GMAIL_EXCHANGE });
    const adapter = makeGmailAdapter(ok({ providerMessageId: "gmail-msg-1" }));
    const handler = makeSender({ emailService: makeEmailService(), accountDb, adapters: { gmail: adapter } });

    await handler.sendReply({ ...REPLY, from: '"Ada Lovelace" <User@Gmail.com>' });

    expect(accountDb.getAlias).toHaveBeenCalledWith("acct-test", "user@gmail.com");
    expect(adapter.sendMessage).toHaveBeenCalledOnce();
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
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ messageId: "" });
    expect(logger.calls.some(c => c.method === "warn" && c.context?.code === "reply_sender.send_permanent")).toBe(true);
  });
});
