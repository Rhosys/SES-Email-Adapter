import { KMSClient, SignCommand } from "@aws-sdk/client-kms";

const kms = new KMSClient({});

/** Base64url-encode without padding. */
function base64url(input: Uint8Array | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : Buffer.from(input);
  return buf.toString("base64url");
}

/**
 * Generate an unsubscribe JWT signed via KMS (Ed25519).
 *
 * The token is self-contained — the unsubscribe endpoint validates the
 * signature and extracts claims without any database lookup.
 */
export async function generateUnsubscribeToken(params: {
  accountId: string;
  forwardingTargetId: string;
  emailType: string;
  apiDomain: string;
  kmsKeyArn: string;
  keyId: string;
}): Promise<string> {
  const { accountId, forwardingTargetId, emailType, apiDomain, kmsKeyArn, keyId } = params;

  const header = { alg: "EdDSA", typ: "JWT", kid: keyId };
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    sub: accountId,
    scope: "unsubscribe",
    resource: `/accounts/${accountId}/targets/${forwardingTargetId}/types/${emailType}`,
    iss: `https://${apiDomain}`,
    iat,
    exp: iat + 5184000,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

  const result = await kms.send(new SignCommand({
    KeyId: kmsKeyArn,
    Message: new TextEncoder().encode(signingInput),
    MessageType: "RAW",
    SigningAlgorithm: "ED25519_SHA_512",
  }));

  const signature = base64url(new Uint8Array(result.Signature!));
  return `${signingInput}.${signature}`;
}
