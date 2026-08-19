// ---------------------------------------------------------------------------
// Auth Workflow Handler
// Invoked ASYNCHRONOUSLY from the processor: the inbound signal path dispatches
// a `side_effect` SQS message (no delay), which a separate Lambda invocation
// picks up via handler.ts → processor.processSideEffect() → HandlerRegistry.
// This is NOT inline with inbound signal processing.
// ---------------------------------------------------------------------------
import type { Result } from "neverthrow";
import { ok } from "../errors.js";
import type { DbError } from "../errors.js";
import type { Signal, Thread, AuthData } from "../types/index.js";
import type { WorkflowHandler } from "./types.js";
import type { DeviceStore } from "../notifier/device-store.js";
import type { Deliverer, DeliveryResult, OtpPayload } from "../notifier/types.js";
import type { ThreadDatabase } from "../database/thread-database.js";
import type { Logger } from "../logger.js";
import { getETLD1 } from "../processor/filter.js";

export type { OtpPayload };

export class AuthWorkflowHandler implements WorkflowHandler {
  readonly workflow = "auth" as const;

  constructor(
    private readonly deviceStore: DeviceStore,
    private readonly wsDeliverer: Deliverer,
    private readonly threadDatabase: ThreadDatabase,
    private readonly logger: Logger,
  ) {}

  async execute(signal: Signal, thread: Thread, accountId: string): Promise<Result<void, DbError>> {
    const workflowData = signal.data.workflowData as AuthData;

    if (!workflowData.code) {
      return ok(undefined);
    }

    const payload = this.buildOtpPayload(signal, workflowData);
    await this.deliverToAll(accountId, payload);
    this.logger.info("OTP pushed to devices", { code: "workflow.auth.otp_pushed", accountId, threadId: thread.id });

    // Archive — auth threads don't need to stay in the inbox
    const archiveResult = await this.threadDatabase.updateThread(accountId, thread.id, "archived", thread.lastSignalAt, {});
    if (archiveResult.isErr()) {
      this.logger.warn("Failed to archive auth thread after OTP push", {
        code: "workflow.auth.archive_failed", signal, thread, error: archiveResult.error,
      });
    }

    return ok(undefined);
  }

  private buildOtpPayload(signal: Signal, data: AuthData): OtpPayload {
    return {
      type: "otp",
      signalId: signal.id,
      code: data.code!,
      authType: data.authType,
      ...(data.expiresInMinutes !== undefined ? { expiresInMinutes: data.expiresInMinutes } : {}),
      originDomain: getETLD1(signal.data.from.address),
      subject: signal.data.subject,
    };
  }

  private async deliverToAll(accountId: string, payload: OtpPayload): Promise<void> {
    const devicesResult = await this.deviceStore.listDevices(accountId);
    if (devicesResult.isErr()) {
      this.logger.warn("Failed to list devices for OTP push", {
        code: "workflow.auth.list_devices_failed", accountId, error: devicesResult.error,
      });
      return;
    }

    for (const device of devicesResult.value) {
      const result: DeliveryResult = await this.wsDeliverer.deliver(device, payload, "interrupt");
      if (result.status === "stale") {
        const deleteResult = await this.deviceStore.deleteDevice(accountId, device.token);
        if (deleteResult.isErr()) { this.logger.warn("Failed to delete stale WebSocket device", { code: "workflow.auth.delete_device_failed", accountId, token: device.token, error: deleteResult.error }); }
      } else if (result.status === "failed") {
        this.logger.warn("OTP delivery failed", {
          code: "workflow.auth.delivery_failed", accountId, token: device.token, reason: result.reason,
        });
      }
    }
  }
}
