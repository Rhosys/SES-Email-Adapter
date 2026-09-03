import type { S3Client } from "@aws-sdk/client-s3";
import { S3ObjectStorage, type PresignedPost, type UploadField } from "./s3-object-storage.js";
import { effectiveEmailKey } from "./embedding/retention-tier.js";
import type { Signal, EmailSignalData } from "./types/index.js";

const EMAIL_BUCKET = process.env["EMAIL_BUCKET"] ?? "";
const CONTENT_BUCKET = process.env["CONTENT_BUCKET"] ?? "";

// Extracted-content uploads never exceed this. Lives here (business layer) because it is
// a domain limit, not an S3 mechanic — S3ObjectStorage just enforces whatever cap it's given.
const MAX_EXTRACTED_CONTENT_BYTES = 10 * 1024 * 1024;

/** A signed upload ticket handed to the content sanitizer for it to POST objects against. */
export type ContentUploadTicket = PresignedPost<UploadField>;

// ---------------------------------------------------------------------------
// Business-focused stores. Each owns its bucket (resolved from its own env var,
// not injected by callers) and composes an S3ObjectStorage, exposing domain
// operations on top of it. Callers never see a bucket name, an S3 form field, or
// reconstruct a storage key themselves — and never touch S3 directly.
// ---------------------------------------------------------------------------

/** Stores raw inbound/outbound email bodies. */
export class EmailContentStore {
  private readonly storage: S3ObjectStorage;

  constructor(s3Client: S3Client, bucket?: string) {
    this.storage = new S3ObjectStorage(s3Client, bucket ?? EMAIL_BUCKET);
  }

  /** Persist a fetched raw MIME message under the given storage key. */
  async saveRawEmail(s3Key: string, rawMime: Uint8Array | Buffer): Promise<void> {
    await this.storage.putObject(s3Key, rawMime, "message/rfc822");
  }

  /** Short-lived read URL for an already-resolved storage key. */
  async createReadUrl(s3Key: string): Promise<string> {
    return this.storage.createReadUrl(s3Key);
  }

  /** Short-lived read URL for a signal's raw email, resolving the retention-tier storage key. */
  async getRawEmailUrl(signal: Pick<Signal<EmailSignalData>, "createdAt"> & { data: Pick<EmailSignalData, "s3Key"> }): Promise<string> {
    return this.storage.createReadUrl(effectiveEmailKey(signal.data.s3Key, signal.createdAt));
  }
}

/** Stores content derived from emails: extracted attachments, QR/barcode/pkpass assets, calendar invites. */
export class ContentStore {
  private readonly storage: S3ObjectStorage;

  constructor(s3Client: S3Client, bucket?: string) {
    this.storage = new S3ObjectStorage(s3Client, bucket ?? CONTENT_BUCKET);
  }

  /** Read raw bytes back for an extracted-content key. */
  async getContent(s3Key: string): Promise<Uint8Array> {
    return this.storage.getObject(s3Key);
  }

  /**
   * Sign an upload ticket the content sanitizer uses to POST extracted objects under
   * the given key prefix, tagged for the resolved retention tier.
   */
  async createContentUploadTicket(keyPrefix: string, retentionTag: string | null): Promise<ContentUploadTicket> {
    return this.storage.generatePresignedPost({ keyPrefix, maxBytes: MAX_EXTRACTED_CONTENT_BYTES, retentionTag });
  }

  /** Stores a parsed calendar invite's raw .ics bytes under the given key. */
  async saveIcsContentAsCalendar(s3Key: string, rawIcsContent: string): Promise<void> {
    await this.storage.putObject(s3Key, Buffer.from(rawIcsContent, "utf-8"), "text/calendar");
  }
}
