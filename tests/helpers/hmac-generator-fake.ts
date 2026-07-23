import { createHmac } from "node:crypto";
import type { HmacSecretGenerator } from "../../src/processor/calendar/hmac-secret-generator.js";

// ---------------------------------------------------------------------------
// Deterministic HmacSecretGenerator fake for tests — mirrors the class's public
// surface (computeHmac16 / validateHmac16) using a fixed key, with no KMS call.
//
// The cast to HmacSecretGenerator is required because the real class holds
// private fields (_secret, kms) that a structural stub cannot satisfy; the
// consumer only ever calls the two public methods, so the fake is behaviourally
// complete. Callers pass the SAME key the file's assertions were written against.
// ---------------------------------------------------------------------------

export function makeHmacGeneratorFake(secret: Uint8Array = new Uint8Array(32)): HmacSecretGenerator {
  const computeHmac16 = (payload: string): Promise<string> =>
    Promise.resolve(createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 16));
  return {
    computeHmac16,
    validateHmac16: async (payload: string, hmac16: string): Promise<boolean> =>
      (await computeHmac16(payload)) === hmac16,
  } as unknown as HmacSecretGenerator;
}
