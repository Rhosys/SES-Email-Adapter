import { describe, it, expect, vi } from "vitest";
import {
  parseSyncCursor,
  formatSyncCursor,
  parseProviderMessageId,
  formatProviderMessageId,
  createImapClient,
} from "../../src/external-exchanges/imap-adapter.js";
import type { ImapFlowOptions } from "imapflow";

vi.mock("imapflow", () => {
  return {
    ImapFlow: class MockImapFlow {
      readonly passedOptions: ImapFlowOptions;
      constructor(options: ImapFlowOptions) {
        this.passedOptions = options;
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Property 1: syncCursor round-trip
// Validates: Requirements 3.4, 3.5, 4.1
// ---------------------------------------------------------------------------

describe("syncCursor round-trip", () => {
  it.each([
    { uidvalidity: 0, lastUid: 0, label: "both zero" },
    { uidvalidity: 1, lastUid: 1, label: "both one" },
    { uidvalidity: 4294967295, lastUid: 4294967295, label: "both 2^32-1 (max)" },
    { uidvalidity: 1234567890, lastUid: 42, label: "typical values" },
    { uidvalidity: 1, lastUid: 0, label: "uidvalidity=1, lastUid=0 (empty inbox)" },
  ])("format → parse produces original values ($label)", ({ uidvalidity, lastUid }) => {
    const cursor = formatSyncCursor(uidvalidity, lastUid);
    const parsed = parseSyncCursor(cursor);
    expect(parsed).toEqual({ uidvalidity, lastUid });
  });

  it("formatSyncCursor produces the expected string format", () => {
    expect(formatSyncCursor(1234567890, 42)).toBe("1234567890:42");
  });
});

// ---------------------------------------------------------------------------
// Property 2: providerMessageId round-trip
// Validates: Requirements 5.1, 5.2
// ---------------------------------------------------------------------------

describe("providerMessageId round-trip", () => {
  it.each([
    { emxId: "emx_abc123xyz", uid: 1, label: "typical emxId, uid=1" },
    { emxId: "emx_abc123xyz", uid: 4294967295, label: "typical emxId, uid=max" },
    { emxId: "emx_7KqVnZ3rP2mABC", uid: 500, label: "longer emxId" },
  ])("format → parse produces original values ($label)", ({ emxId, uid }) => {
    const id = formatProviderMessageId(emxId, uid);
    const parsed = parseProviderMessageId(id);
    expect(parsed).toEqual({ emxId, uid });
  });

  it("formatProviderMessageId produces the expected string format", () => {
    expect(formatProviderMessageId("emx_abc123xyz", 42)).toBe("emx_abc123xyz:42");
  });
});

// ---------------------------------------------------------------------------
// Property 4: TLS config → port resolution
// Validates: Requirements 10.1, 10.2
// ---------------------------------------------------------------------------

describe("createImapClient TLS config → port resolution", () => {
  it("TLS resolves to port 993 with secure=true", () => {
    const client = createImapClient({
      host: "imap.example.com",
      tlsConfig: "TLS",
      username: "user@example.com",
      password: "secret",
      timeout: 10000,
    });
    const opts = (client as unknown as { passedOptions: ImapFlowOptions }).passedOptions;
    expect(opts.port).toBe(993);
    expect(opts.secure).toBe(true);
    expect(opts.tls).toEqual({ minVersion: "TLSv1.2", rejectUnauthorized: true });
  });

  it("DISABLED resolves to port 143 with secure=false", () => {
    const client = createImapClient({
      host: "imap.example.com",
      tlsConfig: "DISABLED",
      username: "user@example.com",
      password: "secret",
      timeout: 10000,
    });
    const opts = (client as unknown as { passedOptions: ImapFlowOptions }).passedOptions;
    expect(opts.port).toBe(143);
    expect(opts.secure).toBe(false);
    expect(opts.tls).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Parse errors: malformed inputs
// ---------------------------------------------------------------------------

describe("parseSyncCursor errors", () => {
  it.each([
    { input: "nocolon", label: "missing colon" },
    { input: "abc:42", label: "non-numeric uidvalidity (NaN)" },
    { input: "42:abc", label: "non-numeric lastUid (NaN)" },
    { input: "-1:42", label: "negative uidvalidity" },
    { input: "42:-1", label: "negative lastUid" },
  ])("throws for $label", ({ input }) => {
    expect(() => parseSyncCursor(input)).toThrow();
  });
});

describe("parseProviderMessageId errors", () => {
  it.each([
    { input: "nocolon", label: "missing colon" },
    { input: "emx_abc:0", label: "uid=0 (below minimum)" },
    { input: "emx_abc:-1", label: "negative uid" },
    { input: "emx_abc:abc", label: "non-numeric uid" },
    { input: ":42", label: "empty emxId" },
  ])("throws for $label", ({ input }) => {
    expect(() => parseProviderMessageId(input)).toThrow();
  });
});
