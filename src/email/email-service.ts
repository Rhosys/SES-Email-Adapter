// ---------------------------------------------------------------------------
// EmailService — shared SES abstraction for all outbound email
// ---------------------------------------------------------------------------

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { ok, err } from "../errors.js";
import type { TransientSesError, Result } from "../errors.js";
import type { Logger } from "../logger.js";

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

  async send(opts: EmailSendOptions): Promise<Result<{ messageId: string }, TransientSesError>> {
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
        ...(opts.tags?.length ? { EmailTags: opts.tags } : {}),
      }));
      const messageId = result.MessageId ?? "";
      this.logger.info("SES send succeeded.", { code: "email_service.send_success", messageId });
      return ok({ messageId });
    } catch (e) {
      return this.classifyError(e, opts);
    }
  }

  async sendRaw(opts: EmailRawOptions): Promise<Result<{ messageId: string }, TransientSesError>> {
    try {
      const result = await this.sesv2.send(new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [opts.to] },
        Content: { Raw: { Data: opts.rawData } },
        ConfigurationSetName: this.configSetName,
        TenantName: opts.accountId,
        ...(opts.tags?.length ? { EmailTags: opts.tags } : {}),
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
