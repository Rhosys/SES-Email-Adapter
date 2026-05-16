import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import type { S3RetentionTag } from "./retention.js";

/**
 * Generates a pre-signed GET URL for reading an object from S3.
 * Used to give the Content Sanitizer Lambda access to the raw MIME message
 * without granting it IAM permissions.
 */
export async function generatePresignedGet(
  s3Client: S3Client,
  bucket: string,
  key: string,
): Promise<string> {
  // Cast required: exactOptionalPropertyTypes conflicts with AWS SDK's internal types
  return getSignedUrl(s3Client as unknown as Parameters<typeof getSignedUrl>[0], new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: 30,
  });
}

/**
 * Generates a pre-signed POST for uploading extracted content to S3.
 * The POST is scoped to a specific key prefix (per-signal isolation) and
 * includes a content-length limit of 10MB. If a retention tag is provided,
 * it's included as a tagging condition so uploaded objects get the correct
 * lifecycle rule applied.
 */
export async function generatePresignedPost(
  s3Client: S3Client,
  bucket: string,
  keyPrefix: string,
  retentionTag: S3RetentionTag,
): Promise<{ url: string; fields: Record<string, string> }> {
  return createPresignedPost(s3Client, {
    Bucket: bucket,
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
