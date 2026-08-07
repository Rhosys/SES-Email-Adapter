// ---------------------------------------------------------------------------
// EmailService — shared SES abstraction for all outbound email
// ---------------------------------------------------------------------------

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { ok, err } from "../errors.js";
import type { TransientSesError, PermanentSesError, InvalidArgumentError, Result } from "../errors.js";
import { permanentSesError } from "../errors.js";
import type { Logger } from "../logger.js";
import { sanitizeTagName, sanitizeTagValue } from "./tag-sanitizer.js";

export type EmailServiceError = TransientSesError | InvalidArgumentError | PermanentSesError;

export interface EmailSendOptions {
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  headers?: Array<{ Name: string; Value: string }>;
  tags?: Array<{ Name: string; Value: string }>;
  fromOverride?: string;
  /** SES TenantName — must match the sending identity. Platform tenant for platform sends, customer accountId for customer sends. */
  accountId: string;
}

export interface EmailRawOptions {
  to: string;
  rawData: Uint8Array;
  tags?: Array<{ Name: string; Value: string }>;
  /** Account sending on behalf of — maps to SES TenantName at the boundary. */
  accountId: string;
}

export interface SuppressionChecker {
  isAddressSuppressed(address: string): Promise<Result<boolean, unknown>>;
}

export class EmailService {
  private readonly sesv2: SESv2Client;
  private readonly from: string;
  private readonly configSetName: string;
  private readonly platformTenantName: string;
  private readonly mailDomain: string;
  private readonly logger: Logger;
  private readonly suppressionChecker: SuppressionChecker | undefined;

  constructor(sesv2: SESv2Client, opts: { from: string; configSetName: string; platformTenantName: string; mailDomain: string }, logger: Logger, suppressionChecker?: SuppressionChecker) {
    this.sesv2 = sesv2;
    this.from = opts.from;
    this.configSetName = opts.configSetName;
    this.platformTenantName = opts.platformTenantName;
    this.mailDomain = opts.mailDomain;
    this.logger = logger;
    this.suppressionChecker = suppressionChecker;
  }

  /** The SES tenant name for platform-originated sends (verification, onboarding, invites). */
  get platformTenant(): string { return this.platformTenantName; }

  /** Full app URL including protocol — e.g. `https://email.rhosys.cloud`. Used for email CTAs. */
  get appBaseUrl(): string { return process.env["APP_BASE_URL"] ?? ""; }

  /** App domain without protocol — e.g. `email.rhosys.cloud`. Used for logo URLs and footer links. */
  get appDomain(): string { return this.appBaseUrl.replace(/^https?:\/\//, ""); }

  /**
   * Sanitize SES message tags at the boundary: names and values may only contain
   * [A-Za-z0-9_-] and must be ≤ 256 chars, or SES rejects the whole send. We strip
   * invalid characters and truncate, and drop any tag left with an empty name or
   * value so a malformed correlation tag can never fail an otherwise-valid email.
   */
  private sanitizeTags(tags?: Array<{ Name: string; Value: string }>): Array<{ Name: string; Value: string }> | undefined {
    if (!tags?.length) return undefined;
    const sanitized = tags
      .map((t) => ({ Name: sanitizeTagName(t.Name), Value: sanitizeTagValue(t.Value) }))
      .filter((t) => t.Name.length > 0 && t.Value.length > 0);
    return sanitized.length > 0 ? sanitized : undefined;
  }

  private validateAccountId(accountId: string): Result<null, InvalidArgumentError> {
    if (!accountId || accountId.trim().length === 0) {
      return err({ kind: "invalid_argument", argument: "accountId", message: "accountId (SES TenantName) must not be empty — every send must target a tenant." });
    }
    return ok(null);
  }

  /**
   * Guards against tenant/domain misalignment:
   * - Platform or SYSTEM tenant → from address must be on our mail domain
   * - Customer tenant → from address must NOT be on our mail domain
   */
  private validateTenantDomainAlignment(accountId: string, fromAddress: string): Result<null, InvalidArgumentError> {
    const fromDomain = fromAddress.split("@").pop()?.replace(/>$/, "") ?? "";
    const isPlatformTenant = accountId === this.platformTenantName || accountId === "SYSTEM";
    const isOurDomain = fromDomain === this.mailDomain || fromDomain.endsWith(`.${this.mailDomain}`);

    if (isPlatformTenant && !isOurDomain) {
      return err({ kind: "invalid_argument", argument: "accountId", message: `Platform tenant "${accountId}" cannot send from external domain "${fromDomain}" — use a customer tenant.` });
    }
    if (!isPlatformTenant && isOurDomain) {
      return err({ kind: "invalid_argument", argument: "accountId", message: `Customer tenant "${accountId}" cannot send from platform domain "${fromDomain}" — use the platform tenant.` });
    }
    return ok(null);
  }

  async send(opts: EmailSendOptions): Promise<Result<{ messageId: string }, EmailServiceError>> {
    const validation = this.validateAccountId(opts.accountId);
    if (validation.isErr()) return err(validation.error);

    const fromAddress = opts.fromOverride ?? this.from;
    const tenantMismatch = this.validateTenantDomainAlignment(opts.accountId, fromAddress);
    if (tenantMismatch.isErr()) {
      this.logger.error("Tenant/domain alignment mismatch — from address does not match tenant type.", {
        code: "email_service.tenant_domain_mismatch",
        accountId: opts.accountId,
        fromAddress,
        error: tenantMismatch.error,
      });
      // Treat as permanent (non-retriable) until 2026-08-12 to stop poisoning the retry queue,
      // then revert to returning the validation error so it surfaces as transient for investigation.
      if (Date.now() < Date.UTC(2026, 7, 12)) {
        return err(permanentSesError("TenantDomainMismatch", 400, tenantMismatch.error.message, tenantMismatch.error));
      }
      return err(tenantMismatch.error);
    }

    // Check if recipient is on the suppression list — log but still send
    if (this.suppressionChecker) {
      const suppressionResult = await this.suppressionChecker.isAddressSuppressed(opts.to);
      if (suppressionResult.isOk() && suppressionResult.value) {
        this.logger.error("Sending to a suppressed address — recipient has previously bounced or complained. Proceeding with send anyway.", {
          code: "email_service.sending_to_suppressed",
          to: opts.to,
          accountId: opts.accountId,
          subject: opts.subject,
        });
      }
    }

    // Merge tags: all custom headers are auto-promoted to SES tags (for feedback correlation).
    // Explicit tags are added after; headers win on name conflict (deduped).
    const mergedTags = this.mergeHeadersIntoTags(opts.headers, opts.tags);
    const emailTags = this.sanitizeTags(mergedTags);
    try {
      const result = await this.sesv2.send(new SendEmailCommand({
        FromEmailAddress: fromAddress,
        Destination: { ToAddresses: [opts.to] },
        Content: {
          Simple: {
            Subject: { Data: opts.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: opts.textBody, Charset: "UTF-8" },
              ...(opts.htmlBody ? { Html: { Data: opts.htmlBody, Charset: "UTF-8" } } : {}),
            },
            ...(opts.headers?.length ? { Headers: opts.headers } : {}),
          },
        },
        ConfigurationSetName: this.configSetName,
        TenantName: opts.accountId,
        ...(emailTags ? { EmailTags: emailTags } : {}),
      }));
      const messageId = result.MessageId ?? "";
      this.logger.info("SES send succeeded.", { code: "email_service.send_success", messageId });
      return ok({ messageId });
    } catch (e) {
      return this.classifyError(e, opts);
    }
  }

  async sendRaw(opts: EmailRawOptions): Promise<Result<{ messageId: string }, EmailServiceError>> {
    const validation = this.validateAccountId(opts.accountId);
    if (validation.isErr()) return err(validation.error);
    const emailTags = this.sanitizeTags(opts.tags);
    try {
      const result = await this.sesv2.send(new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [opts.to] },
        Content: { Raw: { Data: opts.rawData } },
        ConfigurationSetName: this.configSetName,
        TenantName: opts.accountId,
        ...(emailTags ? { EmailTags: emailTags } : {}),
      }));
      const messageId = result.MessageId ?? "";
      this.logger.info("SES send succeeded.", { code: "email_service.send_success", messageId });
      return ok({ messageId });
    } catch (e) {
      return this.classifyError(e, opts);
    }
  }

  /**
   * Merge custom headers into tags. All custom MIME headers (X-Numaeel-*) are
   * auto-promoted to SES tags so they appear in feedback notifications. Explicit
   * tags that are SES-only (never MIME headers) are appended after. Deduped by
   * Name — headers win on conflict.
   */
  private mergeHeadersIntoTags(
    headers: Array<{ Name: string; Value: string }> | undefined,
    tags: Array<{ Name: string; Value: string }> | undefined,
  ): Array<{ Name: string; Value: string }> | undefined {
    if (!headers?.length && !tags?.length) return undefined;
    const seen = new Set<string>();
    const merged: Array<{ Name: string; Value: string }> = [];
    // Headers first — they take priority on name conflict
    for (const h of headers ?? []) {
      const key = h.Name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(h);
      }
    }
    // Then explicit tags (SES-only, not MIME headers)
    for (const t of tags ?? []) {
      const key = t.Name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(t);
      }
    }
    return merged.length > 0 ? merged : undefined;
  }

  private classifyError(e: unknown, opts: EmailSendOptions | EmailRawOptions): Result<{ messageId: string }, EmailServiceError> {
    const error = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    const errorName = error.name ?? "UnknownError";
    const errorMessage = error.message ?? "unknown";
    const httpStatus = error.$metadata?.httpStatusCode ?? 0;

    const isTenantMissing = errorMessage.includes("Tenant") && errorMessage.includes("not found");
    if (isTenantMissing) {
      this.logger.error(
        `SES tenant "${opts.accountId}" does not exist. `
        + "Every SendEmailCommand includes TenantName (set to the accountId). For customer accounts, "
        + "the tenant is created dynamically during domain registration (SesDomainIdentityService). "
        + "For the SYSTEM account, the tenant must be provisioned in Terraform "
        + "(aws_sesv2_tenant.system in deploy/email_routing.tf) with the platform domain identities "
        + "and configuration set associated to it. Run tofu apply to create it.",
        {
          code: "email_service.tenant_missing",
          errorName,
          httpStatus,
          tenantName: opts.accountId,
          error: e,
        },
      );
      return err(permanentSesError(errorName, httpStatus, "Tenant not found: " + opts.accountId, e));
    }

    const isPermanent =
      (errorName === "MessageRejected" && errorMessage.includes("Email address is not verified")) ||
      errorName === "ConfigurationSetSendingPausedException" ||
      errorName === "ConfigurationSetDoesNotExistException" ||
      errorName === "AccessDeniedException";

    if (isPermanent) {
      this.logger.error(`SES permanent failure [${errorName}]: ${errorMessage}.`, {
        code: "email_service.permanent_failure",
        errorName,
        httpStatus,
        error: e,
        opts,
      });
      return err(permanentSesError(errorName, httpStatus, errorMessage, e));
    }

    this.logger.warn(`SES transient failure [${errorName}]: ${errorMessage}.`, {
      code: "email_service.transient_failure",
      errorName,
      httpStatus,
      error: e,
      opts,
    });
    return err({ kind: "transient_ses_error", errorName, httpStatus, cause: e });
  }
}
