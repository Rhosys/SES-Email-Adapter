import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { S3RetentionTag } from "./retention.js";
import type { Logger } from "../logger.js";
import type { PresignedPost, UploadField } from "../s3-object-storage.js";

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
}

export interface DroppedAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  reason: "too_large" | "upload_failed";
  /** Populated for "upload_failed" — the HTTP status or error that made the S3 upload fail. */
  detail?: string;
}

export interface InlineImageRef {
  contentId: string;
  mimeType: string;
  sizeBytes: number;
  s3Key: string;
  filename?: string;
}

export interface ContentSanitizeRequest {
  presignedGetUrl: string;
  presignedPost: PresignedPost<UploadField>;
  accountId: string;
  senderEtld1: string;
  keyPrefix: string;
  retentionTag: S3RetentionTag;
  invocationId?: string;
}

/** Mirrors QrScanIssue in src/isolated/asset-extractor.ts. */
export interface QrScanIssue {
  source: "inline_image" | "attachment" | "extraction";
  reason: "over_megapixel_cap" | "unreadable_dimensions" | "decode_failed" | "over_image_count_limit" | "extraction_failed";
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  detail?: string;
}

interface ExtractedAsset {
  type: "qr_code" | "pkpass";
  label: string;
  rawValue: string;
  s3Key?: string;
}

export interface ExtractedLink {
  url: string;
  text: string | null;
}

/** Fields pulled from an RFC 3464 `message/delivery-status` part — see src/isolated/content-sanitizer.ts. */
export interface BounceInfo {
  action?: string;
  status?: string;
  diagnosticCode?: string;
  originalRecipient?: string;
  finalRecipient?: string;
}

export interface ContentSanitizeResponse {
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
    assets?: ExtractedAsset[];
    links?: ExtractedLink[];
    droppedAttachments?: DroppedAttachment[];
    inlineImages?: InlineImageRef[];
    bounce?: BounceInfo;
  };
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ContentSanitizerClient {
  invoke(request: ContentSanitizeRequest): Promise<Result<ContentSanitizeResponse, DbError>>;
}

/** Fraction of the sanitizer's configured memory above which a successful invoke still WARNs. */
const MEMORY_WARN_RATIO = 0.6;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class LambdaContentSanitizer implements ContentSanitizerClient {
  private readonly lambda: LambdaClient;
  private readonly functionArn: string;
  private readonly logger: Logger;

  constructor(lambda: LambdaClient, functionArn: string, logger: Logger) {
    this.lambda = lambda;
    this.functionArn = functionArn;
    this.logger = logger;
  }

  async invoke(request: ContentSanitizeRequest): Promise<Result<ContentSanitizeResponse, DbError>> {
    try {
      const invokePayload = { ...request, invocationId: this.logger.getInvocationId() };
      const response = await this.lambda.send(new InvokeCommand({
        FunctionName: this.functionArn,
        InvocationType: "RequestResponse",
        Payload: new TextEncoder().encode(JSON.stringify(invokePayload)),
      }));

      const executedVersion = response.ExecutedVersion ?? "unknown";

      if (response.FunctionError) {
        const { detail, lambdaRequestId, errorType } = this.extractInvocationErrorDetail(response.Payload);
        if (errorType === "Runtime.OutOfMemory") {
          // No handling exists for this: the error bubbles up, the SQS record is failed and
          // redelivered, and the same email will most likely run out of memory again. Surface
          // it as an ERROR on every occurrence rather than waiting for the repeated-failure log.
          const message = `Content Sanitizer ran out of memory while processing this email (v${executedVersion}) — the SQS message will be redelivered and will most likely fail the same way again.`;
          this.logger.error(message, {
            code: "content_sanitizer.out_of_memory",
            executedVersion,
            accountId: request.accountId,
            keyPrefix: request.keyPrefix,
            ...(lambdaRequestId ? { lambdaRequestId } : {}),
          });
          return err(dbError(message, lambdaRequestId ? { lambdaRequestId } : undefined));
        }
        return err(dbError(
          `Content Sanitizer Lambda error (v${executedVersion}): ${response.FunctionError}${detail ? ` — ${detail}` : ""}`,
          lambdaRequestId ? { lambdaRequestId } : undefined,
        ));
      }

      if (!response.Payload) {
        return err(dbError(`Content Sanitizer Lambda returned empty payload (v${executedVersion})`));
      }

      const wireResult = JSON.parse(new TextDecoder().decode(response.Payload)) as { success: boolean; parsed?: ContentSanitizeResponse["parsed"]; error?: { message: string; type: string }; memory?: { maxRssMb: number; limitMb: number }; qrScanIssues?: QrScanIssue[] };

      const qrScanIssues = wireResult.qrScanIssues;
      if (qrScanIssues && qrScanIssues.length > 0) {
        const reasons = [...new Set(qrScanIssues.map(i => i.reason))].join(", ");
        this.logger.track(`Content Sanitizer skipped or failed QR scanning for ${qrScanIssues.length} image(s): ${reasons}`, {
          code: "content_sanitizer.qr_scan_issues",
          executedVersion,
          accountId: request.accountId,
          keyPrefix: request.keyPrefix,
          qrScanIssues,
        });
      }

      const memory = wireResult.memory;
      if (memory && memory.limitMb > 0 && memory.maxRssMb > memory.limitMb * MEMORY_WARN_RATIO) {
        this.logger.warn(`Content Sanitizer memory usage ${memory.maxRssMb}MB is above ${MEMORY_WARN_RATIO * 100}% of its ${memory.limitMb}MB limit.`, {
          code: "content_sanitizer.high_memory_usage",
          executedVersion,
          accountId: request.accountId,
          keyPrefix: request.keyPrefix,
          maxRssMb: memory.maxRssMb,
          limitMb: memory.limitMb,
        });
      }

      if (!wireResult.success || !wireResult.parsed) {
        const errorPayload = wireResult.error;
        return err(dbError(`Content Sanitizer (v${executedVersion}): ${errorPayload?.type ?? "unknown"} — ${errorPayload?.message ?? "unknown error"}`));
      }

      this.logger.trackPoint("content_sanitizer_invoked", { executedVersion });

      return ok({ parsed: wireResult.parsed });
    } catch (e) {
      this.logger.warn("Content sanitizer invoke failed", { code: "content_sanitizer.invoke_failed", error: e });
      return err(dbError(e));
    }
  }

  private extractInvocationErrorDetail(payload: Uint8Array | undefined): { detail?: string; lambdaRequestId?: string; errorType?: string } {
    if (!payload) return {};
    try {
      const decoded = JSON.parse(new TextDecoder().decode(payload)) as { errorType?: string; errorMessage?: string };
      if (!decoded.errorMessage && !decoded.errorType) return {};
      // Lambda sandbox errors (e.g. Sandbox.Timedout) embed a per-invocation
      // "RequestId: <uuid>" in errorMessage. Pull it out into its own field —
      // it's still logged (as structured context, not string-concatenated),
      // it just no longer varies the message text so aggregation still works.
      const requestIdMatch = decoded.errorMessage?.match(/RequestId:\s*([0-9a-f-]{36})/i);
      const errorMessage = decoded.errorMessage?.replace(/RequestId:\s*[0-9a-f-]{36}\s*/gi, "").trim();
      const detail = [decoded.errorType, errorMessage].filter(Boolean).join(": ");
      return {
        ...(detail ? { detail } : {}),
        ...(requestIdMatch ? { lambdaRequestId: requestIdMatch[1] } : {}),
        ...(decoded.errorType ? { errorType: decoded.errorType } : {}),
      };
    } catch {
      return {};
    }
  }
}
