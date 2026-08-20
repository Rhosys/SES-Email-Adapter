import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "neverthrow";
import { createApp } from "../../src/api/app.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import type { ExternalMailExchange } from "../../src/types/index.js";
import type { ProviderAdapter } from "../../src/external-exchanges/provider-adapter.js";

// ---------------------------------------------------------------------------
// Mock imapflow — PATCH route calls createImapClient directly
// ---------------------------------------------------------------------------

const mockLock = { release: vi.fn() };
const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  getMailboxLock: vi.fn().mockResolvedValue(mockLock),
  logout: vi.fn().mockResolvedValue(undefined),
};

vi.mock("imapflow", () => ({
  ImapFlow: vi.fn().mockImplementation(() => mockClient),
}));

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-imap-001";
const A = `/accounts/${TEST_ACCOUNT_ID}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeImapEmx(overrides?: Partial<ExternalMailExchange>): ExternalMailExchange {
  return {
    id: "emx_abc123xyz",
    accountId: TEST_ACCOUNT_ID,
    platform: "imap",
    emailAddress: "user@example.com",
    status: "active",
    syncCursor: "999:42",
    imapConfig: {
      host: "imap.example.com",
      tlsConfig: "TLS",
      username: "user@example.com",
      encryptedPassword: "encrypted-blob-base64",
    },
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeImapAdapter(): ProviderAdapter {
  return {
    activate: vi.fn().mockResolvedValue(ok({ syncCursor: "123:42", syncState: { uidvalidity: 123, lastUid: 42 }, expiresAt: "2025-06-15T11:00:00Z", providerSubscriptionId: "poll" })),
    renew: vi.fn().mockResolvedValue(ok({ expiresAt: "2025-06-15T12:00:00Z" })),
    deactivate: vi.fn().mockResolvedValue(ok(undefined)),
    fetchMessage: vi.fn().mockResolvedValue(ok({ rawMime: new Uint8Array(), receivedAt: "2025-01-01T00:00:00Z" })),
  };
}

function makeAccountDb() {
  return {
    getAliasByGlobalAddress: vi.fn().mockResolvedValue(ok(null)),
    ensureAlias: vi.fn().mockResolvedValue(ok({ alias: { id: "a", accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com", domain: "example.com", aliasName: "user", unknownSenderPolicy: "allow_all", createdAt: "", updatedAt: "" }, created: true })),
    updateAlias: vi.fn().mockResolvedValue(ok({ id: "a", accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com", domain: "example.com", aliasName: "user", unknownSenderPolicy: "allow_all", createdAt: "", updatedAt: "" })),
  };
}

function makeExchangesDb() {
  return {
    createExternalExchange: vi.fn().mockImplementation(async (_accountId: string, data: Record<string, unknown>) => {
      return ok(makeImapEmx({ status: data.status as ExternalMailExchange["status"], ...(data.errorReason ? { errorReason: data.errorReason as string } : {}) }));
    }),
    getExternalExchange: vi.fn().mockResolvedValue(ok(makeImapEmx())),
    listExternalExchanges: vi.fn().mockResolvedValue(ok([makeImapEmx()])),
    updateExternalExchangeImapConfig: vi.fn().mockResolvedValue(ok(makeImapEmx())),
    updateExternalExchange: vi.fn().mockResolvedValue(ok(makeImapEmx())),
    deleteExternalExchange: vi.fn().mockResolvedValue(ok(undefined)),
  };
}

function makeEncryptionManager() {
  return {
    encrypt: vi.fn().mockResolvedValue(ok("encrypted-blob-base64")),
    decrypt: vi.fn().mockResolvedValue(ok("decrypted-password")),
    hash: vi.fn().mockResolvedValue(ok("hashed")),
    init: vi.fn().mockResolvedValue(undefined),
  };
}

async function req(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<Response> {
  const { body, token = "valid-token" } = options;
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("External Exchanges IMAP API", () => {
  let accountDb: ReturnType<typeof makeAccountDb>;
  let exchangesDb: ReturnType<typeof makeExchangesDb>;
  let imapAdapter: ProviderAdapter;
  let encryptionManager: ReturnType<typeof makeEncryptionManager>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    accountDb = makeAccountDb();
    exchangesDb = makeExchangesDb();
    imapAdapter = makeImapAdapter();
    encryptionManager = makeEncryptionManager();
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.getMailboxLock.mockResolvedValue(mockLock);
    mockClient.logout.mockResolvedValue(undefined);

    app = createApp(makeAppDeps({
      accountDb: accountDb as never,
      exchangesDb: exchangesDb as never,
      auth: { verify: vi.fn().mockResolvedValue(ok({ userId: "user-1" })) },
      access: { checkAccess: async () => {} } as never,
      logger: createMockLogger(),
      adapters: { imap: imapAdapter },
      encryptionManager: encryptionManager as never,
      getProviderToken: async () => "",
    }));
  });

  // -------------------------------------------------------------------------
  // POST — IMAP creation
  // -------------------------------------------------------------------------

  describe("POST /accounts/:accountId/external-exchanges (IMAP)", () => {
    it("calls adapter.activate and creates record on valid IMAP payload", async () => {
      const res = await req(app, "POST", `${A}/external-exchanges`, {
        body: { platform: "imap", imapConfig: { host: "imap.example.com", tlsConfig: "TLS", username: "user@example.com", password: "secret123" } },
      });

      expect(res.status).toBe(201);
      expect(imapAdapter.activate).toHaveBeenCalledOnce();
      expect(encryptionManager.encrypt).toHaveBeenCalledWith("secret123");
      expect(exchangesDb.createExternalExchange).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({
          emailAddress: "user@example.com",
          status: "active",
          syncCursor: "123:42",
          syncState: { uidvalidity: 123, lastUid: 42 },
          nextSyncTime: "2025-06-15T11:00:00Z",
          imapConfig: expect.objectContaining({ encryptedPassword: "encrypted-blob-base64" }),
        }),
      );
    });

    it("returns record with status activation_failed when adapter.activate fails", async () => {
      vi.mocked(imapAdapter.activate).mockResolvedValue(err({ kind: "provider_activation_failed", cause: "host unreachable" }));

      const res = await req(app, "POST", `${A}/external-exchanges`, {
        body: { platform: "imap", imapConfig: { host: "bad.host.com", tlsConfig: "TLS", username: "user@bad.com", password: "pass" } },
      });

      expect(res.status).toBe(201);
      const body = await res.json() as { status: string };
      expect(body.status).toBe("activation_failed");
      expect(exchangesDb.createExternalExchange).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({ status: "activation_failed", errorReason: "host unreachable" }),
      );
    });

    it("rejects host > 253 characters", async () => {
      const longHost = "a".repeat(254);
      const res = await req(app, "POST", `${A}/external-exchanges`, {
        body: { platform: "imap", imapConfig: { host: longHost, tlsConfig: "TLS", username: "u@x.com", password: "p" } },
      });

      // IMAP schema fails (host too long), falls through to OAuth schema which throws on missing emailAddress
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(exchangesDb.createExternalExchange).not.toHaveBeenCalled();
    });

    it("rejects invalid tlsConfig value", async () => {
      const res = await req(app, "POST", `${A}/external-exchanges`, {
        body: { platform: "imap", imapConfig: { host: "imap.x.com", tlsConfig: "STARTTLS", username: "u@x.com", password: "p" } },
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(exchangesDb.createExternalExchange).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // PATCH — IMAP update
  // -------------------------------------------------------------------------

  describe("PATCH /accounts/:accountId/external-exchanges/:emxId (IMAP)", () => {
    it("returns 422 when connection test fails", async () => {
      vi.mocked(imapAdapter.activate).mockResolvedValue(err({ kind: "provider_activation_failed", cause: "Connection refused" }));

      const res = await req(app, "PATCH", `${A}/external-exchanges/emx_abc123xyz`, {
        body: { imapConfig: { host: "new-host.example.com" } },
      });

      expect(res.status).toBe(422);
    });

    it("uses existing credential when password is absent from request", async () => {
      const res = await req(app, "PATCH", `${A}/external-exchanges/emx_abc123xyz`, {
        body: { imapConfig: { host: "new-host.example.com" } },
      });

      expect(res.status).toBe(200);
      // Should decrypt existing password for connection test
      expect(encryptionManager.decrypt).toHaveBeenCalledWith("encrypted-blob-base64");
      // Should NOT encrypt a new password (no password field in request)
      expect(encryptionManager.encrypt).not.toHaveBeenCalled();
    });

    it("returns 404 when target EMX is not IMAP platform", async () => {
      exchangesDb.getExternalExchange.mockResolvedValue(ok({
        ...makeImapEmx(),
        platform: "gmail",
        imapConfig: undefined,
      }));

      const res = await req(app, "PATCH", `${A}/external-exchanges/emx_abc123xyz`, {
        body: { imapConfig: { host: "new-host.example.com" } },
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 when EMX does not exist", async () => {
      exchangesDb.getExternalExchange.mockResolvedValue(ok(null));

      const res = await req(app, "PATCH", `${A}/external-exchanges/emx_abc123xyz`, {
        body: { imapConfig: { host: "new-host.example.com" } },
      });

      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // GET — response excludes encryptedPassword (validates Property 3)
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId/external-exchanges (IMAP)", () => {
    it("excludes encryptedPassword from response (validates Property 3)", async () => {
      const res = await req(app, "GET", `${A}/external-exchanges`);

      expect(res.status).toBe(200);
      const body = await res.json() as { exchanges: Array<{ imapConfig?: Record<string, unknown> }> };
      const exchange = body.exchanges[0]!;
      expect(exchange.imapConfig).toBeDefined();
      expect(exchange.imapConfig!.host).toBe("imap.example.com");
      expect(exchange.imapConfig!.tlsConfig).toBe("TLS");
      expect(exchange.imapConfig!.username).toBe("user@example.com");
      expect(exchange.imapConfig).not.toHaveProperty("encryptedPassword");
      expect(exchange.imapConfig).not.toHaveProperty("password");
    });
  });

  describe("GET /accounts/:accountId/external-exchanges/:emxId (IMAP)", () => {
    it("excludes encryptedPassword from single-item response (validates Property 3)", async () => {
      const res = await req(app, "GET", `${A}/external-exchanges/emx_abc123xyz`);

      expect(res.status).toBe(200);
      const body = await res.json() as { imapConfig?: Record<string, unknown> };
      expect(body.imapConfig).toBeDefined();
      expect(body.imapConfig!.host).toBe("imap.example.com");
      expect(body.imapConfig).not.toHaveProperty("encryptedPassword");
      expect(body.imapConfig).not.toHaveProperty("password");
    });
  });
});
