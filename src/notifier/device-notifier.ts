import { ok, err, dbError } from "../errors.js";
import type { Result, DbError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Arc, ArcUrgency, Signal } from "../types/index.js";
import type { DeviceStore } from "./device-store.js";
import type { Deliverer, Device, DeviceType, Notifier, NotificationPayload } from "./types.js";
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

  async notify(accountId: string, arc: Arc, signal: Signal, urgency?: ArcUrgency): Promise<Result<void, DbError>> {
    const effectiveUrgency: ArcUrgency = urgency ?? "normal";
    const priority = urgencyToPushPriority(effectiveUrgency);

    const devicesResult = await this.deviceStore.listDevices(accountId);
    if (devicesResult.isErr()) {
      return err(devicesResult.error);
    }

    const devices = devicesResult.value;
    if (devices.length === 0) {
      return ok(undefined);
    }

    const payload = buildPayload(arc, signal, effectiveUrgency);

    let successCount = 0;
    const staleTokens: string[] = [];

    for (const device of devices) {
      // Skip mobile push devices when priority is silent
      if (priority === "silent" && (device.type === "fcm" || device.type === "apns")) {
        continue;
      }

      const deliverer = this.deliverers[device.type];
      if (!deliverer) {
        this.logger.warn("No deliverer registered for device type", { code: "notifier.no_deliverer", deviceType: device.type, accountId });
        continue;
      }

      try {
        const result = await deliverer.deliver(device, payload, priority);

        if (result.status === "delivered") {
          successCount++;
        } else if (result.status === "stale") {
          staleTokens.push(device.token);
        } else {
          this.logger.warn("Device delivery failed", { code: "notifier.delivery_failed", deviceType: device.type, token: device.token, reason: result.reason, accountId });
        }
      } catch (e) {
        this.logger.error("Unexpected error delivering to device", { code: "notifier.delivery_error", deviceType: device.type, token: device.token, accountId, error: String(e) });
      }
    }

    // Delete stale devices
    for (const token of staleTokens) {
      const deleteResult = await this.deviceStore.deleteDevice(accountId, token);
      if (deleteResult.isErr()) {
        this.logger.warn("Failed to delete stale device", { code: "notifier.stale_delete_failed", token, accountId });
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

function buildPayload(arc: Arc, signal: Signal, urgency: ArcUrgency): NotificationPayload {
  return {
    type: "signal",
    signalId: signal.id,
    arcId: arc.id,
    sender: signal.from.address,
    senderName: signal.from.name ?? signal.from.address,
    subject: signal.subject,
    workflow: arc.workflow,
    urgency,
  };
}
