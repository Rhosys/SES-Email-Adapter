import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface ContentStore {
  getSignedUrl(key: string): Promise<string>;
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
}
