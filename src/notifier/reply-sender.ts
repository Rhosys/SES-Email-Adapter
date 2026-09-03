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
import { buildOutboundTags, TAG_HOP_COUNT, MAX_HOP_COUNT } from "../email/ses-tags.js";
import { buildMimeMessage } from "../email/mime-builder.js";
import { renderMarkdownToHtml } from "../email/markdown.js";
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
    /** Hop count read off the message being replied to (its `X-Numaeel-Hop-Count` header, if any). Omit for a compose-from-scratch with no prior hop. */
    hopCount?: number;
    /** RFC 3834 — set for messages a human did not compose (pongs, vacation-style auto-replies). Never set for a user's own draft send. */
    autoSubmitted?: boolean;
    /**
     * Whether this send may degrade to a platform-domain send (`noreply@MAIL_DOMAIN` under the
     * platform tenant) when the from-address cannot send as itself — i.e. it is not backed by an
     * exchange that can send AND its domain is not verified for SES. A pong sets this true (the
     * test confirmation is worth sending even off the platform domain); a user's draft send sets
     * it false, so an unsendable from-address errors and the draft is parked rather than silently
     * going out from an address the user didn't choose. Provider send *failures* are always errors
     * regardless of this flag — degradation only covers "cannot send as itself in the first place".
     */
    allowFallbackToPlatformSending: boolean;
  }): Promise<Result<{ messageId: string; outboundMsgId?: string }, ReplySendError>> {
    // Mail-loop guard: every send through this funnel (draft sends, auto-replies, pongs)
    // increments the hop count carried on the message it answers. Two systems that keep
    // auto-replying to each other run this number up fast — refuse rather than perpetuate it.
    const hopCount = (opts.hopCount ?? 0) + 1;
    if (hopCount > MAX_HOP_COUNT) {
      this.logger.error(`Refusing to send — hop count ${hopCount} exceeds the mail-loop guard limit of ${MAX_HOP_COUNT}. This message is almost certainly part of a reply loop.`, {
        code: "reply_sender.loop_guard_tripped",
        hopCount,
        to: opts.to,
        from: opts.from,
        subject: opts.subject,
        accountId: opts.accountId,
        signalId: opts.signalId,
        threadId: opts.threadId,
      });
      return err({ kind: "loop_guard_tripped", hopCount });
    }

    const subject = buildReplySubject(opts.subject);
    const headers = [
      ...(opts.inReplyTo
        ? [
            { Name: "In-Reply-To", Value: opts.inReplyTo },
            { Name: "References", Value: opts.inReplyTo },
          ]
        : []),
      { Name: TAG_HOP_COUNT, Value: String(hopCount) },
      ...(opts.autoSubmitted ? [{ Name: "Auto-Submitted", Value: "auto-replied" }] : []),
    ];

    // Platform-originated mail (a pong from the platform domain) carries no account. It sends
    // under the platform tenant, and having no alias it never routes through a provider —
    // route resolution below is deliberately given the original, possibly-absent accountId.
    const resolvedAccountId = opts.accountId ?? this.emailService.platformTenant;

    const routeResult = await this.resolveRoute(opts.accountId, opts.from, opts.allowFallbackToPlatformSending);
    if (routeResult.isErr()) return err(routeResult.error);
    const route = routeResult.value;

    // Every composer that writes `body` (reply/compose box, auto-reply templates) is Markdown
    // — see src/email/markdown.ts — so it's rendered to HTML once here, for all send routes.
    const htmlBody = renderMarkdownToHtml(opts.body);

    if (route.kind === "provider") {
      return this.sendViaProvider(route.exchange, { ...opts, htmlBody, accountId: resolvedAccountId, subject, headers });
    }
    if (route.kind === "platform") {
      // Degrade to the platform domain: rewrite the from and send under the platform tenant.
      return this.sendViaSes({ ...opts, htmlBody, from: `noreply@${process.env["MAIL_DOMAIN"] ?? "platform.email.rhosys.cloud"}`, accountId: this.emailService.platformTenant, subject, headers });
    }
    return this.sendViaSes({ ...opts, htmlBody, accountId: resolvedAccountId, subject, headers });
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  /**
   * Decides how this from-address goes out:
   *   • provider — the address is an alias backed by an exchange that can send. Mail goes through
   *     the provider. A send *failure* here is always an error, never a degrade.
   *   • ses      — the address can send as itself over SES (no exchange, but the domain is verified
   *     for sending, or the send is platform-originated with no account).
   *   • platform — the address cannot send as itself (no capable exchange AND unverified domain).
   *     Only produced when the caller allows platform fallback; otherwise this is an error.
   */
  private async resolveRoute(accountId: string | undefined, from: string, allowFallbackToPlatformSending: boolean): Promise<Result<{ kind: "provider"; exchange: ExternalMailExchange } | { kind: "ses" } | { kind: "platform" }, ReplySendError>> {
    // Platform-originated mail (no account) has no alias to route on — send as-is under the
    // platform tenant (the caller supplied the platform from-address and omitted the account).
    if (!accountId) return ok({ kind: "ses" });
    // Pulls the bare addr-spec out of a From value that may be `"Name" <addr@host>`.
    const fromAddress = (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();

    const aliasResult = await this.accountDb.getAlias(accountId, fromAddress);
    if (aliasResult.isErr()) return err(aliasResult.error);
    const alias = aliasResult.value;

    // Not exchange-backed: the address sends as itself over SES if its domain is verified,
    // otherwise it cannot send as itself and the platform-fallback decision applies.
    if (!alias?.emxId) {
      return this.sesOrFallback(accountId, fromAddress, allowFallbackToPlatformSending, "the from-address is not backed by an exchange and its domain is not verified for sending");
    }

    const emxResult = await this.exchangesDb.getExternalExchange(accountId, alias.emxId);
    if (emxResult.isErr()) return err(emxResult.error);
    const emx = emxResult.value;

    // Exchange-backed but cannot send (deleted/inactive, non-sending platform, or no recorded
    // identity): the address cannot send as itself. Fall back to SES on a verified domain, or
    // else apply the platform-fallback decision.
    if (!emx || emx.status !== "active") {
      return this.sesOrFallback(accountId, fromAddress, allowFallbackToPlatformSending, emx ? `exchange status is ${emx.status}` : "exchange no longer exists");
    }
    if (!this.adapters[emx.platform]?.sendMessage) {
      return this.sesOrFallback(accountId, fromAddress, allowFallbackToPlatformSending, `${emx.platform} exchanges cannot send`);
    }
    if (!exchangeCredentials(emx)) {
      return this.sesOrFallback(accountId, fromAddress, allowFallbackToPlatformSending, "exchange has no linked identity recorded — it predates connection tracking and must be reconnected");
    }
    return ok({ kind: "provider", exchange: emx });
  }

  /**
   * The from-address cannot send through a provider. If the account has verified its domain for
   * sending, SES is a DMARC-aligned sender — use it. Otherwise the address cannot send as itself:
   * degrade to the platform domain if the caller allows it, else refuse (emitting unaligned mail
   * from an unverified domain is worse than failing visibly).
   */
  private async sesOrFallback(accountId: string, fromAddress: string, allowFallbackToPlatformSending: boolean, reason: string): Promise<Result<{ kind: "ses" } | { kind: "platform" }, ReplySendError>> {
    const domain = fromAddress.split("@")[1] ?? "";
    const domainResult = await this.accountDb.getDomainByName(accountId, domain);
    if (domainResult.isErr()) return err(domainResult.error);

    if (domainResult.value?.senderSetupComplete) {
      this.logger.info("From-address cannot send via a provider — sending via SES on a domain this account has verified for sending", { code: "reply_sender.provider_fallback_ses", accountId, fromAddress, reason });
      return ok({ kind: "ses" });
    }

    if (allowFallbackToPlatformSending) {
      this.logger.info("From-address cannot send as itself — degrading to a platform-domain send", { code: "reply_sender.platform_fallback", accountId, fromAddress, reason });
      return ok({ kind: "platform" });
    }

    this.logger.error("Refusing to send: the from-address cannot send as itself (no capable exchange, and this account has not verified the domain for sending through us), and platform fallback is not permitted for this send. Sending via SES anyway would emit mail that fails DMARC at the recipient.", { code: "reply_sender.provider_unavailable", accountId, fromAddress, reason });
    return err({ kind: "provider_send_rejected", cause: `Cannot send from ${fromAddress}: ${reason}` });
  }

  // ---------------------------------------------------------------------------
  // Send routes
  // ---------------------------------------------------------------------------

  private async sendViaProvider(
    emx: ExternalMailExchange,
    opts: { to: string; from: string; subject: string; body: string; htmlBody: string; accountId: string; signalId?: string; headers: Array<{ Name: string; Value: string }> },
  ): Promise<Result<{ messageId: string; outboundMsgId?: string }, ReplySendError>> {
    const adapter = this.adapters[emx.platform];
    // resolveRoute already established this; narrowing for the type checker.
    if (!adapter?.sendMessage) return err({ kind: "provider_send_rejected", cause: `${emx.platform} exchanges cannot send` });

    const rawMime = buildMimeMessage({
      from: opts.from,
      to: opts.to,
      subject: opts.subject,
      textBody: opts.body,
      htmlBody: opts.htmlBody,
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
    opts: { to: string; from: string; subject: string; body: string; htmlBody: string; accountId: string; signalId?: string; threadId?: string; headers: Array<{ Name: string; Value: string }> },
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
      htmlBody: opts.htmlBody,
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
