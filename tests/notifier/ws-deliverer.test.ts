import { describe, it, expect, vi } from "vitest";
import { ok } from "../../src/errors.js";
import type { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import { WsDeliverer } from "../../src/notifier/ws-deliverer.js";
import type { DeviceStore } from "../../src/notifier/device-store.js";
import type { Device, NotificationPayload } from "../../src/notifier/types.js";

function makeMockClient(response: "success" | Error): ApiGatewayManagementApiClient {
  const send = response === "success"
    ? vi.fn().mockResolvedValue({})
    : vi.fn().mockRejectedValue(response);
  return { send } as unknown as ApiGatewayManagementApiClient;
}

function makeMockDeviceStore(): DeviceStore & { deleteDevice: ReturnType<typeof vi.fn> } {
  return {
    listDevices: vi.fn(async () => ok([])),
    saveDevice: vi.fn(async () => ok(undefined)),
    deleteDevice: vi.fn(async () => ok(undefined)),
    countDevices: vi.fn(async () => ok(0)),
  };
}

const device: Device = {
  accountId: "acct-1",
  token: "conn-abc123",
  type: "websocket",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const payload: NotificationPayload = {
  type: "thread:updated",
  signalId: "SES#msg-001",
  threadId: "arc-uuid-1",
  from: { address: "alice@example.com", name: "Alice" },
  subject: "Test subject",
  workflow: "default",
  urgency: "normal",
};

describe("WsDeliverer", () => {
  describe("deliver", () => {
    it("returns ok on successful post", async () => {
      const client = makeMockClient("success");
      const store = makeMockDeviceStore();
      const deliverer = new WsDeliverer(client, store);

      const result = await deliverer.deliver(device, payload, "ambient");

      expect(result.isOk()).toBe(true);
    });

    it("sends JSON payload to the correct connection", async () => {
      const client = makeMockClient("success");
      const store = makeMockDeviceStore();
      const deliverer = new WsDeliverer(client, store);

      await deliverer.deliver(device, payload, "ambient");

      const call = (client.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.input.ConnectionId).toBe("conn-abc123");
      const sentData = JSON.parse(new TextDecoder().decode(call.input.Data));
      expect(sentData).toEqual(payload);
    });

    describe("GoneException (stale connection)", () => {
      it.each([
        {
          label: "error with name GoneException",
          error: Object.assign(new Error("Connection gone"), { name: "GoneException" }),
        },
        {
          label: "error with $metadata.httpStatusCode 410",
          error: Object.assign(new Error("Gone"), { $metadata: { httpStatusCode: 410 } }),
        },
      ])("returns ok and deletes device when $label", async ({ error }) => {
        const client = makeMockClient(error);
        const store = makeMockDeviceStore();
        const deliverer = new WsDeliverer(client, store);

        const result = await deliverer.deliver(device, payload, "interrupt");

        expect(result.isOk()).toBe(true);
        expect(store.deleteDevice).toHaveBeenCalledWith("acct-1", "conn-abc123");
      });
    });

    describe("non-410 errors", () => {
      it.each([
        {
          label: "500 InternalServerError",
          error: Object.assign(new Error("Internal server error"), {
            name: "InternalServerError",
            $metadata: { httpStatusCode: 500 },
          }),
        },
        {
          label: "403 ForbiddenException",
          error: Object.assign(new Error("Forbidden"), {
            name: "ForbiddenException",
            $metadata: { httpStatusCode: 403 },
          }),
        },
        {
          label: "timeout (generic Error)",
          error: new Error("Connection timed out"),
        },
      ])("returns delivery_failed with descriptive reason when $label", async ({ error }) => {
        const client = makeMockClient(error);
        const store = makeMockDeviceStore();
        const deliverer = new WsDeliverer(client, store);

        const result = await deliverer.deliver(device, payload, "ambient");

        expect(result.isErr()).toBe(true);
        const e = result._unsafeUnwrapErr();
        expect(e.kind).toBe("delivery_failed");
        expect(e.cause).toBe(error);
      });
    });

    it("returns delivery_failed with generic reason for non-Error throw", async () => {
      const send = vi.fn().mockRejectedValue("string-error");
      const client = { send } as unknown as ApiGatewayManagementApiClient;
      const store = makeMockDeviceStore();
      const deliverer = new WsDeliverer(client, store);

      const result = await deliverer.deliver(device, payload, "ambient");

      expect(result.isErr()).toBe(true);
      const e = result._unsafeUnwrapErr();
      expect(e.kind).toBe("delivery_failed");
    });
  });

  describe("sendRaw", () => {
    it("returns ok on successful send", async () => {
      const client = makeMockClient("success");
      const store = makeMockDeviceStore();
      const deliverer = new WsDeliverer(client, store);

      const result = await deliverer.sendRaw("conn-xyz", '{"type":"connected"}');

      expect(result.isOk()).toBe(true);
    });

    it("sends raw data to the specified connectionId", async () => {
      const client = makeMockClient("success");
      const store = makeMockDeviceStore();
      const deliverer = new WsDeliverer(client, store);

      await deliverer.sendRaw("conn-xyz", '{"type":"connected"}');

      const call = (client.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.input.ConnectionId).toBe("conn-xyz");
      const sentData = new TextDecoder().decode(call.input.Data);
      expect(sentData).toBe('{"type":"connected"}');
    });

    it("returns gone error on GoneException without deleting", async () => {
      const error = Object.assign(new Error("Gone"), { name: "GoneException" });
      const client = makeMockClient(error);
      const store = makeMockDeviceStore();
      const deliverer = new WsDeliverer(client, store);

      const result = await deliverer.sendRaw("conn-xyz", "{}");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toEqual({ kind: "gone", connectionId: "conn-xyz" });
      expect(store.deleteDevice).not.toHaveBeenCalled();
    });

    it("returns delivery_failed on non-gone errors", async () => {
      const error = new Error("Network timeout");
      const client = makeMockClient(error);
      const store = makeMockDeviceStore();
      const deliverer = new WsDeliverer(client, store);

      const result = await deliverer.sendRaw("conn-xyz", "{}");

      expect(result.isErr()).toBe(true);
      const e = result._unsafeUnwrapErr();
      if (e.kind !== "delivery_failed") throw new Error(`expected delivery_failed, got ${e.kind}`);
      expect(e.cause).toBe(error);
    });
  });
});
