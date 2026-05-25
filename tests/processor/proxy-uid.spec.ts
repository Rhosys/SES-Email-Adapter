import { describe, it, expect } from "vitest";
import { buildProxyUid, validateProxyUid } from "../../src/processor/calendar/proxy-uid.js";

// Static 32-byte HMAC secret for deterministic tests
const TEST_SECRET = new Uint8Array(32).fill(0xAB);
const SERVICE_DOMAIN = "cal.numaeel.com";

// ---------------------------------------------------------------------------
// Property 9: Proxy UID construction is deterministic and correctly formatted
// Validates: Requirements 11.1, 11.2, 14.6
// ---------------------------------------------------------------------------

describe("buildProxyUid — construction format and determinism (Property 9)", () => {
  const cases = [
    {
      label: "standard IDs produce correct format",
      accountId: "acc-abc123",
      arcId: "arc-def456",
      originalVeventUid: "uid-789",
    },
    {
      label: "short IDs with dashed UID produce correct format",
      accountId: "acc-xyz",
      arcId: "arc-000",
      originalVeventUid: "long-uid-with-dashes",
    },
  ] as const;

  it.each(cases)("$label", ({ accountId, arcId, originalVeventUid }) => {
    const result = buildProxyUid({
      accountId,
      arcId,
      originalVeventUid,
      hmacSecret: TEST_SECRET,
      serviceDomain: SERVICE_DOMAIN,
    });

    // Format: {accountId}.{arcId}.{originalVeventUid}.{hmac16}@{serviceDomain}
    const atIndex = result.lastIndexOf("@");
    expect(atIndex).toBeGreaterThan(0);

    const domain = result.slice(atIndex + 1);
    expect(domain).toBe(SERVICE_DOMAIN);

    const localPart = result.slice(0, atIndex);
    const segments = localPart.split(".");

    // At least 4 segments: accountId, arcId, originalVeventUid (may contain dots), hmac16
    expect(segments.length).toBeGreaterThanOrEqual(4);
    expect(segments[0]).toBe(accountId);
    expect(segments[1]).toBe(arcId);

    // HMAC is the last segment — exactly 16 chars of base64url (no padding)
    const hmac16 = segments[segments.length - 1]!;
    expect(hmac16).toHaveLength(16);
    expect(hmac16).toMatch(/^[A-Za-z0-9_-]+$/);

    // originalVeventUid is everything between arcId and hmac16
    const uidSegments = segments.slice(2, -1);
    expect(uidSegments.join(".")).toBe(originalVeventUid);
  });

  it.each(cases)("$label — deterministic across calls", ({ accountId, arcId, originalVeventUid }) => {
    const opts = { accountId, arcId, originalVeventUid, hmacSecret: TEST_SECRET, serviceDomain: SERVICE_DOMAIN };
    const first = buildProxyUid(opts);
    const second = buildProxyUid(opts);
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// Property 12 (partial): HMAC validation — valid, invalid, tampered
// Validates: Requirements 14.2
// ---------------------------------------------------------------------------

describe("validateProxyUid — HMAC validation (Property 12 partial)", () => {
  // Build a valid proxy UID to use as baseline
  const validProxyUid = buildProxyUid({
    accountId: "acc-abc123",
    arcId: "arc-def456",
    originalVeventUid: "uid-789",
    hmacSecret: TEST_SECRET,
    serviceDomain: SERVICE_DOMAIN,
  });

  const validCases = [
    {
      label: "valid proxy UID → ok with correct decomposed parts",
      proxyUid: validProxyUid,
      hmacSecret: TEST_SECRET,
      serviceDomain: SERVICE_DOMAIN,
      expected: { accountId: "acc-abc123", arcId: "arc-def456", originalVeventUid: "uid-789" },
    },
  ] as const;

  it.each(validCases)("$label", ({ proxyUid, hmacSecret, serviceDomain, expected }) => {
    const result = validateProxyUid({ proxyUid, hmacSecret, serviceDomain });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(expected);
  });

  const invalidCases = [
    {
      label: "tampered HMAC → err",
      proxyUid: validProxyUid.replace(
        validProxyUid.slice(validProxyUid.lastIndexOf(".") + 1, validProxyUid.lastIndexOf("@")),
        "AAAAAAAAAAAAAAAA",
      ),
      hmacSecret: TEST_SECRET,
      serviceDomain: SERVICE_DOMAIN,
      expectedError: "hmac mismatch",
    },
    {
      label: "wrong secret → err",
      proxyUid: validProxyUid,
      hmacSecret: new Uint8Array(32).fill(0xFF),
      serviceDomain: SERVICE_DOMAIN,
      expectedError: "hmac mismatch",
    },
    {
      label: "missing @ → err",
      proxyUid: validProxyUid.replace("@", "."),
      hmacSecret: TEST_SECRET,
      serviceDomain: SERVICE_DOMAIN,
      expectedError: "missing @ separator",
    },
    {
      label: "wrong domain → err",
      proxyUid: validProxyUid.replace(SERVICE_DOMAIN, "evil.example.com"),
      hmacSecret: TEST_SECRET,
      serviceDomain: SERVICE_DOMAIN,
      expectedError: "domain mismatch",
    },
    {
      label: "insufficient segments → err",
      proxyUid: `onlytwo.segments@${SERVICE_DOMAIN}`,
      hmacSecret: TEST_SECRET,
      serviceDomain: SERVICE_DOMAIN,
      expectedError: "insufficient segments in local-part",
    },
  ] as const;

  it.each(invalidCases)("$label", ({ proxyUid, hmacSecret, serviceDomain, expectedError }) => {
    const result = validateProxyUid({ proxyUid, hmacSecret, serviceDomain });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(expectedError);
  });
});
