import { ok, err, dbError } from "../errors.js";
import type { Result, DbError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Thread, ThreadUrgency, Signal } from "../types/index.js";
import type { DeviceStore } from "./device-store.js";
import type { Deliverer, DeviceType, Notifier, NotificationPayload, NotificationReason } from "./types.js";
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

  async notify(accountId: string, thread: Thread, signal: Signal | undefined, urgency?: ThreadUrgency, reason?: NotificationReason): Promise<Result<void, DbError>> {
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
    const failureReasons: string[] = [];

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

      const result = await deliverer.deliver(device, payload, priority);

      if (result.isOk()) {
        successCount++;
      } else {
        this.logger.error(`Device delivery failed: ${result.error.reason}`, { code: "notifier.delivery_failed", signal, thread, deviceType: device.type, token: device.token, reason: result.error.reason, error: result.error.cause });
        failureReasons.push(`${device.type}: ${result.error.reason}`);
      }
    }

    // Determine eligible device count (devices that were actually attempted)
    const eligibleCount = devices.filter(d => !(priority === "silent" && (d.type === "fcm" || d.type === "apns"))).length;

    // Ok if at least one succeeded or no eligible devices; Err only on total failure
    if (successCount > 0 || eligibleCount === 0) {
      this.logger.info("Notification delivered", { code: "notifier.delivered", accountId, threadId: thread.id, deviceCount: successCount });
      return ok(undefined);
    }

    const reasonSummary = failureReasons.length > 0 ? failureReasons.join("; ") : "no eligible devices attempted";
    this.logger.error("Total notification delivery failure", { code: "notifier.total_delivery_failure", accountId, threadId: thread.id, reasons: failureReasons });
    return err(dbError(`Total delivery failure: all device deliveries failed (${reasonSummary})`));
  }

  notifyBlocked(_accountId: string, _signal: Signal): Promise<Result<void, DbError>> {
    return Promise.resolve(ok(undefined));
  }
}

function buildPayload(thread: Thread, signal: Signal | undefined, urgency: ThreadUrgency, reason?: NotificationReason): NotificationPayload {
  const from: NotificationPayload["from"] = signal
    ? { address: signal.data.from.address, ...(signal.data.from.name ? { name: signal.data.from.name } : {}) }
    : { address: thread.sender.address, ...(thread.sender.name ? { name: thread.sender.name } : {}) };
  const payload: NotificationPayload = {
    type: "thread:updated",
    ...(signal ? { signalId: signal.id } : {}),
    threadId: thread.id,
    from,
    subject: signal ? signal.data.subject : thread.subject,
    workflow: thread.workflow,
    urgency,
  };
  if (reason) {
    payload.reason = reason;
  }
  return payload;
}
