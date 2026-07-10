// ---------------------------------------------------------------------------
// EmailService — shared SES abstraction for all outbound email
// ---------------------------------------------------------------------------

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { ok, err } from "../errors.js";
import type { TransientSesError, Result } from "../errors.js";
import type { Logger } from "../logger.js";
import { sanitizeTagName, sanitizeTagValue } from "./tag-sanitizer.js";

export interface EmailSendOptions {
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  headers?: Array<{ Name: string; Value: string }>;
  tags?: Array<{ Name: string; Value: string }>;
  fromOverride?: string;
  /** Account sending on behalf of — maps to SES TenantName at the boundary. */
  accountId: string;
}

export interface EmailRawOptions {
  to: string;
  rawData: Uint8Array;
  tags?: Array<{ Name: string; Value: string }>;
  /** Account sending on behalf of — maps to SES TenantName at the boundary. */
  accountId: string;
}

export class EmailService {
  private readonly sesv2: SESv2Client;
  private readonly from: string;
  private readonly configSetName: string;
  private readonly logger: Logger;

  constructor(sesv2: SESv2Client, opts: { from: string; configSetName: string }, logger: Logger) {
    this.sesv2 = sesv2;
    this.from = opts.from;
    this.configSetName = opts.configSetName;
    this.logger = logger;
  }

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

  private validateAccountId<T>(accountId: string): Result<T, TransientSesError> | null {
    if (!accountId || accountId.trim().length === 0) {
      return err({ kind: "transient_ses_error", errorName: "MissingTenantName", httpStatus: 0, cause: new Error("accountId (SES TenantName) must not be empty — every send must target a tenant.") });
    }
    return null;
  }

  async send(opts: EmailSendOptions): Promise<Result<{ messageId: string }, TransientSesError>> {
    const validationErr = this.validateAccountId<{ messageId: string }>(opts.accountId);
    if (validationErr) return validationErr;
    const emailTags = this.sanitizeTags(opts.tags);
    try {
      const result = await this.sesv2.send(new SendEmailCommand({
        FromEmailAddress: opts.fromOverride ?? this.from,
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

  async sendRaw(opts: EmailRawOptions): Promise<Result<{ messageId: string }, TransientSesError>> {
    const validationErr = this.validateAccountId<{ messageId: string }>(opts.accountId);
    if (validationErr) return validationErr;
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

  private classifyError(e: unknown, opts: EmailSendOptions | EmailRawOptions): Result<{ messageId: string }, TransientSesError> {
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
      return ok({ messageId: "" });
    }

    const isPermanent =
      (errorName === "MessageRejected" && errorMessage.includes("Email address is not verified")) ||
      errorName === "ConfigurationSetSendingPausedException" ||
      errorName === "ConfigurationSetDoesNotExistException";

    if (isPermanent) {
      this.logger.error(`SES permanent failure [${errorName}]: ${errorMessage}.`, {
        code: "email_service.permanent_failure",
        errorName,
        httpStatus,
        error: e,
        opts,
      });
      return ok({ messageId: "" });
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
