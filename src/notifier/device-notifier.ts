import { ok, err, dbError } from "../errors.js";
import type { Result, DbError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Thread, ThreadUrgency, Signal } from "../types/index.js";
import type { DeviceStore } from "./device-store.js";
import type { Deliverer, Device, DeviceType, Notifier, NotificationPayload, NotificationReason } from "./types.js";
import { urgencyToPushPriority } from "./types.js";

export class DeviceNotifier implements Notifier {
  private readonly deviceStore: DeviceStore;
  private readonly deliverers: Record<DeviceType, Deliverer>;
  private readonly logger: Logger;

  constructor(opts: {
    deviceStore: DeviceStore;
    deliverers: Record<DeviceType, Deliverer>;
    logger: Logger;
  }) {
    this.deviceStore = opts.deviceStore;
    this.deliverers = opts.deliverers;
    this.logger = opts.logger;
  }

  async notify(accountId: string, thread: Thread, signal: Signal, urgency?: ThreadUrgency, reason?: NotificationReason): Promise<Result<void, DbError>> {
    const effectiveUrgency: ThreadUrgency = urgency ?? "normal";
    const priority = urgencyToPushPriority(effectiveUrgency);

    const devicesResult = await this.deviceStore.listDevices(accountId);
    if (devicesResult.isErr()) {
      return err(devicesResult.error);
    }

    const devices = devicesResult.value;
    if (devices.length === 0) {
      return ok(undefined);
    }

    const payload = buildPayload(thread, signal, effectiveUrgency, reason);

    let successCount = 0;
    const staleTokens: string[] = [];

    for (const device of devices) {
      // Skip mobile push devices when priority is silent
      if (priority === "silent" && (device.type === "fcm" || device.type === "apns")) {
        continue;
      }

      const deliverer = this.deliverers[device.type];
      if (!deliverer) {
        this.logger.warn("No deliverer registered for device type", { code: "notifier.no_deliverer", signal, thread, deviceType: device.type });
        continue;
      }

      try {
        const result = await deliverer.deliver(device, payload, priority);

        if (result.status === "delivered") {
          successCount++;
        } else if (result.status === "stale") {
          staleTokens.push(device.token);
        } else {
          this.logger.warn("Device delivery failed", { code: "notifier.delivery_failed", signal, thread, deviceType: device.type, token: device.token, reason: result.reason });
        }
      } catch (e) {
        this.logger.error("Unexpected error delivering to device", { code: "notifier.delivery_error", signal, thread, deviceType: device.type, token: device.token, error: e });
      }
    }

    // Delete stale devices
    for (const token of staleTokens) {
      const deleteResult = await this.deviceStore.deleteDevice(accountId, token);
      if (deleteResult.isErr()) {
        this.logger.warn("Failed to delete stale device", { code: "notifier.stale_delete_failed", signal, thread, token });
      }
    }

    // Determine eligible device count (devices that were actually attempted)
    const eligibleCount = devices.filter(d => !(priority === "silent" && (d.type === "fcm" || d.type === "apns"))).length;

    // Ok if at least one succeeded or no eligible devices; Err only on total failure
    if (successCount > 0 || eligibleCount === 0) {
      return ok(undefined);
    }

    return err(dbError("Total delivery failure: all device deliveries failed"));
  }

  async notifyBlocked(_accountId: string, _signal: Signal): Promise<Result<void, DbError>> {
    return ok(undefined);
  }
}

function buildPayload(thread: Thread, signal: Signal, urgency: ThreadUrgency, reason?: NotificationReason): NotificationPayload {
  const payload: NotificationPayload = {
    type: "signal",
    signalId: signal.id,
    threadId: thread.id,
    sender: signal.data.from.address,
    senderName: signal.data.from.name ?? signal.data.from.address,
    subject: signal.data.subject,
    workflow: thread.workflow,
    urgency,
  };
  if (reason) {
    payload.reason = reason;
  }
  return payload;
}
