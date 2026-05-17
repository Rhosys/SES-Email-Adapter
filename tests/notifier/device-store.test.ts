// ---------------------------------------------------------------------------
// Unit tests for DynamoDeviceStore
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import { DynamoDeviceStore, type ValidationError } from "../../src/notifier/device-store.js";
import type { Device } from "../../src/notifier/types.js";

// ---------------------------------------------------------------------------
// Mock DynamoDB
// ---------------------------------------------------------------------------

const mockSend = vi.fn();
vi.mock("../../src/database/shared.js", () => ({
  dynamo: { send: (...args: unknown[]) => mockSend(...args) },
  ACCOUNTS_TABLE: "ses-accounts",
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    accountId: "acc-1",
    token: "tok-abc",
    type: "fcm",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DynamoDeviceStore", () => {
  let store: DynamoDeviceStore;

  beforeEach(() => {
    mockSend.mockReset();
    store = new DynamoDeviceStore();
  });

  // ─── Property 7: Round-trip save/list preserves token and type ────────────

  describe("round-trip save/list preserves token and type (Property 7)", () => {
    const cases = [
      { label: "FCM device", device: makeDevice({ token: "fcm-token-1", type: "fcm" }) },
      { label: "APNs device", device: makeDevice({ token: "apns-token-1", type: "apns" }) },
      { label: "WebSocket device", device: makeDevice({ token: "ws-conn-id", type: "websocket" }) },
    ] as const;

    it.each(cases)("$label — token and type preserved after save+list", async ({ device }) => {
      // saveDevice: countMobileDevices query (for fcm/apns) + put
      if (device.type === "fcm" || device.type === "apns") {
        mockSend
          .mockResolvedValueOnce({ Items: [] }) // countMobileDevices query
          .mockResolvedValueOnce({}); // PutCommand
      } else {
        mockSend.mockResolvedValueOnce({}); // PutCommand (no count for websocket)
      }

      const saveResult = await store.saveDevice(device);
      expect(saveResult.isOk()).toBe(true);

      // listDevices query returns the saved device
      mockSend.mockResolvedValueOnce({
        Items: [{ accountId: device.accountId, token: device.token, type: device.type, createdAt: device.createdAt, updatedAt: device.updatedAt }],
      });

      const listResult = await store.listDevices(device.accountId);
      expect(listResult.isOk()).toBe(true);
      if (!listResult.isOk()) return;

      const found = listResult.value.find(d => d.token === device.token);
      expect(found).toBeDefined();
      expect(found!.token).toBe(device.token);
      expect(found!.type).toBe(device.type);
    });
  });

  // ─── Property 8: Upsert idempotency ──────────────────────────────────────

  describe("upsert idempotency — saving same token twice yields one record (Property 8)", () => {
    const cases = [
      { label: "FCM token saved twice", type: "fcm" as const },
      { label: "APNs token saved twice", type: "apns" as const },
    ];

    it.each(cases)("$label — list returns exactly one record", async ({ type }) => {
      const device = makeDevice({ token: "dup-token", type });

      // First save: count query returns 0, then put
      mockSend
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({});

      const first = await store.saveDevice(device);
      expect(first.isOk()).toBe(true);

      // Second save: count query excludes current token (returns 0), then put
      mockSend
        .mockResolvedValueOnce({ Items: [{ token: "dup-token", type }] }) // existing record with same token — excluded from count
        .mockResolvedValueOnce({});

      const second = await store.saveDevice({ ...device, updatedAt: "2024-06-01T00:00:00Z" });
      expect(second.isOk()).toBe(true);

      // Verify PutCommand was called with same key both times (upsert)
      const putCalls = mockSend.mock.calls.filter(
        (call) => call[0]?.constructor?.name === "PutCommand",
      );
      expect(putCalls).toHaveLength(2);

      // Both puts use the same pk/sk — DynamoDB naturally deduplicates
      for (const [cmd] of putCalls) {
        expect(cmd.input.Item.pk).toBe("ACCT#acc-1");
        expect(cmd.input.Item.sk).toBe("DEVICE#dup-token");
      }
    });
  });

  // ─── Property 9: Mobile device count limit ────────────────────────────────

  describe("mobile device count limit — 11th distinct mobile token rejected (Property 9)", () => {
    it("rejects 11th distinct FCM token when 10 already exist", async () => {
      const existingDevices = Array.from({ length: 10 }, (_, i) => ({
        token: `existing-${i}`,
        type: "fcm",
        accountId: "acc-1",
      }));

      // countMobileDevices query returns 10 existing mobile devices (none match new token)
      mockSend.mockResolvedValueOnce({ Items: existingDevices });

      const device = makeDevice({ token: "new-11th-token", type: "fcm" });
      const result = await store.saveDevice(device);

      expect(result.isErr()).toBe(true);
      if (!result.isErr()) return;
      const error = result.error as ValidationError;
      expect(error.kind).toBe("validation_error");
      expect(error.message).toContain("limit");
    });

    it("rejects 11th distinct APNs token when 10 already exist", async () => {
      const existingDevices = Array.from({ length: 10 }, (_, i) => ({
        token: `apns-existing-${i}`,
        type: "apns",
        accountId: "acc-1",
      }));

      mockSend.mockResolvedValueOnce({ Items: existingDevices });

      const device = makeDevice({ token: "apns-new-11th", type: "apns" });
      const result = await store.saveDevice(device);

      expect(result.isErr()).toBe(true);
      if (!result.isErr()) return;
      const error = result.error as ValidationError;
      expect(error.kind).toBe("validation_error");
      expect(error.message).toContain("limit");
    });

    it("allows upsert of existing token even at limit", async () => {
      // 10 devices exist, but one has the same token we're saving (excluded from count → 9)
      const existingDevices = Array.from({ length: 10 }, (_, i) => ({
        token: i === 5 ? "my-token" : `other-${i}`,
        type: "fcm",
        accountId: "acc-1",
      }));

      mockSend
        .mockResolvedValueOnce({ Items: existingDevices }) // count query — "my-token" excluded → 9
        .mockResolvedValueOnce({}); // PutCommand succeeds

      const device = makeDevice({ token: "my-token", type: "fcm" });
      const result = await store.saveDevice(device);

      expect(result.isOk()).toBe(true);
    });
  });

  // ─── Property 10: Validation rejects invalid input ────────────────────────

  describe("validation rejects empty token and invalid type (Property 10)", () => {
    const invalidTokenCases = [
      { label: "empty string token", token: "" },
      { label: "whitespace-only token", token: "   " },
    ];

    it.each(invalidTokenCases)("$label — rejected with validation error", async ({ token }) => {
      const device = makeDevice({ token });
      const result = await store.saveDevice(device);

      expect(result.isErr()).toBe(true);
      if (!result.isErr()) return;
      const error = result.error as ValidationError;
      expect(error.kind).toBe("validation_error");
      expect(error.field).toBe("token");
    });

    const invalidTypeCases = [
      { label: "invalid type 'email'", type: "email" },
      { label: "invalid type 'sms'", type: "sms" },
      { label: "invalid type empty string", type: "" },
    ];

    it.each(invalidTypeCases)("$label — rejected with validation error", async ({ type }) => {
      const device = makeDevice({ token: "valid-token", type: type as Device["type"] });
      const result = await store.saveDevice(device);

      expect(result.isErr()).toBe(true);
      if (!result.isErr()) return;
      const error = result.error as ValidationError;
      expect(error.kind).toBe("validation_error");
      expect(error.field).toBe("type");
    });

    it("no DynamoDB call made when validation fails", async () => {
      const device = makeDevice({ token: "" });
      await store.saveDevice(device);

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // ─── WebSocket devices exempt from mobile limit ───────────────────────────

  describe("websocket devices exempt from mobile limit", () => {
    it("websocket device saved even when 10 mobile devices exist", async () => {
      // No count query for websocket — goes straight to PutCommand
      mockSend.mockResolvedValueOnce({}); // PutCommand

      const device = makeDevice({ token: "ws-conn-99", type: "websocket" });
      const result = await store.saveDevice(device);

      expect(result.isOk()).toBe(true);

      // Verify only one call (PutCommand) — no count query
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe("PutCommand");
    });
  });
});
