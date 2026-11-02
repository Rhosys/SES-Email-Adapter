import { describe, it, expect } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { S3ObjectStorage } from "../../src/s3-object-storage.js";

// Uses the REAL createPresignedPost (presign.spec.ts mocks it) and decodes the signed policy.
// Regression: the SDK signs every `Fields` entry as an exact-match condition, so seeding
// `Fields: { "Content-Type": "" }` produced `{"Content-Type": ""}` in the policy and S3
// rejected every upload carrying a real type with `Policy Condition failed: ["eq", "$Content-Type", ""]`.
const s3 = new S3Client({
  region: "eu-west-1",
  credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
});

async function signedConditions(retentionTag: string | null): Promise<{ conditions: unknown[]; fields: Record<string, string | undefined> }> {
  const ticket = await new S3ObjectStorage(s3, "content-bucket").generatePresignedPost({
    keyPrefix: "accounts/1/extracted/sig/",
    maxBytes: 1024,
    retentionTag,
  });
  const fields = ticket.fields as Record<string, string | undefined>;
  const policy = JSON.parse(Buffer.from(fields.Policy ?? "", "base64").toString("utf8")) as { conditions: unknown[] };
  return { conditions: policy.conditions, fields };
}

describe("S3ObjectStorage.generatePresignedPost signed policy", () => {
  it.each([null, "365"])("does not pin Content-Type/Content-Disposition to a fixed value (retentionTag=%s)", async (retentionTag) => {
    const { conditions } = await signedConditions(retentionTag);

    for (const field of ["Content-Type", "Content-Disposition"]) {
      expect(conditions).toContainEqual(["starts-with", `$${field}`, ""]);
      expect(conditions.some(c => typeof c === "object" && c !== null && !Array.isArray(c) && field in c)).toBe(false);
      expect(conditions.some(c => Array.isArray(c) && c[0] === "eq" && c[1] === `$${field}`)).toBe(false);
    }
  });

  it("signs x-amz-tagging as an exact match and still returns unsigned per-object defaults", async () => {
    const { conditions, fields } = await signedConditions("365");

    expect(conditions).toContainEqual({ "x-amz-tagging": "retention=365" });
    expect(fields["x-amz-tagging"]).toBe("retention=365");
    expect(fields["Content-Type"]).toBe("application/octet-stream");
    expect(fields["Content-Disposition"]).toBe("");
  });
});
