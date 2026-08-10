import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "neverthrow";
import { createApp } from "../../src/api/app.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";
import type { ExternalMailExchange } from "../../src/types/index.js";

// ---------------------------------------------------------------------------
// Mock jmap-adapter — PushVerification handler calls fetchSession + jmapCall
// ---------------------------------------------------------------------------

const mockFetchSession = vi.fn();
const mockJmapCall = vi.fn();

vi.mock("../../src/external-exchanges/jmap-adapter.js", () => ({
  buildBasicAuth: (username: string, password: string) => "Basic " + Buffer.from(`${username}:${password}`).toString("base64"),
  fetchSession: (...args: unknown[]) => mockFetchSession(...args),
  jmapCall: (...args: unknown[]) => mockJmapCall(...args),
  JMAP_USING: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
}));

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const EMX_ID = "emx_jmap-webhook-test";
const ACCOUNT_ID = "acct-webhook-001";
const VALID_TOKEN = "valid-hmac-token";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJmapEmx(overrides?: Partial<ExternalMailExchange>): ExternalMailExchange {
  return {
    id: EMX_ID,
    accountId: ACCOUNT_ID,
    platform: "jmap",
    emailAddress: "user@fastmail.com",
    status: "active",
    syncCursor: "state-abc",
    pushSubscriptionId: "push-sub-1",
    jmapConfig: {
      sessionUrl: "https://api.fastmail.com/jmap/session",
      username: "user@fastmail.com",
      encryptedPassword: "encrypted-blob",
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

function makeEncryptionManager() {
  return {
    encrypt: vi.fn().mockReturnValue("encrypted"),
    decrypt: vi.fn().mockReturnValue("decrypted-password"),
    hash: vi.fn().mockReturnValue(VALID_TOKEN),
    init: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAccountDb(exchanges: ExternalMailExchange[] = [makeJmapEmx()]) {
  return {
    listExpiringExchanges: vi.fn().mockResolvedValue(ok(exchanges)),
  };
}

function makeSignalQueue() {
  return {
    send: vi.fn().mockResolvedValue(ok(undefined)),
    sendBatch: vi.fn().mockResolvedValue(ok(undefined)),
  };
}

async function webhookReq(
  app: ReturnType<typeof createApp>,
  options: { token?: string; body?: unknown; rawBody?: string } = {},
): Promise<Response> {
  const { token, body, rawBody } = options;
  const url = `http://localhost/external-exchanges/jmap/target${token !== undefined ? `?token=${token}` : ""}`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (rawBody !== undefined) {
    return app.fetch(new Request(url, { method: "POST", headers, body: rawBody }));
  }
  if (body !== undefined) {
    return app.fetch(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }));
  }
  return app.fetch(new Request(url, { method: "POST", headers }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("JMAP webhook endpoint", () => {
  let logger: MockLogger;
  let encryptionManager: ReturnType<typeof makeEncryptionManager>;
  let accountDb: ReturnType<typeof makeAccountDb>;
  let signalQueue: ReturnType<typeof makeSignalQueue>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
    encryptionManager = makeEncryptionManager();
    accountDb = makeAccountDb();
    signalQueue = makeSignalQueue();

    mockFetchSession.mockResolvedValue(ok({
      apiUrl: "https://api.fastmail.com/jmap/api/",
      downloadUrl: "https://dl.fastmail.com/{accountId}/{blobId}/{name}",
      primaryAccounts: { "urn:ietf:params:jmap:mail": "u1234567" },
      capabilities: {},
    }));
    mockJmapCall.mockResolvedValue(ok([["PushSubscription/set", {}, "pv0"]]));

    app = createApp(makeAppDeps({
      accountDb: accountDb as never,
      auth: { verify: vi.fn().mockResolvedValue(ok({ userId: "user-1" })) },
      access: { checkAccess: async () => {} } as never,
      logger,
      encryptionManager: encryptionManager as never,
      signalQueue: signalQueue as never,
    }));
  });

  it("valid HMAC + StateChange → emx_dispatch enqueued, 200", async () => {
    const res = await webhookReq(app, {
      token: VALID_TOKEN,
      body: { "@type": "StateChange", deviceClientId: EMX_ID, changed: { Email: { state: "new-state" } } },
    });

    expect(res.status).toBe(200);
    expect(signalQueue.send).toHaveBeenCalledWith("emx_dispatch", { emxId: EMX_ID, accountId: ACCOUNT_ID });
  });

  it("invalid HMAC → 200 returned, TRACK logged", async () => {
    const res = await webhookReq(app, {
      token: "wrong-token",
      body: { "@type": "StateChange", deviceClientId: EMX_ID, changed: {} },
    });

    expect(res.status).toBe(200);
    expect(signalQueue.send).not.toHaveBeenCalled();
    expect(logger.calls.some(c => c.method === "track" && c.context?.code === "emx.jmap.webhook.invalid_hmac")).toBe(true);
  });

  it("valid HMAC + PushVerification → verification confirmed, 200", async () => {
    const res = await webhookReq(app, {
      token: VALID_TOKEN,
      body: { "@type": "PushVerification", deviceClientId: EMX_ID, verificationCode: "abc123" },
    });

    expect(res.status).toBe(200);
    expect(encryptionManager.decrypt).toHaveBeenCalledWith("encrypted-blob");
    expect(mockFetchSession).toHaveBeenCalledOnce();
    expect(mockJmapCall).toHaveBeenCalledWith(
      "https://api.fastmail.com/jmap/api/",
      expect.any(String),
      ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      [["PushSubscription/set", { update: { "push-sub-1": { verificationCode: "abc123" } } }, "pv0"]],
      30_000,
    );
  });

  it("unknown deviceClientId → 200 returned, TRACK logged", async () => {
    const res = await webhookReq(app, {
      token: VALID_TOKEN,
      body: { "@type": "StateChange", deviceClientId: "emx_nonexistent", changed: {} },
    });

    expect(res.status).toBe(200);
    expect(signalQueue.send).not.toHaveBeenCalled();
    expect(logger.calls.some(c => c.method === "track" && c.context?.code === "emx.jmap.webhook.unknown_device")).toBe(true);
  });

  it("malformed body (not JSON) → 400", async () => {
    const res = await webhookReq(app, {
      token: VALID_TOKEN,
      rawBody: "not json at all",
    });

    expect(res.status).toBe(400);
  });

  it("StateChange for inactive exchange → 200, TRACK logged", async () => {
    accountDb.listExpiringExchanges.mockResolvedValue(ok([makeJmapEmx({ status: "activation_failed" })]));

    const res = await webhookReq(app, {
      token: VALID_TOKEN,
      body: { "@type": "StateChange", deviceClientId: EMX_ID, changed: { Email: { state: "s2" } } },
    });

    expect(res.status).toBe(200);
    expect(signalQueue.send).not.toHaveBeenCalled();
    expect(logger.calls.some(c => c.method === "track" && c.context?.code === "emx.jmap.webhook.inactive_exchange")).toBe(true);
  });
});
