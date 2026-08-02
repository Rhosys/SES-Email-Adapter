import { describe, it, expect, vi } from "vitest";
import {
  parseSyncCursor,
  formatSyncCursor,
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
// Property 2: TLS config → port resolution (renumbered from Property 4)
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

