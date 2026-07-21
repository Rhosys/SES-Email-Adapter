import { S3Client, PutObjectTaggingCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { toSavedKey } from "./retention-tier.js";

// ---------------------------------------------------------------------------
// S3 Retention Service
// ---------------------------------------------------------------------------

const EMAIL_BUCKET = process.env["EMAIL_BUCKET"] ?? "";

export interface S3RetentionInput {
  s3Tag: string | null;
  copyToSaved: boolean;
}

export interface S3RetentionService {
  applyPlanRetention(s3Key: string, input: S3RetentionInput): Promise<{ s3Key: string }>;
}

/**
 * Applies plan-driven retention to an S3 object after signal processing.
 *
 * - Free/Beta (s3Tag set): PutObjectTagging with retention-tier=P1Y on emails/{key}
 * - Paid/Lifetime (s3Tag null, copyToSaved false): no-op
 * - Premium/Internal (copyToSaved true): CopyObject emails/{key} → saved/{key} for
 *   durability past the 5-year lifecycle expiry
 *
 * The signal's stored s3Key is never changed — it always points at emails/{key}.
 * Readers resolve the saved/ copy at read time via effectiveEmailKey once the
 * emails/ object has aged past the lifecycle horizon. Always returns the original
 * s3Key so callers never persist a rewritten key.
 */
export class S3RetentionServiceImpl implements S3RetentionService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(s3?: S3Client, bucket?: string) {
    this.s3 = s3 ?? new S3Client({});
    this.bucket = bucket ?? EMAIL_BUCKET;
  }

  async applyPlanRetention(s3Key: string, input: S3RetentionInput): Promise<{ s3Key: string }> {
    // Free/Beta: tag the inbox object with retention-tier=P1Y
    if (input.s3Tag !== null) {
      const [tagKey, tagValue] = input.s3Tag.split("=") as [string, string];
      await this.s3.send(new PutObjectTaggingCommand({
        Bucket: this.bucket,
        Key: s3Key,
        Tagging: {
          TagSet: [{ Key: tagKey, Value: tagValue }],
        },
      }));
      return { s3Key };
    }

    // Premium/Internal: copy emails/ → saved/ for durability past lifecycle expiry.
    // The stored s3Key is left unchanged; readers resolve saved/ by age.
    if (input.copyToSaved) {
      await this.s3.send(new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${s3Key}`,
        Key: toSavedKey(s3Key),
      }));

      return { s3Key };
    }

    // Paid/Lifetime: no-op, default 5-year lifecycle applies
    return { s3Key };
  }
}
