// ---------------------------------------------------------------------------
// HmacSecretGenerator — encapsulates the raw KMS-decrypted secret.
//
// The raw secret NEVER leaves this class. Callers use computeHmac16() and
// validateHmac16() instead of accessing the key material directly.
//
// The encrypted secret is bundled as calendar-hmac.kms alongside this module
// (dist/main/processor/calendar/calendar-hmac.kms). At cold start it's decrypted
// via KMS and cached for the lifetime of the execution environment.
// ---------------------------------------------------------------------------

import { KMSClient, DecryptCommand } from "@aws-sdk/client-kms";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export class HmacSecretGenerator {
  private _secret?: Uint8Array;

  constructor(private readonly kms: KMSClient) {}

  private async getSecret(): Promise<Uint8Array> {
    if (!this._secret) {
      const ciphertext = readFileSync(resolve(import.meta.dirname!, "calendar-hmac.kms"));
      const result = await this.kms.send(new DecryptCommand({ CiphertextBlob: ciphertext }));
      this._secret = new Uint8Array(result.Plaintext!);
    }
    return this._secret;
  }

  /**
   * Compute HMAC-SHA256 over the payload and return the first 16 characters
   * of the base64url-encoded output (no padding).
   */
  async computeHmac16(payload: string): Promise<string> {
    const secret = await this.getSecret();
    return createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 16);
  }

  /**
   * Validate an HMAC by recomputing and comparing.
   */
  async validateHmac16(payload: string, hmac16: string): Promise<boolean> {
    const expected = await this.computeHmac16(payload);
    return hmac16 === expected;
  }
}
