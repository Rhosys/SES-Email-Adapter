import type { Result } from "neverthrow";
import { ok } from "../errors.js";
import type { DbError } from "../errors.js";
import type { Signal, Arc, AuthData } from "../types/index.js";
import type { WorkflowHandler } from "./types.js";
import type { DeviceStore } from "../notifier/device-store.js";
import type { Deliverer, DeliveryResult } from "../notifier/types.js";
import type { ArcDatabase } from "../database/arc-database.js";
import type { Logger } from "../logger.js";
import { getETLD1 } from "../processor/filter.js";

export interface OtpPayload {
  type: "otp";
  signalId: string;
  code: string;
  authType: AuthData["authType"];
  expiresInMinutes?: number;
  originDomain: string;
  subject: string;
}

export class AuthWorkflowHandler implements WorkflowHandler {
  readonly workflow = "auth" as const;

  constructor(
    private readonly deviceStore: DeviceStore,
    private readonly wsDeliverer: Deliverer,
    private readonly arcDatabase: ArcDatabase,
    private readonly logger: Logger,
  ) {}

  async execute(signal: Signal, arc: Arc, accountId: string): Promise<Result<void, DbError>> {
    const workflowData = signal.workflowData as AuthData;

    if (!workflowData.code) {
      return ok(undefined);
    }

    const payload = this.buildOtpPayload(signal, workflowData);
    await this.deliverToAll(accountId, payload);

    // Archive — auth arcs don't need to stay in the inbox
    const archiveResult = await this.arcDatabase.updateArc(accountId, arc.id, "archived", arc.lastSignalAt, {});
    if (archiveResult.isErr()) {
      this.logger.warn("Failed to archive auth arc after OTP push", {
        code: "workflow.auth.archive_failed", accountId, arcId: arc.id, error: archiveResult.error,
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
      originDomain: getETLD1(signal.from.address),
      subject: signal.subject,
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
      const result: DeliveryResult = await this.wsDeliverer.deliver(device, payload as any, "interrupt");
      if (result.status === "stale") {
        await this.deviceStore.deleteDevice(accountId, device.token);
      } else if (result.status === "failed") {
        this.logger.warn("OTP delivery failed", {
          code: "workflow.auth.delivery_failed", accountId, token: device.token, reason: result.reason,
        });
      }
    }
  }
}
