import type { Result } from "neverthrow";
import type { Thread, ThreadUrgency, PushPriority, Signal, AuthData } from "../types/index.js";
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
  deliver(device: Device, payload: DeliverablePayload, priority: PushPriority): Promise<DeliveryResult>;
}

// ─── Notification Payload ────────────────────────────────────────────────────

export type NotificationReason = "new_signal" | "followup" | "rsvp_reminder";

export interface NotificationPayload {
  type: "thread:updated";
  signalId: string;
  threadId: string;
  from: { address: string; name?: string };
  subject: string;
  workflow: string;
  urgency: ThreadUrgency;
  reason?: NotificationReason;
}

// In-app OTP banner delivery (WsDeliverer only — see AuthWorkflowHandler). Distinct shape from
// NotificationPayload, so both live in this union rather than behind an `unknown`/`any` cast at
// the call site.
export interface OtpPayload {
  type: "otp";
  signalId: string;
  code: string;
  authType: AuthData["authType"];
  expiresInMinutes?: string;
  originDomain: string;
  subject: string;
}

export type DeliverablePayload = NotificationPayload | OtpPayload;

// ─── Notifier Interface ──────────────────────────────────────────────────────

export interface Notifier {
  notify(accountId: string, thread: Thread, signal: Signal, urgency?: ThreadUrgency, reason?: NotificationReason): Promise<Result<void, DbError>>;
  notifyBlocked(accountId: string, signal: Signal): Promise<Result<void, DbError>>;
}

export type { ThreadUrgency, PushPriority, Thread, Signal, DbError, Result };
