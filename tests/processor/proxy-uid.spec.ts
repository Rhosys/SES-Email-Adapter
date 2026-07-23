import { describe, it, expect, beforeAll } from "vitest";
import { buildProxyUid, validateProxyUid } from "../../src/processor/calendar/proxy-uid.js";
import { makeHmacGeneratorFake } from "../helpers/hmac-generator-fake.js";

// ---------------------------------------------------------------------------
// Injected deterministic HMAC generator — no real KMS. Same 0xAB-filled key the
// assertions in this file were written against.
// ---------------------------------------------------------------------------

const hmac = makeHmacGeneratorFake(new Uint8Array(32).fill(0xAB));

const SERVICE_DOMAIN = "platform.email.rhosys.cloud";

// ---------------------------------------------------------------------------
// Property 9: Proxy UID construction is deterministic and correctly formatted
// Validates: Requirements 11.1, 11.2, 14.6
// ---------------------------------------------------------------------------

describe("buildProxyUid — construction format and determinism (Property 9)", () => {
  const cases = [
    {
      label: "standard IDs produce correct format",
      accountId: "acc-abc123",
      threadId: "arc-def456",
      originalVeventUid: "uid-789",
    },
    {
      label: "short IDs with dashed UID produce correct format",
      accountId: "acc-xyz",
      threadId: "arc-000",
      originalVeventUid: "long-uid-with-dashes",
    },
  ] as const;

  it.each(cases)("$label", async ({ accountId, threadId, originalVeventUid }) => {
    const result = await buildProxyUid({
      accountId,
      threadId,
      originalVeventUid,
      serviceDomain: SERVICE_DOMAIN,
      hmac,
    });

    // Format: {accountId}.{threadId}.{originalVeventUid}.{hmac16}@{serviceDomain}
    const atIndex = result.lastIndexOf("@");
    expect(atIndex).toBeGreaterThan(0);

    const domain = result.slice(atIndex + 1);
    expect(domain).toBe(SERVICE_DOMAIN);

    const localPart = result.slice(0, atIndex);
    const segments = localPart.split(".");

    // At least 4 segments: accountId, threadId, originalVeventUid (may contain dots), hmac16
    expect(segments.length).toBeGreaterThanOrEqual(4);
    expect(segments[0]).toBe(accountId);
    expect(segments[1]).toBe(threadId);

    // HMAC is the last segment — exactly 16 chars of base64url (no padding)
    const hmac16 = segments[segments.length - 1]!;
    expect(hmac16).toHaveLength(16);
    expect(hmac16).toMatch(/^[A-Za-z0-9_-]+$/);

    // originalVeventUid is everything between threadId and hmac16
    const uidSegments = segments.slice(2, -1);
    expect(uidSegments.join(".")).toBe(originalVeventUid);
  });

  it.each(cases)("$label — deterministic across calls", async ({ accountId, threadId, originalVeventUid }) => {
    const opts = { accountId, threadId, originalVeventUid, serviceDomain: SERVICE_DOMAIN, hmac };
    const first = await buildProxyUid(opts);
    const second = await buildProxyUid(opts);
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// Property 12 (partial): HMAC validation — valid, invalid, tampered
// Validates: Requirements 14.2
// ---------------------------------------------------------------------------

describe("validateProxyUid — HMAC validation (Property 12 partial)", () => {
  // Build a valid proxy UID to use as baseline
  let validProxyUid: string;

  beforeAll(async () => {
    validProxyUid = await buildProxyUid({
      accountId: "acc-abc123",
      threadId: "arc-def456",
      originalVeventUid: "uid-789",
      serviceDomain: SERVICE_DOMAIN,
      hmac,
    });
  });

  it("valid proxy UID → ok with correct decomposed parts", async () => {
    const result = await validateProxyUid({ proxyUid: validProxyUid, serviceDomain: SERVICE_DOMAIN, hmac });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ accountId: "acc-abc123", threadId: "arc-def456", originalVeventUid: "uid-789" });
  });

  it("tampered HMAC → err", async () => {
    const tampered = validProxyUid.replace(
      validProxyUid.slice(validProxyUid.lastIndexOf(".") + 1, validProxyUid.lastIndexOf("@")),
      "AAAAAAAAAAAAAAAA",
    );
    const result = await validateProxyUid({ proxyUid: tampered, serviceDomain: SERVICE_DOMAIN, hmac });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("hmac mismatch");
  });

  it("missing @ → err", async () => {
    const result = await validateProxyUid({ proxyUid: validProxyUid.replace("@", "."), serviceDomain: SERVICE_DOMAIN, hmac });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("missing @ separator");
  });

  it("wrong domain → err", async () => {
    const result = await validateProxyUid({ proxyUid: validProxyUid.replace(SERVICE_DOMAIN, "evil.example.com"), serviceDomain: SERVICE_DOMAIN, hmac });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("domain mismatch");
  });

  it("insufficient segments → err", async () => {
    const result = await validateProxyUid({ proxyUid: `onlytwo.segments@${SERVICE_DOMAIN}`, serviceDomain: SERVICE_DOMAIN, hmac });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("insufficient segments in local-part");
  });
});
