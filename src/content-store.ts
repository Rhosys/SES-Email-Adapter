import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
}

export interface ContentStore {
  getSignedUrl(key: string): Promise<string>;
  getObject(key: string): Promise<Uint8Array>;
  putObject(key: string, body: Uint8Array | Buffer, contentType: string): Promise<void>;
  getPresignedPost(keyPrefix: string, retentionTag: string | null): Promise<PresignedPost>;
}

export class S3ContentStore implements ContentStore {
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
    return createPresignedPost(this.s3Client, {
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
  }
}
