import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { ok, err, type Result } from "./errors.js";

// ---------------------------------------------------------------------------
// S3ObjectStorage — the single owner of all S3 dialect.
//
// Everything S3-specific lives here: policy Condition tuples, form-field names
// (key, Content-Type, x-amz-tagging), the createPresignedPost call, and the
// fetch-based multipart upload. Business layers (ContentStore, EmailContentStore)
// depend on this class and speak only domain vocabulary — they never construct a
// Condition or name an S3 form field.
//
// Both runtime halves live on one class on purpose: generatePresignedPost (needs
// the AWS SDK, runs in the processor) and upload (SDK-free fetch, runs in the
// sandboxed content-sanitizer isolate). The AWS SDK is marked external in the
// esbuild config, so importing this class into the isolate does not inline the
// SDK into that bundle.
// ---------------------------------------------------------------------------

/**
 * A signed browser-POST upload ticket. `TField` is the exact union of form-field
 * names the policy signed — the phantom carried statically so the uploader can
 * only set fields the policy sanctioned. S3 rejects any form field its policy did
 * not list ("Extra input fields: <name>"), so the union is the compile-time guard
 * against that class of failure.
 */
export interface PresignedPost<TField extends string> {
  url: string;
  fields: Partial<Record<TField, string>>;
}

/**
 * Domain-level description of an upload ticket to sign. No S3 vocabulary — the
 * caller states intent (where keys may land, how big, how to tag) and this class
 * translates it into policy Conditions and Fields. Both the Conditions array and
 * the signed field union are derived from this one spec, so they cannot drift.
 */
export interface UploadTicketSpec {
  /** All uploaded object keys must start with this prefix. */
  keyPrefix: string;
  /** Maximum object size in bytes. */
  maxBytes: number;
  /** Lifecycle retention tag value, or null for no tag (live forever). */
  retentionTag: string | null;
}

/** The form fields the uploader always injects itself at upload time. */
type UploaderInjectedField = "key" | "Content-Type" | "file";

/** The optional, policy-dependent fields a ticket may additionally carry. */
type TaggingField = "x-amz-tagging";

/** The complete union of fields any ticket in this system can carry. */
export type UploadField = UploaderInjectedField | TaggingField;

export type S3UploadError = { kind: "s3_upload_failed"; reason: string };

const uploadError = (reason: string): S3UploadError => ({ kind: "s3_upload_failed", reason });

export class S3ObjectStorage {
  constructor(
    private readonly s3Client: S3Client,
    private readonly bucket: string,
  ) {}

  /** Read an object's bytes. */
  async getObject(key: string): Promise<Uint8Array> {
    const res = await this.s3Client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body!.transformToByteArray();
  }

  /** A short-lived (30s) presigned GET URL for reading a single object. */
  async createReadUrl(key: string): Promise<string> {
    return getSignedUrl(this.s3Client as unknown as Parameters<typeof getSignedUrl>[0], new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: 30,
    });
  }

  /** Write an object directly (SDK PutObject). */
  async putObject(key: string, body: Uint8Array | Buffer, contentType: string): Promise<void> {
    await this.s3Client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  /**
   * Sign a browser-POST upload ticket from a domain spec. Derives both the policy
   * Conditions and the signed field union here, in one place, so a field cannot be
   * signed without a matching condition or vice versa.
   */
  async generatePresignedPost(spec: UploadTicketSpec): Promise<PresignedPost<UploadField>> {
    const post = await createPresignedPost(this.s3Client, {
      Bucket: this.bucket,
      Key: `${spec.keyPrefix}\${filename}`,
      Conditions: [
        ["starts-with", "$key", spec.keyPrefix],
        // The uploader sets Content-Type per object (message/rfc822, image/png, …). Without
        // this condition S3 rejects the form with "Extra input fields: content-type", since a
        // POST policy sanctions only the fields it explicitly lists.
        ["starts-with", "$Content-Type", ""],
        ["content-length-range", 0, spec.maxBytes],
        ...(spec.retentionTag ? [{ "x-amz-tagging": `retention=${spec.retentionTag}` } as const] : []),
      ],
      Fields: {
        ...(spec.retentionTag ? { "x-amz-tagging": `retention=${spec.retentionTag}` } : {}),
      },
      Expires: 30,
    });

    // The SDK always bakes `key` into the returned fields (from the `Key` param above),
    // but the uploader sets the actual per-object key on each upload — a duplicate `key`
    // field in the FormData makes S3 reject with "POST only supports one key parameter per
    // request". Strip it here; the starts-with policy condition still constrains keys.
    const { key: _templateKey, ...fields } = post.fields;
    return { url: post.url, fields };
  }

  /**
   * Upload a single object to a signed ticket. SDK-free — a plain multipart POST that
   * touches no S3 client, so it is `static`: the content-sanitizer isolate (which holds
   * no AWS credentials) calls it with only the ticket it was handed. The ticket's field
   * union must cover every field this method injects (key, Content-Type, file), so a
   * ticket that never signed those is a compile error.
   */
  static async upload(
    ticket: PresignedPost<UploadField>,
    key: string,
    content: Uint8Array | Buffer,
    contentType: string,
  ): Promise<Result<void, S3UploadError>> {
    const form = new FormData();

    // Every write goes through setField so the field name is checked against the
    // signed union. set() (not append()): S3's exact-match conditions reject a field
    // that appears twice, so a later same-named field must replace an earlier one.
    for (const [field, value] of Object.entries(ticket.fields)) {
      setField(form, field as UploadField, value as string);
    }
    setField(form, "key", key);
    setField(form, "Content-Type", contentType);
    // The file must be the last field.
    setField(form, "file", new Blob([Buffer.from(content)], { type: contentType }));

    try {
      const response = await fetch(ticket.url, { method: "POST", body: form });
      if (response.ok || response.status === 204) return ok(undefined);
      // A presigned POST failure is almost always an expired/mismatched policy (clock
      // skew, a key/condition no longer matching what the URL was signed for) — the body
      // carries the actual S3 error code, worth surfacing.
      let body = "";
      try {
        body = await response.text();
      } catch (e) {
        // best-effort — fall back to the status alone below
        void e;
      }
      return err(uploadError(`HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`));
    } catch (e) {
      return err(uploadError(e instanceof Error ? e.message : "unknown fetch error"));
    }
  }
}

/**
 * The only path that writes a field onto an upload form. `name` is constrained to the
 * signed field union, so a stray or mistyped field name (e.g. lowercase "content-type")
 * is a compile error instead of a runtime S3 "Extra input fields" rejection.
 */
function setField(form: FormData, name: UploadField, value: string | Blob): void {
  form.set(name, value);
}
