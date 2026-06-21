// ---------------------------------------------------------------------------
// HMAC Secret — encapsulates the raw KMS-decrypted secret.
//
// The raw secret NEVER leaves this module. Callers use computeHmac16() and
// validateHmac16() instead of accessing the key material directly.
//
// The encrypted secret is bundled as calendar-hmac.kms alongside the Lambda
// handler. At cold start, it's decrypted via KMS and cached for the lifetime
// of the execution environment.
// ---------------------------------------------------------------------------

import { KMSClient, DecryptCommand } from "@aws-sdk/client-kms";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const kms = new KMSClient({});

let _secret: Uint8Array | undefined;

async function getSecret(): Promise<Uint8Array> {
  if (!_secret) {
    const ciphertext = readFileSync(resolve(import.meta.dirname!, "calendar-hmac.kms"));
    const result = await kms.send(new DecryptCommand({ CiphertextBlob: ciphertext }));
    _secret = new Uint8Array(result.Plaintext!);
  }
  return _secret;
}

/**
 * Compute HMAC-SHA256 over the payload and return the first 16 characters
 * of the base64url-encoded output (no padding).
 */
export async function computeHmac16(payload: string): Promise<string> {
  const secret = await getSecret();
  return createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 16);
}

/**
 * Validate an HMAC by recomputing and comparing.
 */
export async function validateHmac16(payload: string, hmac16: string): Promise<boolean> {
  const expected = await computeHmac16(payload);
  return hmac16 === expected;
}
