import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "../../src/errors.js";
import type { DbError } from "../../src/errors.js";
import type { Signal, Thread, AuthData } from "../../src/types/index.js";
import type { DeviceStore } from "../../src/notifier/device-store.js";
import type { Deliverer, Device } from "../../src/notifier/types.js";
import type { ThreadDatabase } from "../../src/database/thread-database.js";
import type { Logger } from "../../src/logger.js";
import { AuthWorkflowHandler, type OtpPayload } from "../../src/workflow/auth-handler.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeDevice(token: string): Device {
  return { accountId: "acc-1", token, type: "websocket", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" };
}

function makeSignal(overrides: { data?: Partial<Signal["data"]> } & Partial<Omit<Signal, "data">> & { data: { from: Signal["data"]["from"]; workflowData: AuthData } }): Signal {
  const { data: dataOverrides, ...baseOverrides } = overrides;
  return {
    id: "sgn-test-001",
    signalLookupId: "sgn-test-001",
    accountId: "acc-1",
    source: "email",
    type: "email",
    status: "active",
    createdAt: "2024-01-01T00:00:00Z",
    ...baseOverrides,
    data: {
      receivedAt: "2024-01-01T00:00:00Z",
      to: [{ address: "me@mydomain.com" }],
      cc: [],
      subject: "Your verification code",
      attachments: [],
      headers: {},
      recipientAddress: "me@mydomain.com",
      workflow: "auth",
      tags: [],
      summary: "OTP code",
      s3Key: "signals/test.eml",
      ...dataOverrides,
    },
  } as Signal;
}

const stubArc: Thread = {
  id: "arc-test-001",
  accountId: "acc-1",
  workflow: "auth",
  labels: [],
  status: "active",
  summary: "Auth arc",
  lastSignalAt: "2024-01-01T00:00:00Z",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  sender: { address: "sender@example.com" },
  recipientAddress: "user@example.com",
  subject: "Test email",
};

function makeMocks() {
  const deviceStore: DeviceStore = {
    listDevices: vi.fn(),
    saveDevice: vi.fn(),
    deleteDevice: vi.fn(),
    countDevices: vi.fn(),
  };
  const deliverer: Deliverer = {
    deliver: vi.fn(),
  };
  const threadDatabase = {
    updateThread: vi.fn().mockResolvedValue(ok({} as Thread)),
  } as unknown as ThreadDatabase;
  const logger: Logger = {
    startInvocation: vi.fn(),
    getInvocationId: vi.fn(),
    trackPoint: vi.fn(),
    info: vi.fn(),
    track: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    critical: vi.fn(),
  };
  return { deviceStore, deliverer, threadDatabase, logger };
}

// ---------------------------------------------------------------------------
// Tests
// Validates: Requirements 4.1, 4.2, 4.3, 4.5, 4.6, 4.8, 4.9
// ---------------------------------------------------------------------------

describe("AuthWorkflowHandler", () => {
  let mocks: ReturnType<typeof makeMocks>;
  let handler: AuthWorkflowHandler;

  beforeEach(() => {
    mocks = makeMocks();
    handler = new AuthWorkflowHandler(mocks.deviceStore, mocks.deliverer, mocks.threadDatabase, mocks.logger);
  });

  // ─── Property 2: OTP payload construction + fan-out ──────────────────────

  describe("OTP payload construction + fan-out", () => {
    it.each([
      { label: "single device, otp type", devices: 1, authType: "verification" as const, code: "123456", domain: "noreply@github.com", expectedOrigin: "github.com" },
      { label: "multiple devices, magic_link type", devices: 3, authType: "verification" as const, code: "ABC-DEF", domain: "security@accounts.google.com", expectedOrigin: "google.com" },
      { label: "subdomain sender", devices: 1, authType: "two_factor" as const, code: "9999", domain: "no-reply@auth.stripe.com", expectedOrigin: "stripe.com" },
      { label: "with expiresInMinutes", devices: 2, authType: "verification" as const, code: "000000", domain: "noreply@example.co.uk", expectedOrigin: "example.co.uk", expiresInMinutes: "5" },
    ])("delivers correct OTP payload — $label", async ({ devices, authType, code, domain, expectedOrigin, expiresInMinutes }) => {
      const deviceList = Array.from({ length: devices }, (_, i) => makeDevice(`token-${i}`));
      vi.mocked(mocks.deviceStore.listDevices).mockResolvedValue(ok(deviceList));
      vi.mocked(mocks.deliverer.deliver).mockResolvedValue(ok(undefined));

      const workflowData: AuthData = { workflow: "auth", authType, code, service: "TestService", ...(expiresInMinutes !== undefined ? { expiresInMinutes } : {}) };
      const signal = makeSignal({ data: { from: { address: domain }, workflowData } });

      const result = await handler.execute(signal, stubArc, "acc-1");

      expect(result.isOk()).toBe(true);
      expect(mocks.deliverer.deliver).toHaveBeenCalledTimes(devices);

      const expectedPayload: OtpPayload = {
        type: "otp",
        signalId: signal.id,
        code,
        authType,
        ...(expiresInMinutes !== undefined ? { expiresInMinutes } : {}),
        originDomain: expectedOrigin,
        subject: signal.data.subject,
      };

      for (let i = 0; i < devices; i++) {
        expect(mocks.deliverer.deliver).toHaveBeenCalledWith(deviceList[i], expectedPayload, "interrupt");
      }
    });
  });

  // ─── Property 3: Best-effort delivery invariant ──────────────────────────

  describe("best-effort delivery invariant", () => {
    it.each([
      { label: "all delivered", results: ["ok", "ok"] as const },
      { label: "all failed", results: ["failed", "failed"] as const },
      { label: "mixed outcomes", results: ["ok", "failed"] as const },
      { label: "listDevices fails", listDevicesFails: true, results: [] as const },
    ])("returns ok() regardless of delivery outcome — $label", async ({ results, listDevicesFails }) => {
      const workflowData: AuthData = { workflow: "auth", authType: "verification", code: "111111", service: "Svc" };
      const signal = makeSignal({ data: { from: { address: "noreply@example.com" }, workflowData } });

      if (listDevicesFails) {
        vi.mocked(mocks.deviceStore.listDevices).mockResolvedValue(err({ kind: "db_error", message: "timeout", cause: new Error("timeout") }));
      } else {
        const deviceList = results.map((_, i) => makeDevice(`token-${i}`));
        vi.mocked(mocks.deviceStore.listDevices).mockResolvedValue(ok(deviceList));

        const deliverMock = vi.mocked(mocks.deliverer.deliver);
        for (const r of results) {
          if (r === "failed") {
            deliverMock.mockResolvedValueOnce(err({ kind: "delivery_failed", reason: "connection reset", cause: undefined }));
          } else {
            deliverMock.mockResolvedValueOnce(ok(undefined));
          }
        }
      }

      const result = await handler.execute(signal, stubArc, "acc-1");
      expect(result.isOk()).toBe(true);
    });
  });

  // ─── Skips push when code is undefined ───────────────────────────────────

  it("skips push when workflowData.code is undefined", async () => {
    const workflowData: AuthData = { workflow: "auth", authType: "verification", service: "Svc" };
    const signal = makeSignal({ data: { from: { address: "noreply@example.com" }, workflowData } });

    const result = await handler.execute(signal, stubArc, "acc-1");

    expect(result.isOk()).toBe(true);
    expect(mocks.deviceStore.listDevices).not.toHaveBeenCalled();
    expect(mocks.deliverer.deliver).not.toHaveBeenCalled();
  });

  // ─── Archives arc after processing ──────────────────────────────────────

  it("archives arc after processing (updateArc called with { status: 'archived' })", async () => {
    vi.mocked(mocks.deviceStore.listDevices).mockResolvedValue(ok([makeDevice("t1")]));
    vi.mocked(mocks.deliverer.deliver).mockResolvedValue(ok(undefined));

    const workflowData: AuthData = { workflow: "auth", authType: "verification", code: "123456", service: "Svc" };
    const signal = makeSignal({ data: { from: { address: "noreply@example.com" }, workflowData } });

    await handler.execute(signal, stubArc, "acc-1");

    expect(mocks.threadDatabase.updateThread).toHaveBeenCalledWith("acc-1", "arc-test-001", "archived", "2024-01-01T00:00:00Z", {});
  });

  // ─── Logs warning when arc archive fails but still returns ok() ──────────

  it("logs warning when arc archive fails but still returns ok()", async () => {
    vi.mocked(mocks.deviceStore.listDevices).mockResolvedValue(ok([makeDevice("t1")]));
    vi.mocked(mocks.deliverer.deliver).mockResolvedValue(ok(undefined));
    const dbErr: DbError = { kind: "db_error", message: "connection lost", cause: new Error("connection lost") };
    vi.mocked(mocks.threadDatabase.updateThread).mockResolvedValue(err(dbErr));

    const workflowData: AuthData = { workflow: "auth", authType: "verification", code: "123456", service: "Svc" };
    const signal = makeSignal({ data: { from: { address: "noreply@example.com" }, workflowData } });

    const result = await handler.execute(signal, stubArc, "acc-1");

    expect(result.isOk()).toBe(true);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "Failed to archive auth thread after OTP push",
      expect.objectContaining({ code: "workflow.auth.archive_failed", signal, thread: stubArc }),
    );
  });
});
