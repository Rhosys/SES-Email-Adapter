import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { ok, err } from "../errors.js";
import type { Result } from "../errors.js";
import type { DeviceStore } from "./device-store.js";
import type { Device, Deliverer, DeliverablePayload, DeliveryError, PushPriority } from "./types.js";

export class WsDeliverer implements Deliverer {
  constructor(
    private readonly apigw: ApiGatewayManagementApiClient,
    private readonly deviceStore: DeviceStore,
  ) {}

  async deliver(device: Device, payload: DeliverablePayload, _priority: PushPriority): Promise<Result<void, DeliveryError>> {
    const result = await this.sendRaw(device.token, JSON.stringify(payload));
    if (result.isOk()) {
      return ok(undefined);
    }
    if (result.error.kind === "gone") {
      const deleteResult = await this.deviceStore.deleteDevice(device.accountId, device.token);
      if (deleteResult.isErr()) { /* best-effort cleanup — connection already gone */ }
      return ok(undefined);
    }
    return err({ kind: "delivery_failed", reason: result.error.reason, cause: result.error.cause });
  }

  async sendRaw(connectionId: string, data: string): Promise<Result<void, WsSendError>> {
    try {
      await this.apigw.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: new TextEncoder().encode(data),
        })
      );
      return ok(undefined);
    } catch (error: unknown) {
      if (isGoneException(error)) {
        return err({ kind: "gone", connectionId });
      }
      return err({ kind: "delivery_failed", reason: describeError(error), cause: error });
    }
  }
}

export type WsSendError =
  | { kind: "gone"; connectionId: string }
  | { kind: "delivery_failed"; reason: string; cause: unknown };

function isGoneException(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "GoneException" || e.$metadata?.httpStatusCode === 410;
}

// Include the AWS SDK error name and HTTP status alongside the message — a bare
// message like "Forbidden" is meaningless without them (403 there almost always
// means the Lambda role is missing execute-api:ManageConnections on this
// WebSocket API/stage, not that the connection itself is invalid).
function describeError(error: unknown): string {
  if (error == null || typeof error !== "object") {
    return error instanceof Error ? error.message : "Unknown WebSocket delivery error";
  }
  const e = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } };
  const statusCode = e.$metadata?.httpStatusCode;
  const parts = [e.name ?? "Error", statusCode !== undefined ? `HTTP ${statusCode}` : undefined, e.message];
  return parts.filter(Boolean).join(" ");
}
