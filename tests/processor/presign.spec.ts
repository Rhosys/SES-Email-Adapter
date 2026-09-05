import { describe, it, expect, vi } from "vitest";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { S3ObjectStorage } from "../../src/s3-object-storage.js";

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_client, command, options) => {
    return `https://s3.signed/${command.input.Bucket}/${command.input.Key}?expires=${options.expiresIn}`;
  }),
}));

vi.mock("@aws-sdk/s3-presigned-post", () => ({
  createPresignedPost: vi.fn(async (_client, params) => ({
    url: `https://s3.post/${params.Bucket}`,
    fields: {
      key: params.Key,
      ...params.Fields,
    },
    __params: params,
  })),
}));

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

const fakeS3 = {} as S3Client;

describe("S3ObjectStorage.createReadUrl", () => {
  it("calls getSignedUrl with GetObjectCommand and 30s expiry", async () => {
    const storage = new S3ObjectStorage(fakeS3, "my-bucket");
    const url = await storage.createReadUrl("emails/abc.eml");

    expect(getSignedUrl).toHaveBeenCalledWith(
      fakeS3,
      expect.any(GetObjectCommand),
      { expiresIn: 30 },
    );

    const command = vi.mocked(getSignedUrl).mock.calls[0]![1] as GetObjectCommand;
    expect(command.input.Bucket).toBe("my-bucket");
    expect(command.input.Key).toBe("emails/abc.eml");
    expect(url).toContain("my-bucket");
    expect(url).toContain("emails/abc.eml");
  });
});

describe("S3ObjectStorage.generatePresignedPost", () => {
  it("signs key, Content-Type, and size conditions without tagging when retentionTag is null", async () => {
    const storage = new S3ObjectStorage(fakeS3, "content-bucket");
    const result = await storage.generatePresignedPost({
      keyPrefix: "accounts/123/senders/example.com/extracted/sig1/",
      maxBytes: 10 * 1024 * 1024,
      retentionTag: null,
    });

    expect(createPresignedPost).toHaveBeenCalledWith(fakeS3, {
      Bucket: "content-bucket",
      Key: "accounts/123/senders/example.com/extracted/sig1/${filename}",
      Conditions: [
        ["starts-with", "$key", "accounts/123/senders/example.com/extracted/sig1/"],
        ["starts-with", "$Content-Type", ""],
        ["starts-with", "$Content-Disposition", ""],
        ["content-length-range", 0, 10 * 1024 * 1024],
      ],
      Fields: {},
      Expires: 30,
    });

    expect(result.url).toBe("https://s3.post/content-bucket");
    expect(result.fields).not.toHaveProperty("x-amz-tagging");
  });

  it("includes tagging condition and field when retentionTag is '365'", async () => {
    const storage = new S3ObjectStorage(fakeS3, "content-bucket");
    await storage.generatePresignedPost({
      keyPrefix: "accounts/456/senders/test.org/extracted/sig2/",
      maxBytes: 10 * 1024 * 1024,
      retentionTag: "365",
    });

    expect(createPresignedPost).toHaveBeenCalledWith(fakeS3, {
      Bucket: "content-bucket",
      Key: "accounts/456/senders/test.org/extracted/sig2/${filename}",
      Conditions: [
        ["starts-with", "$key", "accounts/456/senders/test.org/extracted/sig2/"],
        ["starts-with", "$Content-Type", ""],
        ["starts-with", "$Content-Disposition", ""],
        ["content-length-range", 0, 10 * 1024 * 1024],
        { "x-amz-tagging": "retention=365" },
      ],
      Fields: {
        "x-amz-tagging": "retention=365",
      },
      Expires: 30,
    });
  });

  it("includes tagging condition and field when retentionTag is '3650'", async () => {
    const storage = new S3ObjectStorage(fakeS3, "content-bucket");
    const result = await storage.generatePresignedPost({
      keyPrefix: "accounts/789/senders/long.com/extracted/sig3/",
      maxBytes: 10 * 1024 * 1024,
      retentionTag: "3650",
    });

    expect(createPresignedPost).toHaveBeenCalledWith(fakeS3, {
      Bucket: "content-bucket",
      Key: "accounts/789/senders/long.com/extracted/sig3/${filename}",
      Conditions: [
        ["starts-with", "$key", "accounts/789/senders/long.com/extracted/sig3/"],
        ["starts-with", "$Content-Type", ""],
        ["starts-with", "$Content-Disposition", ""],
        ["content-length-range", 0, 10 * 1024 * 1024],
        { "x-amz-tagging": "retention=3650" },
      ],
      Fields: {
        "x-amz-tagging": "retention=3650",
      },
      Expires: 30,
    });

    expect(result.fields["x-amz-tagging"]).toBe("retention=3650");
  });
});
