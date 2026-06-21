import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@aws-sdk/client-kms", () => {
  const mockSend = vi.fn();
  return {
    KMSClient: vi.fn(() => ({ send: mockSend })),
    SignCommand: vi.fn(),
    __mockSend: mockSend,
  };
});

import { generateUnsubscribeToken } from "../../src/email/unsubscribe-token.js";

const { __mockSend: mockSend } = await import("@aws-sdk/client-kms") as unknown as { __mockSend: ReturnType<typeof vi.fn> };
const { SignCommand } = await import("@aws-sdk/client-kms");

describe("generateUnsubscribeToken", () => {
  const params = {
    accountId: "acct_abc123",
    forwardingTargetId: "tgt_xyz",
    emailType: "digest",
    apiDomain: "api.numaeel.com",
    kmsKeyArn: "arn:aws:kms:eu-central-1:342695602194:key/test-key-id",
    keyId: "key-001",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T12:00:00Z"));
    mockSend.mockResolvedValue({ Signature: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) });
  });

  it("returns a three-part dot-separated JWT", async () => {
    const token = await generateUnsubscribeToken(params);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
  });

  it("encodes the correct header with alg, typ, and kid", async () => {
    const token = await generateUnsubscribeToken(params);
    const [headerB64] = token.split(".");
    const header = JSON.parse(Buffer.from(headerB64!, "base64url").toString("utf-8"));

    expect(header).toEqual({ alg: "EdDSA", typ: "JWT", kid: "key-001" });
  });

  it("encodes the correct payload with sub, scope, resource, iss, iat, exp", async () => {
    const token = await generateUnsubscribeToken(params);
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf-8"));

    const expectedIat = Math.floor(new Date("2024-06-15T12:00:00Z").getTime() / 1000);
    expect(payload).toEqual({
      sub: "acct_abc123",
      scope: "unsubscribe",
      resource: "/accounts/acct_abc123/targets/tgt_xyz/types/digest",
      iss: "https://api.numaeel.com",
      iat: expectedIat,
      exp: expectedIat + 5184000,
    });
  });

  it("calls KMS Sign with correct parameters", async () => {
    await generateUnsubscribeToken(params);

    expect(SignCommand).toHaveBeenCalledWith(expect.objectContaining({
      KeyId: params.kmsKeyArn,
      MessageType: "RAW",
      SigningAlgorithm: "ED25519_SHA_512",
    }));
  });

  it("passes the header.payload as Message to KMS", async () => {
    const token = await generateUnsubscribeToken(params);
    const signingInput = token.split(".").slice(0, 2).join(".");

    const callArgs = vi.mocked(SignCommand).mock.calls[0]![0] as { Message: Uint8Array };
    const sentMessage = new TextDecoder().decode(callArgs.Message);
    expect(sentMessage).toBe(signingInput);
  });

  it("base64url-encodes the signature without padding", async () => {
    mockSend.mockResolvedValue({ Signature: new Uint8Array([255, 254, 253]) });

    const token = await generateUnsubscribeToken(params);
    const [, , sig] = token.split(".");

    expect(sig).toBe(Buffer.from(new Uint8Array([255, 254, 253])).toString("base64url"));
    expect(sig).not.toContain("=");
    expect(sig).not.toContain("+");
    expect(sig).not.toContain("/");
  });

  it("exp is exactly 60 days (5184000 seconds) after iat", async () => {
    const token = await generateUnsubscribeToken(params);
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf-8"));

    expect(payload.exp - payload.iat).toBe(5184000);
  });
});
