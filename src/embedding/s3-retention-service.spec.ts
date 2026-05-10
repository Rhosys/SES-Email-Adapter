import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client, PutObjectTaggingCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { S3RetentionServiceImpl } from "./s3-retention-service.js";
import type { S3RetentionInput } from "./s3-retention-service.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const s3Mock = mockClient(S3Client);
const BUCKET = "test-email-bucket";

let service: S3RetentionServiceImpl;

beforeEach(() => {
  s3Mock.reset();
  service = new S3RetentionServiceImpl(s3Mock as unknown as S3Client, BUCKET);
});

// ---------------------------------------------------------------------------
// Free/Beta tier: PutObjectTagging with retention-tier=P1Y
// ---------------------------------------------------------------------------

describe("applyPlanRetention — Free/Beta tier (s3Tag set)", () => {
  const input: S3RetentionInput = {
    s3Tag: "retention-tier=P1Y",
    copyToSaved: false,
  };

  it("calls PutObjectTagging with retention-tier=P1Y", async () => {
    s3Mock.on(PutObjectTaggingCommand).resolves({});

    const s3Key = "inbox/2025/01/abc123.eml";
    await service.applyPlanRetention(s3Key, input);

    const calls = s3Mock.commandCalls(PutObjectTaggingCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      Bucket: BUCKET,
      Key: s3Key,
      Tagging: {
        TagSet: [{ Key: "retention-tier", Value: "P1Y" }],
      },
    });
  });

  it("returns the original s3Key unchanged", async () => {
    s3Mock.on(PutObjectTaggingCommand).resolves({});

    const s3Key = "inbox/2025/01/abc123.eml";
    const result = await service.applyPlanRetention(s3Key, input);

    expect(result.s3Key).toBe(s3Key);
  });

  it("does not call CopyObject", async () => {
    s3Mock.on(PutObjectTaggingCommand).resolves({});

    await service.applyPlanRetention("inbox/x.eml", input);

    const copyCalls = s3Mock.commandCalls(CopyObjectCommand);
    expect(copyCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Paid/Lifetime tier: no-op (s3Tag null, copyToSaved false)
// ---------------------------------------------------------------------------

describe("applyPlanRetention — Paid/Lifetime tier (no-op)", () => {
  const input: S3RetentionInput = {
    s3Tag: null,
    copyToSaved: false,
  };

  it("does not call PutObjectTagging", async () => {
    const s3Key = "inbox/2025/01/abc123.eml";
    await service.applyPlanRetention(s3Key, input);

    const tagCalls = s3Mock.commandCalls(PutObjectTaggingCommand);
    expect(tagCalls).toHaveLength(0);
  });

  it("does not call CopyObject", async () => {
    const s3Key = "inbox/2025/01/abc123.eml";
    await service.applyPlanRetention(s3Key, input);

    const copyCalls = s3Mock.commandCalls(CopyObjectCommand);
    expect(copyCalls).toHaveLength(0);
  });

  it("returns the original s3Key unchanged", async () => {
    const s3Key = "inbox/2025/01/abc123.eml";
    const result = await service.applyPlanRetention(s3Key, input);

    expect(result.s3Key).toBe(s3Key);
  });
});

// ---------------------------------------------------------------------------
// Premium/Internal tier: CopyObject inbox/ → saved/
// ---------------------------------------------------------------------------

describe("applyPlanRetention — Premium/Internal tier (copyToSaved)", () => {
  const input: S3RetentionInput = {
    s3Tag: null,
    copyToSaved: true,
  };

  it("calls CopyObject from inbox/ to saved/", async () => {
    s3Mock.on(CopyObjectCommand).resolves({});

    const s3Key = "inbox/2025/01/abc123.eml";
    await service.applyPlanRetention(s3Key, input);

    const calls = s3Mock.commandCalls(CopyObjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      Bucket: BUCKET,
      CopySource: `${BUCKET}/${s3Key}`,
      Key: "saved/2025/01/abc123.eml",
    });
  });

  it("returns the new saved/ s3Key", async () => {
    s3Mock.on(CopyObjectCommand).resolves({});

    const s3Key = "inbox/2025/01/abc123.eml";
    const result = await service.applyPlanRetention(s3Key, input);

    expect(result.s3Key).toBe("saved/2025/01/abc123.eml");
  });

  it("does not call PutObjectTagging", async () => {
    s3Mock.on(CopyObjectCommand).resolves({});

    await service.applyPlanRetention("inbox/x.eml", input);

    const tagCalls = s3Mock.commandCalls(PutObjectTaggingCommand);
    expect(tagCalls).toHaveLength(0);
  });

  it("handles keys without inbox/ prefix gracefully", async () => {
    s3Mock.on(CopyObjectCommand).resolves({});

    // Edge case: key doesn't start with inbox/ (shouldn't happen in practice)
    const s3Key = "emails/2025/01/abc123.eml";
    const result = await service.applyPlanRetention(s3Key, input);

    expect(result.s3Key).toBe("saved/emails/2025/01/abc123.eml");
  });
});
