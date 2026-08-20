import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "neverthrow";
import { EmxDispatchWorker } from "../../src/external-exchanges/emx-dispatch-worker.js";
import type { ProviderAdapter } from "../../src/external-exchanges/provider-adapter.js";
import type { ExternalMailExchange } from "../../src/types/index.js";
import type { Logger } from "../../src/logger.js";

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

const mockLogger: Logger = {
  startInvocation: vi.fn(),
  getInvocationId: vi.fn().mockReturnValue("test"),
  trackPoint: vi.fn(),
  info: vi.fn(),
  track: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  critical: vi.fn(),
};

const mockDb = {
  listExchangesDue: vi.fn(),
  getExternalExchange: vi.fn(),
};

const mockJmapAdapter: ProviderAdapter = {
  activate: vi.fn(),
  renew: vi.fn(),
  deactivate: vi.fn(),
  fetchMessage: vi.fn(),
};

function createWorker(): EmxDispatchWorker {
  return new EmxDispatchWorker({
    logger: mockLogger,
    db: mockDb as never,
    adapters: { jmap: mockJmapAdapter },
  });
}

function makeJmapEmx(overrides?: Partial<ExternalMailExchange>): ExternalMailExchange {
  return {
    id: "emx_jmapABC123",
    accountId: "acct-1",
    platform: "jmap",
    emailAddress: "user@fastmail.com",
    status: "active",
    syncCursor: "queryState-abc",
    jmapConfig: {
      sessionUrl: "https://api.fastmail.com/jmap/session",
      username: "user@fastmail.com",
      encryptedPassword: "base64-encrypted-blob",
      apiUrl: "https://api.fastmail.com/jmap/api",
      downloadUrl: "https://api.fastmail.com/jmap/download/{accountId}/{blobId}/{name}",
      jmapAccountId: "u12345",
      inboxId: "inbox-001",
    },
    consecutiveFailures: 0,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The worker delegates to the adapter uniformly — no credentials involved here;
// JMAP authenticates from the config already on the exchange.
// ---------------------------------------------------------------------------

describe("dispatch worker delegates renewal to the adapter", () => {
  it("calls renew(emx) directly for JMAP", async () => {
    const emx = makeJmapEmx();
    mockDb.listExchangesDue.mockResolvedValue(ok([emx]));
    vi.mocked(mockJmapAdapter.renew).mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockJmapAdapter.renew).toHaveBeenCalledWith(emx);
  });
});

// ---------------------------------------------------------------------------
// Dispatch worker logs adapter errors
// ---------------------------------------------------------------------------

describe("dispatch worker logs JMAP adapter errors", () => {
  it("logs error when JMAP renewal fails", async () => {
    const emx = makeJmapEmx();
    mockDb.listExchangesDue.mockResolvedValue(ok([emx]));
    vi.mocked(mockJmapAdapter.renew).mockResolvedValue(
      err({ kind: "provider_renewal_failed", cause: "invalid credentials" }),
    );

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(
      "emx_dispatch: renewal failed",
      expect.objectContaining({ code: "emx.dispatch.renewal_failed", emxId: "emx_jmapABC123", platform: "jmap" }),
    );
  });

  it("logs success when JMAP renewal succeeds", async () => {
    const emx = makeJmapEmx();
    mockDb.listExchangesDue.mockResolvedValue(ok([emx]));
    vi.mocked(mockJmapAdapter.renew).mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith(
      "emx_dispatch: renewed successfully",
      expect.objectContaining({ code: "emx.dispatch.renewed", emxId: "emx_jmapABC123", platform: "jmap" }),
    );
  });
});
