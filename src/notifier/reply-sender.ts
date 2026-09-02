// ---------------------------------------------------------------------------
// ReplySenderService — outbound send router
//
// Every outbound message the platform sends on a user's behalf (draft sends, auto-replies,
// pongs) funnels through here. Two routes exist:
//
//   • Provider send — the from-address is an alias backed by an external mailbox
//     (alias.emxId). Mail goes out through Gmail/Graph on the mailbox owner's behalf.
//   • SES send — everything else, i.e. addresses on domains the account has verified with us.
//
// The distinction is a deliverability requirement, not an optimization: SES is not an
// authorized sender for gmail.com or outlook.com, so a SES send from one of those addresses
// fails DMARC at the recipient and burns our sending reputation on the way.
// ---------------------------------------------------------------------------

import type { ReplySender, ReplySendError } from "../processor/processor.js";
import type { EmailService } from "../email/email-service.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { ExchangesDatabase } from "../database/exchanges-database.js";
import type { ProviderAdapter } from "../external-exchanges/provider-adapter.js";
import { exchangeCredentials } from "../external-exchanges/provider-adapter.js";
import type { ExternalMailExchange } from "../types/index.js";
import type { Result } from "../errors.js";
import { ok, err } from "../errors.js";
import { buildOutboundTags } from "../email/ses-tags.js";
import { buildMimeMessage } from "../email/mime-builder.js";
import { buildOutboundMsgId } from "../processor/message-id.js";
import type { Logger } from "../logger.js";

interface ReplySenderDeps {
  emailService: EmailService;
  accountDb: AccountDatabase;
  exchangesDb: ExchangesDatabase;
  adapters: Record<string, ProviderAdapter>;
  logger: Logger;
}

/** Normalizes a subject to a single "Re: " prefix — strips an existing "Re:"/"Fwd:"/"Fw:" prefix (any casing) before adding one, instead of stacking. */
function buildReplySubject(subject: string): string {
  const stripped = subject.replace(/^\s*(?:(?:re|fwd?|fw)\s*:\s*)+/i, "");
  return `Re: ${stripped}`;
}

export class ReplySenderService implements ReplySender {
  private readonly emailService: EmailService;
  private readonly accountDb: AccountDatabase;
  private readonly exchangesDb: ExchangesDatabase;
  private readonly adapters: Record<string, ProviderAdapter>;
  private readonly logger: Logger;

  constructor(deps: ReplySenderDeps) {
    this.emailService = deps.emailService;
    this.accountDb = deps.accountDb;
    this.exchangesDb = deps.exchangesDb;
    this.adapters = deps.adapters;
    this.logger = deps.logger;
  }

  async sendReply(opts: {
    to: string;
    from: string;
    subject: string;
    body: string;
    /** RFC 5322 Message-ID of the specific message being replied to, e.g. "<abc@mail.example.com>".
     * Omit when there isn't one (compose-from-scratch, or the linked message's Message-ID
     * couldn't be resolved) — a wrong value is worse than no In-Reply-To/References at all. */
    inReplyTo?: string;
    accountId?: string;
    signalId?: string;
    threadId?: string;
  }): Promise<Result<{ messageId: string; outboundMsgId?: string }, ReplySendError>> {
    const subject = buildReplySubject(opts.subject);
    const headers = opts.inReplyTo
      ? [
          { Name: "In-Reply-To", Value: opts.inReplyTo },
          { Name: "References", Value: opts.inReplyTo },
        ]
      : [];

    // Platform-originated mail (a pong from the platform domain) carries no account. It sends
    // under the platform tenant, and having no alias it never routes through a provider —
    // route resolution below is deliberately given the original, possibly-absent accountId.
    const resolvedAccountId = opts.accountId ?? this.emailService.platformTenant;

    const routeResult = await this.resolveExchangeRoute(opts.accountId, opts.from);
    if (routeResult.isErr()) return err(routeResult.error);
    const exchange = routeResult.value;

    if (exchange) {
      return this.sendViaProvider(exchange, { ...opts, accountId: resolvedAccountId, subject, headers });
    }
    return this.sendViaSes({ ...opts, accountId: resolvedAccountId, subject, headers });
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  /**
   * Decides whether this from-address must go out through an external mailbox.
   *
   * Returns the exchange to send through, or null to use SES. An alias linked to an exchange
   * that cannot send (IMAP/JMAP, or one that has been deleted or deactivated) only falls back
   * to SES when the account has actually verified that domain for sending — otherwise the
   * send is refused, because emitting unaligned mail is worse than failing visibly.
   */
  private async resolveExchangeRoute(accountId: string | undefined, from: string): Promise<Result<ExternalMailExchange | null, ReplySendError>> {
    if (!accountId) return ok(null);
    // Pulls the bare addr-spec out of a From value that may be `"Name" <addr@host>`.
    const fromAddress = (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();

    const aliasResult = await this.accountDb.getAlias(accountId, fromAddress);
    if (aliasResult.isErr()) return err(aliasResult.error);
    const alias = aliasResult.value;
    if (!alias?.emxId) return ok(null);

    const emxResult = await this.exchangesDb.getExternalExchange(accountId, alias.emxId);
    if (emxResult.isErr()) return err(emxResult.error);
    const emx = emxResult.value;

    if (!emx || emx.status !== "active") {
      return this.fallbackOrRefuse(accountId, fromAddress, emx ? `exchange status is ${emx.status}` : "exchange no longer exists");
    }
    if (!this.adapters[emx.platform]?.sendMessage) {
      return this.fallbackOrRefuse(accountId, fromAddress, `${emx.platform} exchanges cannot send`);
    }
    if (!exchangeCredentials(emx)) {
      return this.fallbackOrRefuse(accountId, fromAddress, "exchange has no linked identity recorded — it predates connection tracking and must be reconnected");
    }
    return ok(emx);
  }

  private async fallbackOrRefuse(accountId: string, fromAddress: string, reason: string): Promise<Result<ExternalMailExchange | null, ReplySendError>> {
    const domain = fromAddress.split("@")[1] ?? "";
    const domainResult = await this.accountDb.getDomainByName(accountId, domain);
    if (domainResult.isErr()) return err(domainResult.error);

    if (domainResult.value?.senderSetupComplete) {
      this.logger.info("Provider send unavailable for exchange-backed alias — falling back to SES on a domain this account has verified for sending", { code: "reply_sender.provider_fallback_ses", accountId, fromAddress, reason });
      return ok(null);
    }

    this.logger.error("Refusing to send: the from-address is backed by an external mailbox that cannot currently send, and this account has not verified the domain for sending through us. Sending via SES anyway would emit mail that fails DMARC at the recipient.", { code: "reply_sender.provider_unavailable", accountId, fromAddress, reason });
    return err({ kind: "provider_send_rejected", cause: `Cannot send from ${fromAddress}: ${reason}` });
  }

  // ---------------------------------------------------------------------------
  // Send routes
  // ---------------------------------------------------------------------------

  private async sendViaProvider(
    emx: ExternalMailExchange,
    opts: { to: string; from: string; subject: string; body: string; accountId: string; signalId?: string; headers: Array<{ Name: string; Value: string }> },
  ): Promise<Result<{ messageId: string; outboundMsgId?: string }, ReplySendError>> {
    const adapter = this.adapters[emx.platform];
    // resolveExchangeRoute already established this; narrowing for the type checker.
    if (!adapter?.sendMessage) return err({ kind: "provider_send_rejected", cause: `${emx.platform} exchanges cannot send` });

    const rawMime = buildMimeMessage({
      from: opts.from,
      to: opts.to,
      subject: opts.subject,
      textBody: opts.body,
      headers: opts.headers,
    });

    // The adapter resolves its own credentials from `emx` — a missing or unusable identity
    // surfaces as a send failure below, same as any other send problem.
    const result = await adapter.sendMessage(rawMime, emx);
    if (result.isErr()) {
      // These two kinds fail identically on every retry.
      if (result.error.kind === "provider_send_scope_missing" || result.error.kind === "provider_send_rejected") {
        this.logger.warn("Provider send permanently rejected — will not retry.", { code: "reply_sender.provider_send_permanent", emxId: emx.id, platform: emx.platform, error: result.error });
      }
      return err(result.error);
    }

    this.logger.info("Reply sent via provider", { code: "reply_sender.provider_sent", to: opts.to, from: opts.from, accountId: opts.accountId, emxId: emx.id, platform: emx.platform });
    return ok({
      messageId: result.value.providerMessageId,
      ...(result.value.messageId ? { outboundMsgId: result.value.messageId } : {}),
    });
  }

  private async sendViaSes(
    opts: { to: string; from: string; subject: string; body: string; accountId: string; signalId?: string; threadId?: string; headers: Array<{ Name: string; Value: string }> },
  ): Promise<Result<{ messageId: string; outboundMsgId?: string }, ReplySendError>> {
    const tags = buildOutboundTags("reply", {
      accountId: opts.accountId,
      signalId: opts.signalId,
      threadId: opts.threadId,
    });

    const result = await this.emailService.send({
      to: opts.to,
      fromOverride: opts.from,
      subject: opts.subject,
      textBody: opts.body,
      accountId: opts.accountId,
      headers: opts.headers,
      tags,
    });

    if (result.isErr() && result.error.kind === "permanent_ses_error") {
      this.logger.warn("Reply send permanently rejected by SES — will not retry.", { code: "reply_sender.send_permanent", accountId: opts.accountId, error: result.error });
      return ok({ messageId: "" });
    }

    if (result.isErr()) {
      this.logger.info("Reply send failed (transient)", { code: "reply_sender.transient_failure", to: opts.to, accountId: opts.accountId, error: result.error });
      return err(result.error);
    }

    this.logger.info("Reply sent", { code: "reply_sender.sent", to: opts.to, from: opts.from, accountId: opts.accountId });
    const sesRegion = process.env["SES_REGION"] ?? "eu-central-1";
    return ok({
      messageId: result.value.messageId,
      ...(result.value.messageId ? { outboundMsgId: buildOutboundMsgId(result.value.messageId, sesRegion) } : {}),
    });
  }
}
