// ---------------------------------------------------------------------------
// ForwardingService — single entry point for all forwarding target interactions
// Owns: target resolution, verification (email + webhook), forwarding dispatch
// ---------------------------------------------------------------------------

import { ok, err } from "neverthrow"
import type { Result } from "neverthrow"
import type { DbError, TransientSesError } from "../errors.js"
import type { EmailServiceError } from "../email/email-service.js"
import type { ForwardingTarget, Signal, Thread } from "../types/index.js"
import type { EmailService } from "../email/email-service.js"
import type { IEmailSignalStore } from "../database/email-signal-store.js"
import type { Logger } from "../logger.js"
import { buildOutboundTags } from "../email/ses-tags.js"
import { effectiveEmailKey } from "../embedding/retention-tier.js"
import { renderTemplate } from "../email/template-renderer.js"
import { buildEmailTags } from "../email/tag-sanitizer.js"
import { buildWebhookPayload, type WebhookPayload } from "../processor/webhook.js"
import { DateTime } from "luxon"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WebhookForwardError = { kind: "webhook_forward_error"; cause: unknown; statusCode?: number }

export type VerificationError = { kind: "verification_failed"; reason: string }

export type ForwardError = DbError | EmailServiceError | WebhookForwardError

// ---------------------------------------------------------------------------
// Store interface — what ForwardingService needs from the DB layer
// ---------------------------------------------------------------------------

export interface IForwardingTargetStore {
  getForwardingTarget(accountId: string, target: string): Promise<Result<ForwardingTarget | null, DbError>>
}

// ---------------------------------------------------------------------------
// Interface (for DI consumers)
// ---------------------------------------------------------------------------

export interface IForwardingService {
  sendVerification(accountId: string, target: ForwardingTarget): Promise<Result<void, VerificationError>>
  forward(forwardingTargetId: string, signal: Signal, thread: Thread): Promise<Result<void, ForwardError>>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ForwardingService implements IForwardingService {
  constructor(
    private readonly emailService: EmailService,
    private readonly targetStore: IForwardingTargetStore,
    private readonly emailSignalStore: IEmailSignalStore,
    private readonly mailDomain: string,
    private readonly logger: Logger,
  ) {}

  async sendVerification(accountId: string, target: ForwardingTarget): Promise<Result<void, VerificationError>> {
    if (target.type === "webhook") {
      return this.verifyWebhookTarget(accountId, target.target);
    }
    return this.sendEmailVerificationTarget(accountId, target.target, target.token);
  }

  private async verifyWebhookTarget(accountId: string, url: string): Promise<Result<void, VerificationError>> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "verification_test" }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      this.logger.error(`Webhook verification failed — network/timeout error: ${e instanceof Error ? e.message : e}`, { code: "forwarding.webhook_verification_failed", accountId, url, error: e });
      return err({ kind: "verification_failed", reason: `Webhook unreachable: ${message}` });
    }

    if (!response.ok) {
      let responseBody = "";
      try { responseBody = (await response.text()).slice(0, 512); } catch { /* ignore */ }
      this.logger.error("Webhook verification failed — non-200 response.", { code: "forwarding.webhook_verification_failed", accountId, url, httpStatus: response.status, responseBody });
      return err({ kind: "verification_failed", reason: `Webhook returned HTTP ${response.status}` });
    }
    return ok(undefined);
  }

  /** Keep the old public method for internal forward-path usage (doesn't need reason string). */
  async verifyWebhook(url: string): Promise<Result<void, TransientSesError>> {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "verification_test" }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        return err({ kind: "transient_ses_error" as const, errorName: "WebhookVerificationFailed", httpStatus: response.status, cause: new Error(`Webhook returned HTTP ${response.status}`) });
      }
      return ok(undefined);
    } catch (e) {
      return err({ kind: "transient_ses_error" as const, errorName: "WebhookVerificationFailed", httpStatus: 0, cause: e });
    }
  }

  async forward(forwardingTargetId: string, signal: Signal, thread: Thread): Promise<Result<void, ForwardError>> {
    const accountId = thread.accountId
    const targetResult = await this.targetStore.getForwardingTarget(accountId, forwardingTargetId)
    if (targetResult.isErr()) return err(targetResult.error)
    const target = targetResult.value
    if (!target || target.status !== "verified") {
      this.logger.warn("Forward skipped — target not found or not verified", {
        code: "forwarding.target_invalid",
        forwardingTargetId,
        accountId,
        status: target?.status,
      })
      return ok(undefined)
    }

    if (target.type === "email") {
      const rawResult = await this.emailSignalStore.getOriginalEmail(effectiveEmailKey(signal.data.s3Key, signal.createdAt))
      if (rawResult.isErr()) return err(rawResult.error)
      return this.forwardEmail(target.target, rawResult.value, { accountId, signalId: signal.id, threadId: thread.id })
    }
    if (target.type === "webhook") {
      const payload = buildWebhookPayload(signal, thread)
      return this.forwardWebhook(target.target, payload, { accountId, signalId: signal.id, threadId: thread.id })
    }

    return ok(undefined)
  }

  // ---------------------------------------------------------------------------
  // Private — email verification
  // ---------------------------------------------------------------------------

  private async sendEmailVerificationTarget(accountId: string, target: string, token: string): Promise<Result<void, VerificationError>> {
    const verifyUrl = `${this.emailService.appBaseUrl}/settings/email-forwarding?tab=forwarding&verifyAddress=${encodeURIComponent(target)}&token=${token}&accountId=${accountId}`
    const triggerId = `fwdverify-${accountId}-${target}`
    const tags = buildEmailTags({
      accountId,
      fullDate: DateTime.utc().toISODate()!,
      invocationId: this.logger.getInvocationId(),
      triggerId,
    })

    const htmlBody = await renderTemplate("forward-verify", {
      address: target,
      verifyUrl,
      accountId,
      domain: this.emailService.appDomain,
    })

    const result = await this.emailService.send({
      to: target,
      subject: "Verify your forwarding address",
      textBody: `Click the link below to verify that you want to receive forwarded emails at ${target}:\n\n${verifyUrl}`,
      htmlBody,
      tags,
      fromSender: `"Numaeel" <noreply@${this.mailDomain}>`,
      accountId: this.emailService.platformTenant,
    })

    if (result.isErr()) {
      if (result.error.kind === "permanent_ses_error") {
        this.logger.error(`Forwarding verification email permanently rejected by SES: ${result.error.errorName}`, { code: "forwarding.verify_send_permanent", accountId, target, error: result.error });
        return err({ kind: "verification_failed", reason: `Email rejected by SES: ${result.error.errorName}` });
      }
      this.logger.error(`Failed to send forwarding verification email: ${"errorName" in result.error ? result.error.errorName : result.error.kind}`, { code: "forwarding.verify_send_failed", accountId, target, error: result.error });
      return err({ kind: "verification_failed", reason: `Unable to send verification email: ${result.error.kind === "transient_ses_error" ? result.error.errorName : "internal error"}` });
    }

    return ok(undefined);
  }

  // ---------------------------------------------------------------------------
  // Private — email forwarding (raw SES send)
  // ---------------------------------------------------------------------------

  private async forwardEmail(toAddress: string, rawData: Uint8Array, context: { accountId: string; signalId: string; threadId: string }): Promise<Result<void, ForwardError>> {
    const tags = buildOutboundTags("forward", { accountId: context.accountId, signalId: context.signalId, threadId: context.threadId })

    const result = await this.emailService.sendRaw({
      to: toAddress,
      rawData,
      accountId: context.accountId,
      tags,
    })

    if (result.isErr()) return err(result.error)
    return ok(undefined)
  }

  // ---------------------------------------------------------------------------
  // Private — webhook forwarding (HTTP POST)
  // ---------------------------------------------------------------------------

  private async forwardWebhook(url: string, data: WebhookPayload, context: { accountId: string; signalId: string; threadId: string }): Promise<Result<void, ForwardError>> {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(5_000),
      })

      if (!response.ok) {
        this.logger.track("Webhook forwarding failed — non-2xx response", {
          code: "forwarding.webhook_failed",
          url,
          statusCode: response.status,
          accountId: context.accountId,
        })
        return err({ kind: "webhook_forward_error" as const, cause: "non-2xx response", statusCode: response.status })
      }

      return ok(undefined)
    } catch (e) {
      this.logger.track("Webhook forwarding failed — network error or timeout", {
        code: "forwarding.webhook_error",
        url,
        error: e,
        accountId: context.accountId,
      })
      return err({ kind: "webhook_forward_error" as const, cause: e })
    }
  }
}
