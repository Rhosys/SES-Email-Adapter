import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { S3RetentionTag } from "./retention.js";

// ---------------------------------------------------------------------------
// Types (mirror the Content Sanitizer Lambda's request/response)
// ---------------------------------------------------------------------------

interface EmailAddress {
  address: string;
  name?: string;
}

interface AttachmentRef {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  s3Key: string;
  cdnUrl: string;
  contentId?: string;
}

export interface ContentSanitizeRequest {
  presignedGetUrl: string;
  presignedPost: {
    url: string;
    fields: Record<string, string>;
  };
  accountId: string;
  senderEtld1: string;
  contentBaseUrl: string;
  keyPrefix: string;
  retentionTag: S3RetentionTag;
}

export interface ContentSanitizeResponse {
  success: true;
  parsed: {
    from: EmailAddress;
    to: EmailAddress[];
    cc: EmailAddress[];
    replyTo?: EmailAddress;
    subject: string;
    textBody?: string;
    htmlBody?: string;
    attachments: AttachmentRef[];
    headers: Record<string, string>;
    sentAt?: string;
  };
  urlMapping: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ContentSanitizerClient {
  invoke(request: ContentSanitizeRequest): Promise<Result<ContentSanitizeResponse, DbError>>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class LambdaContentSanitizer implements ContentSanitizerClient {
  private readonly lambda: LambdaClient;
  private readonly functionArn: string;

  constructor(lambda: LambdaClient, functionArn: string) {
    this.lambda = lambda;
    this.functionArn = functionArn;
  }

  async invoke(request: ContentSanitizeRequest): Promise<Result<ContentSanitizeResponse, DbError>> {
    try {
      const response = await this.lambda.send(new InvokeCommand({
        FunctionName: this.functionArn,
        InvocationType: "RequestResponse",
        Payload: new TextEncoder().encode(JSON.stringify(request)),
      }));

      if (response.FunctionError) {
        return err(dbError(`Content Sanitizer Lambda error: ${response.FunctionError}`));
      }

      if (!response.Payload) {
        return err(dbError("Content Sanitizer Lambda returned empty payload"));
      }

      const payload = JSON.parse(new TextDecoder().decode(response.Payload)) as ContentSanitizeResponse | { success: false; error: { message: string; type: string } };

      if (!payload.success) {
        const errorPayload = payload as { success: false; error: { message: string; type: string } };
        return err(dbError(`Content Sanitizer: ${errorPayload.error.type} — ${errorPayload.error.message}`));
      }

      return ok(payload as ContentSanitizeResponse);
    } catch (e) {
      return err(dbError(e));
    }
  }
}
