import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import type { Device, Deliverer, DeliverablePayload, DeliveryResult, PushPriority } from "./types.js";

export class WsDeliverer implements Deliverer {
  constructor(private readonly apigw: ApiGatewayManagementApiClient) {}

  async deliver(device: Device, payload: DeliverablePayload, _priority: PushPriority): Promise<DeliveryResult> {
    try {
      await this.apigw.send(
        new PostToConnectionCommand({
          ConnectionId: device.token,
          Data: new TextEncoder().encode(JSON.stringify(payload)),
        })
      );
      return { status: "delivered" };
    } catch (error: unknown) {
      if (isGoneException(error)) {
        return { status: "stale" };
      }
      const reason = error instanceof Error ? error.message : "Unknown WebSocket delivery error";
      return { status: "failed", reason };
    }
  }
}

function isGoneException(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err.name === "GoneException" || err.$metadata?.httpStatusCode === 410;
}
