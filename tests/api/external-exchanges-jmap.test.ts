import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "neverthrow";
import { createApp } from "../../src/api/app.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import type { ExternalMailExchange } from "../../src/types/index.js";
import type { ProviderAdapter } from "../../src/external-exchanges/provider-adapter.js";

// ---------------------------------------------------------------------------
// Mock jmap-adapter — PATCH route calls fetchSession directly
// ---------------------------------------------------------------------------

const mockFetchSession = vi.fn();

vi.mock("../../src/external-exchanges/jmap-adapter.js", () => ({
  buildBasicAuth: (username: string, password: string) => "Basic " + Buffer.from(`${username}:${password}`).toString("base64"),
  fetchSession: (...args: unknown[]) => mockFetchSession(...args),
  JmapAdapter: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-jmap-001";
const A = `/accounts/${TEST_ACCOUNT_ID}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJmapEmx(overrides?: Partial<ExternalMailExchange>): ExternalMailExchange {
  return {
    id: "emx_jmap123xyz",
    accountId: TEST_ACCOUNT_ID,
    platform: "jmap",
    emailAddress: "user@fastmail.com",
    status: "active",
    syncCursor: "state-abc",
    jmapConfig: {
      sessionUrl: "https://api.fastmail.com/jmap/session",
      username: "user@fastmail.com",
      encryptedPassword: "encrypted-jmap-blob",
      apiUrl: "https://api.fastmail.com/jmap/api/",
      downloadUrl: "https://api.fastmail.com/jmap/download/{accountId}/{blobId}/{name}",
      jmapAccountId: "u1234567",
      inboxId: "mb-inbox-001",
    },
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeJmapAdapter(): ProviderAdapter {
  return {
    activate: vi.fn().mockResolvedValue(ok({ syncCursor: "state-initial", expiresAt: "2025-06-15T11:00:00Z", providerSubscriptionId: "poll" })),
    renew: vi.fn().mockResolvedValue(ok({ expiresAt: "2025-06-15T12:00:00Z" })),
    deactivate: vi.fn().mockResolvedValue(ok(undefined)),
    fetchMessage: vi.fn().mockResolvedValue(ok({ rawMime: new Uint8Array(), receivedAt: "2025-01-01T00:00:00Z" })),
  };
}

function makeAccountDb() {
  return {
    createJmapExchange: vi.fn().mockImplementation(async (_accountId: string, data: Record<string, unknown>) => {
      return ok(makeJmapEmx({ status: data.status as ExternalMailExchange["status"], ...(data.errorReason ? { errorReason: data.errorReason as string } : {}) }));
    }),
    getExternalExchange: vi.fn().mockResolvedValue(ok(makeJmapEmx())),
    listExternalExchanges: vi.fn().mockResolvedValue(ok([makeJmapEmx()])),
    updateExternalExchangeJmapConfig: vi.fn().mockResolvedValue(ok(makeJmapEmx())),
    updateExternalExchange: vi.fn().mockResolvedValue(ok(makeJmapEmx())),
    deleteExternalExchange: vi.fn().mockResolvedValue(ok(undefined)),
    createExternalExchange: vi.fn().mockResolvedValue(ok(makeJmapEmx())),
    getAliasByGlobalAddress: vi.fn().mockResolvedValue(ok(null)),
    ensureAlias: vi.fn().mockResolvedValue(ok({ alias: { id: "a", accountId: TEST_ACCOUNT_ID, aliasAddress: "user@fastmail.com", domain: "fastmail.com", aliasName: "user", unknownSenderPolicy: "allow_all", createdAt: "", updatedAt: "" }, created: true })),
    setAliasExchange: vi.fn().mockResolvedValue(ok({ id: "a", accountId: TEST_ACCOUNT_ID, aliasAddress: "user@fastmail.com", domain: "fastmail.com", aliasName: "user", unknownSenderPolicy: "allow_all", createdAt: "", updatedAt: "" })),
  };
}

function makeEncryptionManager() {
  return {
    encrypt: vi.fn().mockReturnValue("encrypted-jmap-blob"),
    decrypt: vi.fn().mockReturnValue("decrypted-password"),
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

describe("External Exchanges JMAP API", () => {
  let accountDb: ReturnType<typeof makeAccountDb>;
  let jmapAdapter: ProviderAdapter;
  let encryptionManager: ReturnType<typeof makeEncryptionManager>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    accountDb = makeAccountDb();
    jmapAdapter = makeJmapAdapter();
    encryptionManager = makeEncryptionManager();
    mockFetchSession.mockResolvedValue(ok({ apiUrl: "https://api.fastmail.com/jmap/api/", downloadUrl: "https://dl.fastmail.com/{accountId}/{blobId}/{name}", primaryAccounts: { "urn:ietf:params:jmap:mail": "u1234567" } }));

    app = createApp(makeAppDeps({
      accountDb: accountDb as never,
      auth: { verify: vi.fn().mockResolvedValue(ok({ userId: "user-1" })) },
      access: { checkAccess: async () => {} } as never,
      logger: createMockLogger(),
      adapters: { jmap: jmapAdapter },
      encryptionManager: encryptionManager as never,
      getProviderToken: async () => "",
    }));
  });

  // -------------------------------------------------------------------------
  // POST — JMAP creation
  // -------------------------------------------------------------------------

  describe("POST /accounts/:accountId/external-exchanges (JMAP)", () => {
    it("creates record on activation success", async () => {
      const res = await req(app, "POST", `${A}/external-exchanges`, {
        body: { platform: "jmap", jmapConfig: { sessionUrl: "https://api.fastmail.com/jmap/session", username: "user@fastmail.com", password: "app-pass-123" } },
      });

      expect(res.status).toBe(201);
      expect(jmapAdapter.activate).toHaveBeenCalledOnce();
      expect(encryptionManager.encrypt).toHaveBeenCalledWith("app-pass-123");
      expect(accountDb.createJmapExchange).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({
          emailAddress: "user@fastmail.com",
          status: "active",
          syncCursor: "state-initial",
          nextSyncTime: "2025-06-15T11:00:00Z",
          jmapConfig: expect.objectContaining({ encryptedPassword: "encrypted-jmap-blob" }),
        }),
      );
    });

    it("returns record with activation_failed status when activation fails", async () => {
      vi.mocked(jmapAdapter.activate).mockResolvedValue(err({ kind: "provider_activation_failed", cause: "invalid credentials" }));

      const res = await req(app, "POST", `${A}/external-exchanges`, {
        body: { platform: "jmap", jmapConfig: { sessionUrl: "https://bad.server/jmap/session", username: "user@bad.com", password: "wrong" } },
      });

      expect(res.status).toBe(201);
      const body = await res.json() as { status: string };
      expect(body.status).toBe("activation_failed");
      expect(accountDb.createJmapExchange).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({ status: "activation_failed", errorReason: "invalid credentials" }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // PATCH — JMAP update
  // -------------------------------------------------------------------------

  describe("PATCH /accounts/:accountId/external-exchanges/:emxId (JMAP)", () => {
    it("returns 422 when connection test fails", async () => {
      vi.mocked(jmapAdapter.activate).mockResolvedValue(err({ kind: "provider_activation_failed", cause: "server unreachable" }));

      const res = await req(app, "PATCH", `${A}/external-exchanges/emx_jmap123xyz`, {
        body: { jmapConfig: { sessionUrl: "https://dead.server/jmap/session" } },
      });

      expect(res.status).toBe(422);
    });

    it("uses existing credential when password is absent from request", async () => {
      const res = await req(app, "PATCH", `${A}/external-exchanges/emx_jmap123xyz`, {
        body: { jmapConfig: { sessionUrl: "https://new.server/jmap/session" } },
      });

      expect(res.status).toBe(200);
      expect(encryptionManager.decrypt).toHaveBeenCalledWith("encrypted-jmap-blob");
      expect(encryptionManager.encrypt).not.toHaveBeenCalled();
    });

    it("returns 404 when target EMX is not JMAP platform", async () => {
      accountDb.getExternalExchange.mockResolvedValue(ok({
        ...makeJmapEmx(),
        platform: "gmail",
        jmapConfig: undefined,
      }));

      const res = await req(app, "PATCH", `${A}/external-exchanges/emx_jmap123xyz`, {
        body: { jmapConfig: { sessionUrl: "https://new.server/jmap/session" } },
      });

      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // GET — response excludes internal jmapConfig fields (validates Property 1)
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId/external-exchanges (JMAP)", () => {
    it("excludes internal jmapConfig fields from response", async () => {
      const res = await req(app, "GET", `${A}/external-exchanges`);

      expect(res.status).toBe(200);
      const body = await res.json() as { exchanges: Array<{ jmapConfig?: Record<string, unknown> }> };
      const exchange = body.exchanges[0]!;
      expect(exchange.jmapConfig).toBeDefined();
      expect(exchange.jmapConfig!.sessionUrl).toBe("https://api.fastmail.com/jmap/session");
      expect(exchange.jmapConfig!.username).toBe("user@fastmail.com");
      expect(exchange.jmapConfig).not.toHaveProperty("encryptedPassword");
      expect(exchange.jmapConfig).not.toHaveProperty("apiUrl");
      expect(exchange.jmapConfig).not.toHaveProperty("downloadUrl");
      expect(exchange.jmapConfig).not.toHaveProperty("jmapAccountId");
      expect(exchange.jmapConfig).not.toHaveProperty("inboxId");
    });
  });

  describe("GET /accounts/:accountId/external-exchanges/:emxId (JMAP)", () => {
    it("excludes internal jmapConfig fields from single-item response", async () => {
      const res = await req(app, "GET", `${A}/external-exchanges/emx_jmap123xyz`);

      expect(res.status).toBe(200);
      const body = await res.json() as { jmapConfig?: Record<string, unknown> };
      expect(body.jmapConfig).toBeDefined();
      expect(body.jmapConfig!.sessionUrl).toBe("https://api.fastmail.com/jmap/session");
      expect(body.jmapConfig!.username).toBe("user@fastmail.com");
      expect(body.jmapConfig).not.toHaveProperty("encryptedPassword");
      expect(body.jmapConfig).not.toHaveProperty("apiUrl");
      expect(body.jmapConfig).not.toHaveProperty("downloadUrl");
      expect(body.jmapConfig).not.toHaveProperty("jmapAccountId");
      expect(body.jmapConfig).not.toHaveProperty("inboxId");
    });
  });
});
