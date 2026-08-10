import { describe, it, expect, vi } from "vitest";
import type { FcmClient, FcmMessage, FcmSendResult } from "../../src/notifier/fcm-client.js";
import { FcmDeliverer } from "../../src/notifier/fcm-deliverer.js";
import type { Device, NotificationPayload, PushPriority } from "../../src/notifier/types.js";

function makeMockFcmClient(result: FcmSendResult): { client: FcmClient; capturedMessage: () => FcmMessage } {
  let captured: FcmMessage | undefined;
  const client: FcmClient = {
    send: vi.fn(async (message: FcmMessage) => {
      captured = message;
      return result;
    }),
  };
  return { client, capturedMessage: () => captured! };
}

const device: Device = {
  accountId: "acct-1",
  token: "fcm-token-abc",
  type: "fcm",
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

describe("FcmDeliverer", () => {
  it("returns delivered on successful send", async () => {
    const { client } = makeMockFcmClient({ ok: true, messageId: "msg-123" });
    const deliverer = new FcmDeliverer(client);

    const result = await deliverer.deliver(device, payload, "interrupt");

    expect(result).toEqual({ status: "delivered" });
  });

  describe("Property 5: push priority fields match PushPriority", () => {
    it.each([
      {
        label: "interrupt → high priority, sound enabled, badge 1",
        priority: "interrupt" as PushPriority,
        expected: {
          android: { priority: "high", notification: { sound: "default", channelId: "interrupt" } },
          apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default", badge: 1 } } },
        },
      },
      {
        label: "ambient → normal priority, no sound, badge only",
        priority: "ambient" as PushPriority,
        expected: {
          android: { priority: "normal", notification: { sound: "", channelId: "ambient" } },
          apns: { headers: { "apns-priority": "5" }, payload: { aps: { badge: 1 } } },
        },
      },
      {
        label: "silent → treated as ambient (defensive fallback)",
        priority: "silent" as PushPriority,
        expected: {
          android: { priority: "normal", notification: { sound: "", channelId: "ambient" } },
          apns: { headers: { "apns-priority": "5" }, payload: { aps: { badge: 1 } } },
        },
      },
    ])("$label", async ({ priority, expected }) => {
      const { client, capturedMessage } = makeMockFcmClient({ ok: true, messageId: "msg-123" });
      const deliverer = new FcmDeliverer(client);

      await deliverer.deliver(device, payload, priority);

      const message = capturedMessage();
      expect(message.android).toEqual(expected.android);
      expect(message.apns).toEqual(expected.apns);
    });
  });

  describe("error handling", () => {
    it("returns stale on UNREGISTERED error", async () => {
      const { client } = makeMockFcmClient({ ok: false, error: "UNREGISTERED", detail: "Token expired" });
      const deliverer = new FcmDeliverer(client);

      const result = await deliverer.deliver(device, payload, "interrupt");

      expect(result).toEqual({ status: "stale" });
    });

    it.each([
      {
        label: "UNAVAILABLE → failed",
        sendResult: { ok: false as const, error: "UNAVAILABLE" as const, detail: "Service down" },
      },
      {
        label: "INTERNAL → failed",
        sendResult: { ok: false as const, error: "INTERNAL" as const, detail: "Server error" },
      },
    ])("$label", async ({ sendResult }) => {
      const { client } = makeMockFcmClient(sendResult);
      const deliverer = new FcmDeliverer(client);

      const result = await deliverer.deliver(device, payload, "ambient");

      expect(result).toEqual({
        status: "failed",
        reason: `${sendResult.error}: ${sendResult.detail}`,
      });
    });
  });

  it("passes device token to FCM message", async () => {
    const { client, capturedMessage } = makeMockFcmClient({ ok: true, messageId: "msg-123" });
    const deliverer = new FcmDeliverer(client);

    await deliverer.deliver(device, payload, "ambient");

    expect(capturedMessage().token).toBe("fcm-token-abc");
  });

  it("includes notification title and body from payload", async () => {
    const { client, capturedMessage } = makeMockFcmClient({ ok: true, messageId: "msg-123" });
    const deliverer = new FcmDeliverer(client);

    await deliverer.deliver(device, payload, "ambient");

    expect(capturedMessage().notification).toEqual({ title: "Alice", body: "Test subject" });
  });

  it("includes data payload with signal fields", async () => {
    const { client, capturedMessage } = makeMockFcmClient({ ok: true, messageId: "msg-123" });
    const deliverer = new FcmDeliverer(client);

    await deliverer.deliver(device, payload, "ambient");

    expect(capturedMessage().data).toEqual({
      signalId: "SES#msg-001",
      threadId: "arc-uuid-1",
      senderName: "Alice",
      subject: "Test subject",
      workflow: "default",
    });
  });
});
