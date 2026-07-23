import { describe, it, expect, vi } from "vitest";
import { ok, err, dbError } from "../../src/errors.js";
import type { Logger } from "../../src/logger.js";
import type { Thread, ThreadUrgency, Signal } from "../../src/types/index.js";
import type { DeviceStore } from "../../src/notifier/device-store.js";
import type { Deliverer, Device, DeviceType, DeliveryResult, NotificationPayload, PushPriority } from "../../src/notifier/types.js";
import { DeviceNotifier } from "../../src/notifier/device-notifier.js";

// ─── Mock Factories ──────────────────────────────────────────────────────────

function mockLogger(): Logger {
  return {
    startInvocation: vi.fn(),
    getInvocationId: vi.fn().mockReturnValue("test-invocation-id"),
    trackPoint: vi.fn(),
    info: vi.fn(),
    track: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    critical: vi.fn(),
  };
}

function mockDeviceStore(overrides: Partial<DeviceStore> = {}): DeviceStore {
  return {
    listDevices: vi.fn(async () => ok([])),
    saveDevice: vi.fn(async () => ok(undefined)),
    deleteDevice: vi.fn(async () => ok(undefined)),
    countDevices: vi.fn(async () => ok(0)),
    ...overrides,
  };
}

function mockDeliverer(result: DeliveryResult = { status: "delivered" }): Deliverer & { deliver: ReturnType<typeof vi.fn> } {
  return { deliver: vi.fn(async () => result) };
}

function mockDeliverers(overrides: Partial<Record<DeviceType, Deliverer>> = {}): Record<DeviceType, Deliverer> {
  return {
    websocket: mockDeliverer(),
    fcm: mockDeliverer(),
    apns: mockDeliverer(),
    ...overrides,
  };
}

// ─── Test Fixtures ───────────────────────────────────────────────────────────

const arc: Thread = {
  id: "arc-001",
  accountId: "acct-1",
  workflow: "package",
  labels: [],
  status: "active",
  summary: "Order shipped",
  lastSignalAt: "2024-06-01T12:00:00Z",
  createdAt: "2024-06-01T10:00:00Z",
  updatedAt: "2024-06-01T12:00:00Z",
  senderAddress: "sender@example.com",
  recipientAddress: "user@example.com",
  subject: "Test email",
};

const signal: Signal = {
  id: "sgn-msg001",
  signalLookupId: "ses-msg-001",
  accountId: "acct-1",
  source: "email",
  type: "email",
  status: "active",
  labels: [],
  createdAt: "2024-06-01T12:00:00Z",
  data: {
    receivedAt: "2024-06-01T12:00:00Z",
    from: { address: "alice@example.com", name: "Alice" },
    to: [{ address: "me@mydomain.com" }],
    cc: [],
    subject: "Your order has shipped",
    attachments: [],
    headers: {},
    recipientAddress: "me@mydomain.com",
    workflow: "package",
    workflowData: { workflow: "package", packageType: "shipping", retailer: "Amazon" },
    tags: [],
    summary: "Order shipped",
    s3Key: "emails/msg-001",
  actions: [],
  },
} as Signal;

const wsDevice: Device = { accountId: "acct-1", token: "ws-conn-1", type: "websocket", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" };
const fcmDevice: Device = { accountId: "acct-1", token: "fcm-token-1", type: "fcm", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" };
const apnsDevice: Device = { accountId: "acct-1", token: "apns-token-1", type: "apns", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("DeviceNotifier", () => {
  describe("Property 1: channel selection by urgency", () => {
    it.each([
      { label: "critical → ws delivered, push delivered", urgency: "critical" as ThreadUrgency, expectPush: true },
      { label: "high → ws delivered, push delivered", urgency: "high" as ThreadUrgency, expectPush: true },
      { label: "normal → ws delivered, push delivered", urgency: "normal" as ThreadUrgency, expectPush: true },
      { label: "low → ws delivered, push delivered", urgency: "low" as ThreadUrgency, expectPush: true },
      { label: "silent → ws delivered, push skipped", urgency: "silent" as ThreadUrgency, expectPush: false },
    ])("$label", async ({ urgency, expectPush }) => {
      const wsDeliverer = mockDeliverer();
      const fcmDeliverer = mockDeliverer();
      const apnsDeliverer = mockDeliverer();
      const store = mockDeviceStore({ listDevices: vi.fn(async () => ok([wsDevice, fcmDevice, apnsDevice])) });
      const notifier = new DeviceNotifier({
        deviceStore: store,
        deliverers: { websocket: wsDeliverer, fcm: fcmDeliverer, apns: apnsDeliverer },
        logger: mockLogger(),
      });

      await notifier.notify("acct-1", arc, signal, urgency);

      expect(wsDeliverer.deliver).toHaveBeenCalledTimes(1);
      expect(fcmDeliverer.deliver).toHaveBeenCalledTimes(expectPush ? 1 : 0);
      expect(apnsDeliverer.deliver).toHaveBeenCalledTimes(expectPush ? 1 : 0);
    });
  });

  describe("Property 2: partial failure returns Ok", () => {
    it("returns Ok when one device succeeds and another fails", async () => {
      const wsDeliverer = mockDeliverer({ status: "delivered" });
      const fcmDeliverer = mockDeliverer({ status: "failed", reason: "timeout" });
      const store = mockDeviceStore({ listDevices: vi.fn(async () => ok([wsDevice, fcmDevice])) });
      const notifier = new DeviceNotifier({
        deviceStore: store,
        deliverers: { websocket: wsDeliverer, fcm: fcmDeliverer, apns: mockDeliverer() },
        logger: mockLogger(),
      });

      const result = await notifier.notify("acct-1", arc, signal, "normal");

      expect(result.isOk()).toBe(true);
    });

    it("attempts delivery to all eligible devices", async () => {
      const wsDeliverer = mockDeliverer({ status: "delivered" });
      const fcmDeliverer = mockDeliverer({ status: "failed", reason: "timeout" });
      const apnsDeliverer = mockDeliverer({ status: "failed", reason: "unavailable" });
      const store = mockDeviceStore({ listDevices: vi.fn(async () => ok([wsDevice, fcmDevice, apnsDevice])) });
      const notifier = new DeviceNotifier({
        deviceStore: store,
        deliverers: { websocket: wsDeliverer, fcm: fcmDeliverer, apns: apnsDeliverer },
        logger: mockLogger(),
      });

      await notifier.notify("acct-1", arc, signal, "high");

      expect(wsDeliverer.deliver).toHaveBeenCalledTimes(1);
      expect(fcmDeliverer.deliver).toHaveBeenCalledTimes(1);
      expect(apnsDeliverer.deliver).toHaveBeenCalledTimes(1);
    });
  });

  describe("Property 6: all devices fail returns Err", () => {
    it("returns Err when every eligible device fails", async () => {
      const wsDeliverer = mockDeliverer({ status: "failed", reason: "connection reset" });
      const fcmDeliverer = mockDeliverer({ status: "failed", reason: "timeout" });
      const store = mockDeviceStore({ listDevices: vi.fn(async () => ok([wsDevice, fcmDevice])) });
      const notifier = new DeviceNotifier({
        deviceStore: store,
        deliverers: { websocket: wsDeliverer, fcm: fcmDeliverer, apns: mockDeliverer() },
        logger: mockLogger(),
      });

      const result = await notifier.notify("acct-1", arc, signal, "normal");

      expect(result.isErr()).toBe(true);
    });

    it("returns Err when all devices return stale (none succeed)", async () => {
      const wsDeliverer = mockDeliverer({ status: "stale" });
      const fcmDeliverer = mockDeliverer({ status: "stale" });
      const store = mockDeviceStore({ listDevices: vi.fn(async () => ok([wsDevice, fcmDevice])) });
      const notifier = new DeviceNotifier({
        deviceStore: store,
        deliverers: { websocket: wsDeliverer, fcm: fcmDeliverer, apns: mockDeliverer() },
        logger: mockLogger(),
      });

      const result = await notifier.notify("acct-1", arc, signal, "normal");

      expect(result.isErr()).toBe(true);
    });
  });

  describe("Property 4: stale devices are deleted", () => {
    it("deletes device when deliverer returns stale", async () => {
      const wsDeliverer = mockDeliverer({ status: "stale" });
      const fcmDeliverer = mockDeliverer({ status: "delivered" });
      const deleteDevice = vi.fn(async () => ok(undefined));
      const store = mockDeviceStore({
        listDevices: vi.fn(async () => ok([wsDevice, fcmDevice])),
        deleteDevice,
      });
      const notifier = new DeviceNotifier({
        deviceStore: store,
        deliverers: { websocket: wsDeliverer, fcm: fcmDeliverer, apns: mockDeliverer() },
        logger: mockLogger(),
      });

      await notifier.notify("acct-1", arc, signal, "normal");

      expect(deleteDevice).toHaveBeenCalledWith("acct-1", "ws-conn-1");
    });

    it("deletes multiple stale devices", async () => {
      const wsDeliverer = mockDeliverer({ status: "stale" });
      const fcmDeliverer = mockDeliverer({ status: "stale" });
      const apnsDeliverer = mockDeliverer({ status: "delivered" });
      const deleteDevice = vi.fn(async () => ok(undefined));
      const store = mockDeviceStore({
        listDevices: vi.fn(async () => ok([wsDevice, fcmDevice, apnsDevice])),
        deleteDevice,
      });
      const notifier = new DeviceNotifier({
        deviceStore: store,
        deliverers: { websocket: wsDeliverer, fcm: fcmDeliverer, apns: apnsDeliverer },
        logger: mockLogger(),
      });

      await notifier.notify("acct-1", arc, signal, "normal");

      expect(deleteDevice).toHaveBeenCalledTimes(2);
      expect(deleteDevice).toHaveBeenCalledWith("acct-1", "ws-conn-1");
      expect(deleteDevice).toHaveBeenCalledWith("acct-1", "fcm-token-1");
    });
  });

  describe("Property 3: notification payload contains all required fields", () => {
    it("builds payload with all required fields from arc and signal", async () => {
      const wsDeliverer = mockDeliverer();
      const store = mockDeviceStore({ listDevices: vi.fn(async () => ok([wsDevice])) });
      const notifier = new DeviceNotifier({
        deviceStore: store,
        deliverers: { websocket: wsDeliverer, fcm: mockDeliverer(), apns: mockDeliverer() },
        logger: mockLogger(),
      });

      await notifier.notify("acct-1", arc, signal, "high");

      const expectedPayload: NotificationPayload = {
        type: "signal",
        signalId: "sgn-msg001",
        threadId: "arc-001",
        sender: "alice@example.com",
        senderName: "Alice",
        subject: "Your order has shipped",
        workflow: "package",
        urgency: "high",
      };
      expect(wsDeliverer.deliver).toHaveBeenCalledWith(wsDevice, expectedPayload, "interrupt");
    });

    it("uses address as senderName when name is not provided", async () => {
      const signalNoName: Signal = { ...signal, data: { ...signal.data, from: { address: "bob@example.com" } } };
      const wsDeliverer = mockDeliverer();
      const store = mockDeviceStore({ listDevices: vi.fn(async () => ok([wsDevice])) });
      const notifier = new DeviceNotifier({
        deviceStore: store,
        deliverers: { websocket: wsDeliverer, fcm: mockDeliverer(), apns: mockDeliverer() },
        logger: mockLogger(),
      });

      await notifier.notify("acct-1", arc, signalNoName, "normal");

      const call = wsDeliverer.deliver.mock.calls[0]!;
      const deliveredPayload = call[1] as NotificationPayload;
      expect(deliveredPayload.senderName).toBe("bob@example.com");
    });
  });

  describe("empty device list", () => {
    it("returns Ok when no devices are registered", async () => {
      const store = mockDeviceStore({ listDevices: vi.fn(async () => ok([])) });
      const deliverers = mockDeliverers();
      const notifier = new DeviceNotifier({ deviceStore: store, deliverers, logger: mockLogger() });

      const result = await notifier.notify("acct-1", arc, signal, "normal");

      expect(result.isOk()).toBe(true);
    });
  });

  describe("Requirement 1.1: no SES calls", () => {
    it("does not invoke any email-sending operation", async () => {
      const wsDeliverer = mockDeliverer();
      const fcmDeliverer = mockDeliverer();
      const apnsDeliverer = mockDeliverer();
      const store = mockDeviceStore({ listDevices: vi.fn(async () => ok([wsDevice, fcmDevice, apnsDevice])) });
      const notifier = new DeviceNotifier({
        deviceStore: store,
        deliverers: { websocket: wsDeliverer, fcm: fcmDeliverer, apns: apnsDeliverer },
        logger: mockLogger(),
      });

      await notifier.notify("acct-1", arc, signal, "normal");

      // The DeviceNotifier only calls deliverers for websocket/fcm/apns — no SES
      // Verify only the three registered deliverers were called
      expect(wsDeliverer.deliver).toHaveBeenCalledTimes(1);
      expect(fcmDeliverer.deliver).toHaveBeenCalledTimes(1);
      expect(apnsDeliverer.deliver).toHaveBeenCalledTimes(1);
      // No other external calls exist — the class has no SES dependency
    });
  });

  describe("default urgency", () => {
    it("defaults to normal urgency when not provided", async () => {
      const wsDeliverer = mockDeliverer();
      const store = mockDeviceStore({ listDevices: vi.fn(async () => ok([wsDevice])) });
      const notifier = new DeviceNotifier({
        deviceStore: store,
        deliverers: { websocket: wsDeliverer, fcm: mockDeliverer(), apns: mockDeliverer() },
        logger: mockLogger(),
      });

      await notifier.notify("acct-1", arc, signal, undefined);

      const call = wsDeliverer.deliver.mock.calls[0]!;
      const deliveredPayload = call[1] as NotificationPayload;
      // "normal" urgency → "ambient" push priority
      expect(deliveredPayload.urgency).toBe("normal");
      expect(call[2]).toBe("ambient");
    });
  });

  describe("notifyBlocked", () => {
    it("returns Ok without any delivery attempts", async () => {
      const store = mockDeviceStore();
      const deliverers = mockDeliverers();
      const notifier = new DeviceNotifier({ deviceStore: store, deliverers, logger: mockLogger() });

      const result = await notifier.notifyBlocked("acct-1", signal);

      expect(result.isOk()).toBe(true);
      expect(store.listDevices).not.toHaveBeenCalled();
    });
  });

  describe("Requirement 5.3, 5.4: reason parameter in notification payload", () => {
    it("includes reason: 'followup' in payload when reason is provided", async () => {
      const wsDeliverer = mockDeliverer();
      const store = mockDeviceStore({ listDevices: vi.fn(async () => ok([wsDevice])) });
      const notifier = new DeviceNotifier({
        deviceStore: store,
        deliverers: { websocket: wsDeliverer, fcm: mockDeliverer(), apns: mockDeliverer() },
        logger: mockLogger(),
      });

      await notifier.notify("acct-1", arc, signal, "normal", "followup");

      const call = wsDeliverer.deliver.mock.calls[0]!;
      const deliveredPayload = call[1] as NotificationPayload;
      expect(deliveredPayload.reason).toBe("followup");
    });

    it("includes reason: 'new_signal' in payload when explicitly passed", async () => {
      const wsDeliverer = mockDeliverer();
      const store = mockDeviceStore({ listDevices: vi.fn(async () => ok([wsDevice])) });
      const notifier = new DeviceNotifier({
        deviceStore: store,
        deliverers: { websocket: wsDeliverer, fcm: mockDeliverer(), apns: mockDeliverer() },
        logger: mockLogger(),
      });

      await notifier.notify("acct-1", arc, signal, "normal", "new_signal");

      const call = wsDeliverer.deliver.mock.calls[0]!;
      const deliveredPayload = call[1] as NotificationPayload;
      expect(deliveredPayload.reason).toBe("new_signal");
    });

    it("omits reason field from payload when reason is not provided (backward compat)", async () => {
      const wsDeliverer = mockDeliverer();
      const store = mockDeviceStore({ listDevices: vi.fn(async () => ok([wsDevice])) });
      const notifier = new DeviceNotifier({
        deviceStore: store,
        deliverers: { websocket: wsDeliverer, fcm: mockDeliverer(), apns: mockDeliverer() },
        logger: mockLogger(),
      });

      await notifier.notify("acct-1", arc, signal, "normal");

      const call = wsDeliverer.deliver.mock.calls[0]!;
      const deliveredPayload = call[1] as NotificationPayload;
      expect(deliveredPayload).not.toHaveProperty("reason");
    });

    it("omits reason field from payload when reason is undefined (backward compat)", async () => {
      const wsDeliverer = mockDeliverer();
      const store = mockDeviceStore({ listDevices: vi.fn(async () => ok([wsDevice])) });
      const notifier = new DeviceNotifier({
        deviceStore: store,
        deliverers: { websocket: wsDeliverer, fcm: mockDeliverer(), apns: mockDeliverer() },
        logger: mockLogger(),
      });

      await notifier.notify("acct-1", arc, signal, "normal", undefined);

      const call = wsDeliverer.deliver.mock.calls[0]!;
      const deliveredPayload = call[1] as NotificationPayload;
      expect(deliveredPayload).not.toHaveProperty("reason");
    });
  });

  describe("error propagation", () => {
    it("returns Err when deviceStore.listDevices fails", async () => {
      const store = mockDeviceStore({ listDevices: vi.fn(async () => err(dbError("DynamoDB timeout"))) });
      const notifier = new DeviceNotifier({ deviceStore: store, deliverers: mockDeliverers(), logger: mockLogger() });

      const result = await notifier.notify("acct-1", arc, signal, "normal");

      expect(result.isErr()).toBe(true);
    });

    it("logs warning when stale device deletion fails but still returns Ok", async () => {
      const wsDeliverer = mockDeliverer({ status: "stale" });
      const fcmDeliverer = mockDeliverer({ status: "delivered" });
      const logger = mockLogger();
      const store = mockDeviceStore({
        listDevices: vi.fn(async () => ok([wsDevice, fcmDevice])),
        deleteDevice: vi.fn(async () => err(dbError("delete failed"))),
      });
      const notifier = new DeviceNotifier({
        deviceStore: store,
        deliverers: { websocket: wsDeliverer, fcm: fcmDeliverer, apns: mockDeliverer() },
        logger,
      });

      const result = await notifier.notify("acct-1", arc, signal, "normal");

      expect(result.isOk()).toBe(true);
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});
