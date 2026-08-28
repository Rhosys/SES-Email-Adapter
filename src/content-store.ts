import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { effectiveEmailKey } from "./embedding/retention-tier.js";
import type { Signal, EmailSignalData } from "./types/index.js";

const EMAIL_BUCKET = process.env["EMAIL_BUCKET"] ?? "";
const CONTENT_BUCKET = process.env["CONTENT_BUCKET"] ?? "";

export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
}

export class S3ContentStore {
  constructor(
    private readonly s3Client: S3Client,
    private readonly bucket: string,
  ) {}

  async getSignedUrl(key: string): Promise<string> {
    return getSignedUrl(this.s3Client as unknown as Parameters<typeof getSignedUrl>[0], new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: 30,
    });
  }

  async getObject(key: string): Promise<Uint8Array> {
    const res = await this.s3Client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body!.transformToByteArray();
  }

  async putObject(key: string, body: Uint8Array | Buffer, contentType: string): Promise<void> {
    await this.s3Client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async getPresignedPost(keyPrefix: string, retentionTag: string | null): Promise<PresignedPost> {
    const post = await createPresignedPost(this.s3Client, {
      Bucket: this.bucket,
      Key: `${keyPrefix}\${filename}`,
      Conditions: [
        ["starts-with", "$key", keyPrefix],
        ["content-length-range", 0, 10 * 1024 * 1024],
        ...(retentionTag ? [{ "x-amz-tagging": `retention=${retentionTag}` } as const] : []),
      ],
      Fields: {
        ...(retentionTag ? { "x-amz-tagging": `retention=${retentionTag}` } : {}),
      },
      Expires: 30,
    });

    // The SDK always bakes `key` into the returned fields (from the `Key` param above),
    // but the content sanitizer sets the actual per-object key on each upload — a duplicate
    // `key` field in the FormData causes S3 to reject with "POST only supports one key
    // parameter per request". Strip it here; the `starts-with` policy condition still
    // constrains which keys are allowed.
    const { key: _templateKey, ...fields } = post.fields;
    return { url: post.url, fields };
  }
}

// ---------------------------------------------------------------------------
// Business-focused stores. Each owns its bucket (resolved from its own env var,
// not injected by callers) and exposes domain operations on top of the raw
// S3ContentStore primitive, so callers never need to know a bucket name or
// reconstruct a storage key themselves.
// ---------------------------------------------------------------------------

/** Stores raw inbound/outbound email bodies. */
export class EmailContentStore extends S3ContentStore {
  constructor(s3Client: S3Client, bucket?: string) {
    super(s3Client, bucket ?? EMAIL_BUCKET);
  }

  /** Presigned URL for a signal's raw email, resolving the retention-tier storage key. */
  async getRawEmailUrl(signal: Pick<Signal<EmailSignalData>, "createdAt"> & { data: Pick<EmailSignalData, "s3Key"> }): Promise<string> {
    return this.getSignedUrl(effectiveEmailKey(signal.data.s3Key, signal.createdAt));
  }
}

/** Stores content derived from emails: extracted attachments, QR/barcode/pkpass assets, calendar invites. */
export class ContentStore extends S3ContentStore {
  constructor(s3Client: S3Client, bucket?: string) {
    super(s3Client, bucket ?? CONTENT_BUCKET);
  }

  /** Stores a parsed calendar invite's raw .ics bytes under the given key. */
  async saveIcsContentAsCalendar(s3Key: string, rawIcsContent: string): Promise<void> {
    await this.putObject(s3Key, Buffer.from(rawIcsContent, "utf-8"), "text/calendar");
  }
}
