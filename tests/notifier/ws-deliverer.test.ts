import { describe, it, expect, vi } from "vitest";
import type { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import { WsDeliverer } from "../../src/notifier/ws-deliverer.js";
import type { Device, NotificationPayload } from "../../src/notifier/types.js";

function makeMockClient(response: "success" | Error): ApiGatewayManagementApiClient {
  const send = response === "success"
    ? vi.fn().mockResolvedValue({})
    : vi.fn().mockRejectedValue(response);
  return { send } as unknown as ApiGatewayManagementApiClient;
}

const device: Device = {
  accountId: "acct-1",
  token: "conn-abc123",
  type: "websocket",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const payload: NotificationPayload = {
  type: "signal:created",
  signalId: "SES#msg-001",
  threadId: "arc-uuid-1",
  from: { address: "alice@example.com", name: "Alice" },
  subject: "Test subject",
  workflow: "default",
  urgency: "normal",
};

describe("WsDeliverer", () => {
  it("returns delivered on successful post", async () => {
    const client = makeMockClient("success");
    const deliverer = new WsDeliverer(client);

    const result = await deliverer.deliver(device, payload, "ambient");

    expect(result).toEqual({ status: "delivered" });
  });

  it("sends JSON payload to the correct connection", async () => {
    const client = makeMockClient("success");
    const deliverer = new WsDeliverer(client);

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
    ])("returns stale when $label", async ({ error }) => {
      const client = makeMockClient(error);
      const deliverer = new WsDeliverer(client);

      const result = await deliverer.deliver(device, payload, "interrupt");

      expect(result).toEqual({ status: "stale" });
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
        label: "503 ServiceUnavailable",
        error: Object.assign(new Error("Service unavailable"), {
          name: "ServiceUnavailableException",
          $metadata: { httpStatusCode: 503 },
        }),
      },
      {
        label: "timeout (generic Error)",
        error: new Error("Connection timed out"),
      },
    ])("returns failed with reason when $label", async ({ error }) => {
      const client = makeMockClient(error);
      const deliverer = new WsDeliverer(client);

      const result = await deliverer.deliver(device, payload, "ambient");

      expect(result).toEqual({ status: "failed", reason: error.message });
    });
  });

  it("returns failed with generic reason for non-Error throw", async () => {
    const send = vi.fn().mockRejectedValue("string-error");
    const client = { send } as unknown as ApiGatewayManagementApiClient;
    const deliverer = new WsDeliverer(client);

    const result = await deliverer.deliver(device, payload, "ambient");

    expect(result).toEqual({ status: "failed", reason: "Unknown WebSocket delivery error" });
  });
});
