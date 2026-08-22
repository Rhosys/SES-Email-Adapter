import type { FcmClient, FcmMessage } from "./fcm-client.js";
import type { Device, Deliverer, DeliverablePayload, DeliveryResult, NotificationPayload, PushPriority } from "./types.js";

export class FcmDeliverer implements Deliverer {
  constructor(private readonly fcmClient: FcmClient) {}

  async deliver(device: Device, payload: DeliverablePayload, priority: PushPriority): Promise<DeliveryResult> {
    // FCM/APNs push is only wired up for thread:updated today — OTP delivery is WsDeliverer-only
    // (in-app banner, see AuthWorkflowHandler). Fail loudly rather than building a malformed
    // notification if that ever changes without updating buildFcmMessage below.
    if (payload.type !== "thread:updated") {
      return { status: "failed", reason: `FcmDeliverer cannot build a notification for payload type "${payload.type}"` };
    }

    const effectivePriority = priority === "silent" ? "ambient" : priority;
    const message = buildFcmMessage(device.token, payload, effectivePriority);

    const result = await this.fcmClient.send(message);

    if (result.ok) {
      return { status: "delivered" };
    }

    if (result.error === "UNREGISTERED") {
      return { status: "stale" };
    }

    return { status: "failed", reason: `${result.error}${result.detail ? `: ${result.detail}` : ""}` };
  }
}

function buildFcmMessage(token: string, payload: NotificationPayload, priority: "interrupt" | "ambient"): FcmMessage {
  const isInterrupt = priority === "interrupt";
  const displayName = payload.from.name ?? payload.from.address;

  return {
    token,
    notification: {
      title: displayName,
      body: payload.subject,
    },
    data: {
      signalId: payload.signalId ?? "",
      threadId: payload.threadId,
      senderName: displayName,
      subject: payload.subject,
      workflow: payload.workflow,
    },
    android: {
      priority: isInterrupt ? "high" : "normal",
      notification: {
        sound: isInterrupt ? "default" : "",
        channelId: isInterrupt ? "interrupt" : "ambient",
      },
    },
    apns: {
      headers: { "apns-priority": isInterrupt ? "10" : "5" },
      payload: {
        aps: {
          badge: 1,
          ...(isInterrupt ? { sound: "default" } : {}),
        },
      },
    },
  };
}
