import { createHash } from "node:crypto";

const MAX_LENGTH = 64;

/**
 * Build a schedule name: {accountId}.{signalId}.{suffix}
 * If full name exceeds 64 chars, suffix is replaced with base64url(SHA1(suffix)) sliced to fit.
 * Pattern constraint: [0-9a-zA-Z-_.]+
 */
export function buildScheduleName(accountId: string, signalId: string, suffix: string): string {
  const prefix = `${accountId}.${signalId}.`;
  const fullName = `${prefix}${suffix}`;

  if (fullName.length <= MAX_LENGTH) {
    return fullName;
  }

  const budget = MAX_LENGTH - prefix.length;
  const hash = createHash("sha1").update(suffix).digest("base64url");
  return `${prefix}${hash.slice(0, budget)}`;
}
