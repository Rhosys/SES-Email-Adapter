import { computeHmac16, validateHmac16 } from "../../crypto/hmac-secret.js";
import type { Result } from "neverthrow";
import { ok, err } from "neverthrow";

/**
 * Construct a proxy UID for forwarding calendar invites.
 *
 * Format: {accountId}.{arcId}.{originalVeventUid}.{hmac16}@{serviceDomain}
 *
 * The HMAC is computed over "{accountId}.{arcId}.{originalVeventUid}" using
 * the encapsulated 32-byte secret, then truncated to 16 chars of base64url (no padding).
 */
export async function buildProxyUid(opts: {
  accountId: string;
  arcId: string;
  originalVeventUid: string;
  serviceDomain: string;
}): Promise<string> {
  const payload = `${opts.accountId}.${opts.arcId}.${opts.originalVeventUid}`;
  const hmac16 = await computeHmac16(payload);
  return `${payload}.${hmac16}@${opts.serviceDomain}`;
}

/**
 * Validate and decompose an inbound proxy UID.
 *
 * Splits the UID into its components, recomputes the HMAC, and compares
 * the first 16 characters. Returns the decomposed parts on success,
 * or an error string on failure.
 */
export async function validateProxyUid(opts: {
  proxyUid: string;
  serviceDomain: string;
}): Promise<Result<{ accountId: string; arcId: string; originalVeventUid: string }, string>> {
  // Split on @ to separate local-part from domain
  const atIndex = opts.proxyUid.lastIndexOf("@");
  if (atIndex === -1) {
    return err("missing @ separator");
  }

  const localPart = opts.proxyUid.slice(0, atIndex);
  const domain = opts.proxyUid.slice(atIndex + 1);

  if (domain !== opts.serviceDomain) {
    return err("domain mismatch");
  }

  // Split local-part into segments: accountId, arcId, originalVeventUid, hmac16
  // The originalVeventUid may contain dots, so we need at least 4 segments.
  // The last segment is the hmac16, the first is accountId, the second is arcId,
  // and everything in between is the originalVeventUid.
  const segments = localPart.split(".");
  if (segments.length < 4) {
    return err("insufficient segments in local-part");
  }

  const accountId = segments[0]!;
  const arcId = segments[1]!;
  const hmac16 = segments[segments.length - 1]!;
  const originalVeventUid = segments.slice(2, -1).join(".");

  if (!accountId || !arcId || !originalVeventUid || !hmac16) {
    return err("empty segment in proxy UID");
  }

  // Recompute HMAC and compare
  const payload = `${accountId}.${arcId}.${originalVeventUid}`;
  const valid = await validateHmac16(payload, hmac16);

  if (!valid) {
    return err("hmac mismatch");
  }

  return ok({ accountId, arcId, originalVeventUid });
}
