import type { Result } from "neverthrow";
import type { Arc, ArcUrgency, PushPriority, Signal } from "../types/index.js";
import type { DbError } from "../errors.js";

export { urgencyToPushPriority } from "../processor/priority.js";

// ─── Device Model ────────────────────────────────────────────────────────────

export type DeviceType = "websocket" | "fcm" | "apns";

export interface Device {
  accountId: string;
  token: string;
  type: DeviceType;
  createdAt: string;
  updatedAt: string;
  ttl?: number;
}

// ─── Delivery ────────────────────────────────────────────────────────────────

export type DeliveryResult =
  | { status: "delivered" }
  | { status: "stale" }
  | { status: "failed"; reason: string };

export interface Deliverer {
  deliver(device: Device, payload: NotificationPayload, priority: PushPriority): Promise<DeliveryResult>;
}

// ─── Notification Payload ────────────────────────────────────────────────────

export interface NotificationPayload {
  type: "signal";
  signalId: string;
  arcId: string;
  sender: string;
  senderName: string;
  subject: string;
  workflow: string;
  urgency: ArcUrgency;
}

// ─── Notifier Interface ──────────────────────────────────────────────────────

export interface Notifier {
  notify(accountId: string, arc: Arc, signal: Signal, urgency: ArcUrgency): Promise<Result<void, DbError>>;
  notifyBlocked(accountId: string, signal: Signal): Promise<Result<void, DbError>>;
}

export type { ArcUrgency, PushPriority, Arc, Signal, DbError, Result };
