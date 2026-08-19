import { describe, it, expect, vi } from "vitest";
import {
  resolveImapSyncState,
  createImapClient,
} from "../../src/external-exchanges/imap-adapter.js";
import type { ImapFlowOptions } from "imapflow";
import type { ExternalMailExchange } from "../../src/types/index.js";

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

function fakeEmx(overrides: Partial<ExternalMailExchange>): ExternalMailExchange {
  return {
    id: "emx-test", accountId: "acct-1", platform: "imap", emailAddress: "a@b.com",
    status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Property 1: syncState round-trip, plus legacy syncCursor fallback
// Validates: Requirements 3.4, 3.5, 4.1
// ---------------------------------------------------------------------------

describe("resolveImapSyncState", () => {
  it.each([
    { uidvalidity: 0, lastUid: 0, label: "both zero" },
    { uidvalidity: 1, lastUid: 1, label: "both one" },
    { uidvalidity: 4294967295, lastUid: 4294967295, label: "both 2^32-1 (max)" },
    { uidvalidity: 1234567890, lastUid: 42, label: "typical values" },
    { uidvalidity: 1, lastUid: 0, label: "uidvalidity=1, lastUid=0 (empty inbox)" },
  ])("reads structured syncState directly ($label)", ({ uidvalidity, lastUid }) => {
    const result = resolveImapSyncState(fakeEmx({ syncState: { uidvalidity, lastUid } }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ uidvalidity, lastUid });
  });

  it("falls back to parsing the legacy colon-delimited syncCursor when syncState is absent", () => {
    const result = resolveImapSyncState(fakeEmx({ syncCursor: "1234567890:42" }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ uidvalidity: 1234567890, lastUid: 42 });
  });

  it("prefers syncState over a legacy syncCursor when both are present", () => {
    const result = resolveImapSyncState(fakeEmx({ syncState: { uidvalidity: 1, lastUid: 2 }, syncCursor: "999:999" }));
    expect(result._unsafeUnwrap()).toEqual({ uidvalidity: 1, lastUid: 2 });
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
// Invalid/missing state: returns an error Result, never throws
// ---------------------------------------------------------------------------

describe("resolveImapSyncState errors", () => {
  it.each([
    { input: "nocolon", label: "missing colon" },
    { input: "abc:42", label: "non-numeric uidvalidity (NaN)" },
    { input: "42:abc", label: "non-numeric lastUid (NaN)" },
    { input: "-1:42", label: "negative uidvalidity" },
    { input: "42:-1", label: "negative lastUid" },
  ])("returns an error Result for $label, does not throw", ({ input }) => {
    let result;
    expect(() => { result = resolveImapSyncState(fakeEmx({ syncCursor: input })); }).not.toThrow();
    expect(result!.isErr()).toBe(true);
  });

  it("returns an error Result when neither syncState nor syncCursor is present", () => {
    expect(resolveImapSyncState(fakeEmx({})).isErr()).toBe(true);
  });
});

