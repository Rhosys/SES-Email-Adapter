import { S3Client, PutObjectTaggingCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { S3_PREFIXES } from "./retention-tier.js";

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
 * - Free/Beta (s3Tag set): PutObjectTagging with retention-tier=P1Y on inbox/{key}
 * - Paid/Lifetime (s3Tag null, copyToSaved false): no-op, return original s3Key
 * - Premium/Internal (copyToSaved true): CopyObject inbox/{key} → saved/{key}, return new s3Key
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

    // Premium/Internal: copy from inbox/ to saved/
    if (input.copyToSaved) {
      const objectName = stripInboxPrefix(s3Key);
      const newKey = `${S3_PREFIXES.SAVED}${objectName}`;

      await this.s3.send(new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${s3Key}`,
        Key: newKey,
      }));

      return { s3Key: newKey };
    }

    // Paid/Lifetime: no-op, default 5-year lifecycle applies
    return { s3Key };
  }
}

/**
 * Strips the 'inbox/' prefix from an S3 key to get the bare object name.
 * If the key doesn't start with 'inbox/', returns it unchanged.
 */
function stripInboxPrefix(key: string): string {
  if (key.startsWith(S3_PREFIXES.INBOX)) {
    return key.slice(S3_PREFIXES.INBOX.length);
  }
  return key;
}
