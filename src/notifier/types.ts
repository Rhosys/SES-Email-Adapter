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

export type DeliveryError = { kind: "delivery_failed"; reason: string; cause: unknown };

export interface Deliverer {
  deliver(device: Device, payload: DeliverablePayload, priority: PushPriority): Promise<Result<void, DeliveryError>>;
}

// ─── Notification Payload ────────────────────────────────────────────────────

export type NotificationReason = "new_signal" | "followup" | "rsvp_reminder";

export interface NotificationPayload {
  type: "thread:updated";
  signalId?: string;
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
  /** A new email signal arrived on the thread — the notification's from/subject are taken from
   *  the signal itself. Only email signals carry from/subject, so the param is email-only. */
  notifySignal(accountId: string, thread: Thread, signal: Signal, urgency?: ThreadUrgency, reason?: NotificationReason): Promise<Result<void, DbError>>;
  /** A time-based re-surface of an existing thread (follow-up, RSVP reminder) — there is no
   *  triggering signal, so the notification's from/subject come from the thread. */
  notifyThread(accountId: string, thread: Thread, urgency?: ThreadUrgency, reason?: NotificationReason): Promise<Result<void, DbError>>;
  notifyBlocked(accountId: string, signal: Signal): Promise<Result<void, DbError>>;
}

export type { ThreadUrgency, PushPriority, Thread, Signal, DbError, Result };
