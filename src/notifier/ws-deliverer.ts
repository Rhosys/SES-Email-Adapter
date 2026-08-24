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
      return { status: "failed", reason: describeError(error) };
    }
  }
}

function isGoneException(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err.name === "GoneException" || err.$metadata?.httpStatusCode === 410;
}

// Include the AWS SDK error name and HTTP status alongside the message — a bare
// message like "Forbidden" is meaningless without them (403 there almost always
// means the Lambda role is missing execute-api:ManageConnections on this
// WebSocket API/stage, not that the connection itself is invalid).
function describeError(error: unknown): string {
  if (error == null || typeof error !== "object") {
    return error instanceof Error ? error.message : "Unknown WebSocket delivery error";
  }
  const err = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } };
  const statusCode = err.$metadata?.httpStatusCode;
  const parts = [err.name ?? "Error", statusCode !== undefined ? `HTTP ${statusCode}` : undefined, err.message];
  return parts.filter(Boolean).join(" ");
}
