import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@aws-sdk/client-kms", () => {
  const mockSend = vi.fn();
  class SignCommand {
    readonly _kind = "sign";
    constructor(public input: unknown) {}
  }
  class VerifyCommand {
    readonly _kind = "verify";
    constructor(public input: unknown) {}
  }
  return {
    KMSClient: vi.fn(() => ({ send: mockSend })),
    SignCommand,
    VerifyCommand,
    __mockSend: mockSend,
  };
});

import { KMSClient } from "@aws-sdk/client-kms";
import { UnsubscribeTokenGenerator } from "../../src/email/unsubscribe-token-generator.js";

const { __mockSend: mockSend } = await import("@aws-sdk/client-kms") as unknown as { __mockSend: ReturnType<typeof vi.fn> };

const API_DOMAIN = "api.numaeel.com";
const KMS_KEY_ARN = "arn:aws:kms:eu-central-1:342695602194:key/test-key-id";
const KEY_ID = "key-001";
const ACCOUNT_ID = "acct_abc123";

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Hand-build a token with an arbitrary payload — the mocked KMS Verify accepts any signature. */
function makeToken(payload: Record<string, unknown>): string {
  const header = { alg: "EdDSA", typ: "JWT", kid: KEY_ID };
  const sig = Buffer.from(new Uint8Array([1, 2, 3])).toString("base64url");
  return `${b64url(header)}.${b64url(payload)}.${sig}`;
}

function buildGenerator(): UnsubscribeTokenGenerator {
  return new UnsubscribeTokenGenerator(new KMSClient({}), API_DOMAIN, KMS_KEY_ARN, KEY_ID);
}

describe("UnsubscribeTokenGenerator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T12:00:00Z"));
    mockSend.mockImplementation(async (cmd: { _kind: string }) => {
      if (cmd._kind === "sign") return { Signature: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) };
      return { SignatureValid: true };
    });
  });

  describe("generate", () => {
    it("produces a three-part dot-separated token with the account/type resource", async () => {
      const token = await buildGenerator().generate({ accountId: ACCOUNT_ID, emailType: "digest" });

      const parts = token.split(".");
      expect(parts).toHaveLength(3);

      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8"));
      expect(payload.resource).toBe(`/accounts/${ACCOUNT_ID}/types/digest`);
      expect(payload.sub).toBe(ACCOUNT_ID);
      expect(payload.scope).toBe("unsubscribe");
      expect(payload.iss).toBe(`https://${API_DOMAIN}`);
    });
  });

  describe("verify", () => {
    it("round-trips a freshly generated token to ok", async () => {
      const generator = buildGenerator();
      const token = await generator.generate({ accountId: ACCOUNT_ID, emailType: "digest" });

      const result = await generator.verify(token);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({ accountId: ACCOUNT_ID, emailType: "digest" });
    });

    it("returns invalid_signature when KMS Verify throws KMSInvalidSignatureException", async () => {
      const generator = buildGenerator();
      const token = await generator.generate({ accountId: ACCOUNT_ID, emailType: "digest" });

      mockSend.mockImplementation(async (cmd: { _kind: string }) => {
        if (cmd._kind === "sign") return { Signature: new Uint8Array([1, 2, 3]) };
        const error = new Error("bad signature");
        error.name = "KMSInvalidSignatureException";
        throw error;
      });

      const result = await generator.verify(token);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toEqual({ kind: "invalid_signature" });
    });

    it("returns expired when exp is in the past", async () => {
      const iat = Math.floor(Date.now() / 1000) - 10_000;
      const token = makeToken({
        sub: ACCOUNT_ID,
        scope: "unsubscribe",
        resource: `/accounts/${ACCOUNT_ID}/types/digest`,
        iss: `https://${API_DOMAIN}`,
        iat,
        exp: iat + 1,
      });

      const result = await buildGenerator().verify(token);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toEqual({ kind: "expired" });
    });

    it("returns wrong_scope when scope is not unsubscribe", async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = makeToken({
        sub: ACCOUNT_ID,
        scope: "something-else",
        resource: `/accounts/${ACCOUNT_ID}/types/digest`,
        iss: `https://${API_DOMAIN}`,
        iat: now,
        exp: now + 5184000,
      });

      const result = await buildGenerator().verify(token);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toEqual({ kind: "wrong_scope" });
    });

    it("returns wrong_scope when the issuer does not match", async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = makeToken({
        sub: ACCOUNT_ID,
        scope: "unsubscribe",
        resource: `/accounts/${ACCOUNT_ID}/types/digest`,
        iss: "https://attacker.example.com",
        iat: now,
        exp: now + 5184000,
      });

      const result = await buildGenerator().verify(token);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toEqual({ kind: "wrong_scope" });
    });

    it("returns wrong_scope when the email type is not digest", async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = makeToken({
        sub: ACCOUNT_ID,
        scope: "unsubscribe",
        resource: `/accounts/${ACCOUNT_ID}/types/onboarding`,
        iss: `https://${API_DOMAIN}`,
        iat: now,
        exp: now + 5184000,
      });

      const result = await buildGenerator().verify(token);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toEqual({ kind: "wrong_scope" });
    });

    it("returns malformed_token for a non-three-segment string", async () => {
      const result = await buildGenerator().verify("only.two");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toEqual({ kind: "malformed_token" });
    });
  });
});
