import { KMSClient, SignCommand, VerifyCommand } from "@aws-sdk/client-kms";
import { ok, err } from "../errors.js";
import type { Result } from "../errors.js";

// ---------------------------------------------------------------------------
// Unsubscribe token generator
//
// Signs and verifies self-contained unsubscribe JWTs (EdDSA via KMS). The
// unsubscribe endpoint validates the signature and extracts claims without any
// database lookup — the signed token is the credential (RFC 8058 one-click).
// ---------------------------------------------------------------------------

export type UnsubscribeVerifyError =
  | { kind: "malformed_token" }
  | { kind: "invalid_signature" }
  | { kind: "expired" }
  | { kind: "wrong_scope" }
  | { kind: "verify_error"; cause: unknown };

/** Base64url-encode without padding. */
function base64url(input: Uint8Array | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : Buffer.from(input);
  return buf.toString("base64url");
}

const RESOURCE_PATTERN = /^\/accounts\/([^/]+)\/types\/([^/]+)$/;

export class UnsubscribeTokenGenerator {
  constructor(
    private readonly kms: KMSClient,
    private readonly apiDomain: string,
    private readonly kmsKeyArn: string,
    private readonly keyId: string,
  ) {}

  async generate(params: { accountId: string; emailType: "digest" }): Promise<string> {
    const { accountId, emailType } = params;

    const header = { alg: "EdDSA", typ: "JWT", kid: this.keyId };
    const iat = Math.floor(Date.now() / 1000);
    const payload = {
      sub: accountId,
      scope: "unsubscribe",
      resource: `/accounts/${accountId}/types/${emailType}`,
      iss: `https://${this.apiDomain}`,
      iat,
      exp: iat + 5184000,
    };

    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

    const result = await this.kms.send(new SignCommand({
      KeyId: this.kmsKeyArn,
      Message: new TextEncoder().encode(signingInput),
      MessageType: "RAW",
      SigningAlgorithm: "ED25519_SHA_512",
    }));

    const signature = base64url(new Uint8Array(result.Signature!));
    return `${signingInput}.${signature}`;
  }

  async verify(token: string): Promise<Result<{ accountId: string; emailType: "digest" }, UnsubscribeVerifyError>> {
    const segments = token.split(".");
    if (segments.length !== 3) return err({ kind: "malformed_token" });

    const [headerB64, payloadB64, signatureB64] = segments as [string, string, string];
    const signingInput = `${headerB64}.${payloadB64}`;

    let payload: { sub?: unknown; scope?: unknown; resource?: unknown; iss?: unknown; exp?: unknown };
    let signature: Uint8Array;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8"));
      signature = new Uint8Array(Buffer.from(signatureB64, "base64url"));
    } catch {
      return err({ kind: "malformed_token" });
    }

    let verifyResult: { SignatureValid?: boolean | undefined };
    try {
      verifyResult = await this.kms.send(new VerifyCommand({
        KeyId: this.kmsKeyArn,
        Message: new TextEncoder().encode(signingInput),
        MessageType: "RAW",
        Signature: signature,
        SigningAlgorithm: "ED25519_SHA_512",
      }));
    } catch (e) {
      if (e instanceof Error && e.name === "KMSInvalidSignatureException") return err({ kind: "invalid_signature" });
      return err({ kind: "verify_error", cause: e });
    }

    if (verifyResult.SignatureValid === false) return err({ kind: "invalid_signature" });

    if (payload.scope !== "unsubscribe") return err({ kind: "wrong_scope" });
    if (payload.iss !== `https://${this.apiDomain}`) return err({ kind: "wrong_scope" });

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp < now) return err({ kind: "expired" });

    if (typeof payload.resource !== "string") return err({ kind: "malformed_token" });
    const match = RESOURCE_PATTERN.exec(payload.resource);
    if (!match) return err({ kind: "malformed_token" });

    const accountId = match[1]!;
    const emailType = match[2]!;
    if (payload.sub !== accountId) return err({ kind: "wrong_scope" });
    if (emailType !== "digest") return err({ kind: "wrong_scope" });

    return ok({ accountId, emailType: "digest" });
  }
}
