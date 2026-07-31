import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { ok, err } from "../errors.js";
import type { Result } from "../errors.js";

// ---------------------------------------------------------------------------
// JWKS verification errors — discriminated by `kind` field
// ---------------------------------------------------------------------------

export type JwksVerificationError =
  | { kind: "jwt_invalid_signature" }
  | { kind: "jwt_expired" }
  | { kind: "jwt_claims_mismatch"; claim: string; expected: string; actual: string }
  | { kind: "jwks_fetch_failed"; cause: unknown };

// ---------------------------------------------------------------------------
// Configuration for a JWKS verifier instance
// ---------------------------------------------------------------------------

export interface JwksVerifierConfig {
  jwksUrl: string;
  issuer?: string;
  audience: string;
  additionalClaims?: Record<string, string>; // e.g. { azp: "0bf30f3b..." }
}

// ---------------------------------------------------------------------------
// Factory — creates a verifier bound to a specific JWKS endpoint + expected claims
// ---------------------------------------------------------------------------

export function createVerifier(config: JwksVerifierConfig) {
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl));

  return {
    async verify(token: string): Promise<Result<JWTPayload, JwksVerificationError>> {
      try {
        const options = config.issuer
          ? { issuer: config.issuer, audience: config.audience }
          : { audience: config.audience };
        const { payload } = await jwtVerify(token, jwks, options);

        // Check additional claims (e.g. azp for Microsoft Graph)
        if (config.additionalClaims) {
          for (const [claim, expected] of Object.entries(config.additionalClaims)) {
            const actual = String(payload[claim] ?? "");
            if (actual !== expected) {
              return err({ kind: "jwt_claims_mismatch", claim, expected, actual });
            }
          }
        }

        return ok(payload);
      } catch (e) {
        if (e instanceof Error) {
          if (e.message.includes("expired") || e.name === "JWTExpired") {
            return err({ kind: "jwt_expired" });
          }
          if (e.message.includes("signature") || e.name === "JWSSignatureVerificationFailed") {
            return err({ kind: "jwt_invalid_signature" });
          }
          if (e.message.includes("audience") || e.message.includes("issuer") || e.name === "JWTClaimValidationFailed") {
            const claimMatch = /\"(\w+)\"/.exec(e.message);
            return err({ kind: "jwt_claims_mismatch", claim: claimMatch?.[1] ?? "unknown", expected: "expected", actual: "actual" });
          }
        }
        return err({ kind: "jwks_fetch_failed", cause: e });
      }
    },
  };
}
