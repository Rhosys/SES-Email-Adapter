// ---------------------------------------------------------------------------
// Digest Data Mapper
// Transforms Thread + latest Signal into flat, Mustache-friendly objects for
// the digest email template. Each field is a pre-formatted string — no logic
// in the template layer.
// ---------------------------------------------------------------------------

import type { Thread, Workflow, WorkflowData, EmailSignalData, Signal } from "../types/index.js";
import { isEmailSignal } from "../types/index.js";
import type { AnySignal } from "../types/index.js";
import type { IEmailTheme } from "../email/email-theme.js";

// ---------------------------------------------------------------------------
// Output shape — every field consumed by digest.mjml
// ---------------------------------------------------------------------------

export interface DigestCard {
  // Thread identity
  threadUrl: string;

  // Row 1: sender + time
  senderName: string;
  senderAddress: string;
  timestamp: string;             // relative label ("2h ago", "Yesterday", etc.)

  // Row 2: subject
  subject: string;

  // Row 3: summary
  summary: string;

  // Row 4: workflow + urgency
  workflowEmoji: string;
  workflowLabel: string;
  urgency: string;               // "critical" | "high" | "" (empty = normal/low/silent)
  urgencyColor: string;          // hex color for the pill, empty when no pill
  urgencyLabel: string;          // display text for the pill

  // Row 5: labels (comma-separated)
  labels: string;
  hasLabels: boolean;

  // Row 6: inline workflow detail (compact one-liner like the site panels)
  workflowDetail: string;
  hasWorkflowDetail: boolean;

  // Signal metadata
  lastSignalFrom: string;        // display name or address of latest signal sender
  lastSignalReceivedAt: string;  // ISO string for the latest signal
}

// ---------------------------------------------------------------------------
// Workflow emoji map — matches the site's compact panel icons
// ---------------------------------------------------------------------------

const WORKFLOW_EMOJI: Record<string, string> = {
  auth: "\u{1F511}",           // 🔑
  conversation: "\u{1F4AC}",   // 💬
  crm: "\u{1F3E2}",           // 🏢
  package: "\u{1F4E6}",       // 📦
  travel: "\u2708",            // ✈
  payments: "\u{1F4B3}",      // 💳
  alert: "\u26A0",             // ⚠
  content: "\u{1F4F0}",       // 📰
  onboarding: "\u{1F44B}",    // 👋
  notice: "\u{1F4CB}",        // 📋 (shared with status)
  status: "\u{1F4CB}",        // 📋
  healthcare: "\u{1F3E5}",    // 🏥
  job: "\u{1F4BC}",           // 💼
  support: "\u{1F3AB}",       // 🎫
  events: "\u{1F39F}\uFE0F",  // 🎟️
  test: "\u{1F9EA}",          // 🧪
};

const WORKFLOW_LABEL: Record<string, string> = {
  auth: "Authentication",
  conversation: "Conversation",
  crm: "CRM",
  package: "Package",
  travel: "Travel",
  payments: "Payments",
  alert: "Alert",
  content: "Content",
  onboarding: "Onboarding",
  notice: "Notice",
  status: "Status",
  healthcare: "Healthcare",
  job: "Job",
  support: "Support",
  events: "Events",
  test: "Test",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DigestMapperInput {
  thread: Thread;
  latestSignal: AnySignal | null;
  appBaseUrl: string;
  theme: IEmailTheme;
}

export function mapThreadToCard(input: DigestMapperInput): DigestCard {
  const { thread, latestSignal, appBaseUrl, theme } = input;

  const emailSignal = latestSignal && isEmailSignal(latestSignal)
    ? latestSignal as Signal<EmailSignalData>
    : null;

  const senderName = thread.sender.name ?? "";
  const senderAddress = thread.sender.address;

  const urgency = thread.urgency ?? "normal";
  const { color: urgencyColor, label: urgencyLabel } = urgencyDisplay(urgency, theme);

  const workflowData = emailSignal?.data.workflowData ?? null;
  const workflowDetail = workflowData ? buildWorkflowDetail(thread.workflow, workflowData) : "";

  const labels = thread.labels.filter(l => !l.startsWith("_")).join(", ");

  return {
    threadUrl: `${appBaseUrl}/a/thread/${thread.id}`,
    senderName,
    senderAddress,
    timestamp: formatRelativeTime(thread.lastSignalAt),
    subject: thread.subject || thread.summary,
    summary: thread.summary,
    workflowEmoji: WORKFLOW_EMOJI[thread.workflow] ?? "\u{2709}\uFE0F",
    workflowLabel: WORKFLOW_LABEL[thread.workflow] ?? thread.workflow,
    urgency: urgency === "critical" || urgency === "high" ? urgency : "",
    urgencyColor,
    urgencyLabel,
    labels,
    hasLabels: labels.length > 0,
    workflowDetail,
    hasWorkflowDetail: workflowDetail.length > 0,
    lastSignalFrom: emailSignal
      ? (emailSignal.data.from.name ?? emailSignal.data.from.address)
      : senderName || senderAddress,
    lastSignalReceivedAt: emailSignal?.data.receivedAt ?? thread.lastSignalAt,
  };
}

// ---------------------------------------------------------------------------
// Urgency → color + label
// ---------------------------------------------------------------------------

function urgencyDisplay(urgency: string, theme: IEmailTheme): { color: string; label: string } {
  switch (urgency) {
    case "critical":
      return { color: theme.error, label: "Critical" };
    case "high":
      return { color: theme.warning, label: "High" };
    default:
      return { color: "", label: "" };
  }
}

// ---------------------------------------------------------------------------
// Relative time formatting (for email — static at send time)
// ---------------------------------------------------------------------------

function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Inline workflow detail — mirrors the site's compact panel one-liners
// ---------------------------------------------------------------------------

function buildWorkflowDetail(workflow: Workflow, data: WorkflowData): string {
  switch (workflow) {
    case "auth": {
      if (data.workflow !== "auth") return "";
      const parts = [data.service];
      const typeLabel: Record<string, string> = {
        verification: "Verification code",
        password_reset: "Password reset",
        two_factor: "2FA code",
        security_alert: "Security alert",
      };
      parts.push(typeLabel[data.authType] ?? data.authType);
      if (data.code) parts.push(`Code: ${data.code}`);
      return parts.join(" · ");
    }

    case "conversation": {
      if (data.workflow !== "conversation") return "";
      return data.requiresReply ? "Reply needed" : "";
    }

    case "crm": {
      if (data.workflow !== "crm") return "";
      const parts: string[] = [];
      if (data.senderCompany) parts.push(data.senderCompany);
      if (data.senderRole) parts.push(data.senderRole);
      return parts.join(" · ");
    }

    case "package": {
      if (data.workflow !== "package") return "";
      const typeLabel: Record<string, string> = {
        confirmation: "Order confirmed",
        shipping: "Shipped",
        out_for_delivery: "Out for delivery",
        delivered: "Delivered",
        return: "Return requested",
        refund: "Refund issued",
        cancellation: "Order cancelled",
      };
      const parts = [data.retailer, typeLabel[data.packageType] ?? data.packageType];
      if (data.trackingNumber) parts.push(`#${data.trackingNumber}`);
      return parts.join(" · ");
    }

    case "travel": {
      if (data.workflow !== "travel") return "";
      const typeLabel: Record<string, string> = {
        flight: "Flight",
        hotel: "Hotel",
        car_rental: "Car rental",
        train: "Train",
        cruise: "Cruise",
        activity: "Activity",
        itinerary: "Itinerary",
        check_in_reminder: "Check-in",
        boarding_pass: "Boarding pass",
      };
      const parts = [data.provider, typeLabel[data.travelType] ?? data.travelType];
      if (data.origin && data.destination) parts.push(`${data.origin} → ${data.destination}`);
      if (data.confirmationNumber) parts.push(data.confirmationNumber);
      return parts.join(" · ");
    }

    case "payments": {
      if (data.workflow !== "payments") return "";
      const typeLabel: Record<string, string> = {
        invoice: "Invoice",
        receipt: "Receipt",
        subscription_renewal: "Subscription renewal",
        payment_failed: "Payment failed",
        plan_changed: "Plan changed",
        tax: "Tax document",
        wire_transfer: "Wire transfer",
        refund: "Refund",
        statement: "Statement",
      };
      const parts = [data.vendor, typeLabel[data.paymentType] ?? data.paymentType];
      if (data.amount) {
        const num = parseFloat(data.amount);
        if (Number.isFinite(num)) {
          try {
            const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: data.currency ?? "USD" });
            parts.push(fmt.format(num));
          } catch {
            parts.push(`${data.amount} ${data.currency ?? ""}`);
          }
        }
      }
      if (data.invoiceNumber) parts.push(data.invoiceNumber);
      return parts.join(" · ");
    }

    case "alert": {
      if (data.workflow !== "alert") return "";
      const typeLabel: Record<string, string> = {
        suspicious_login: "Suspicious login",
        new_device: "New device",
        password_changed: "Password changed",
        breach_notice: "Breach notice",
        api_key_exposed: "API key exposed",
        account_locked: "Account locked",
        fraud_alert: "Fraud alert",
        ci_failure: "CI failed",
        deployment_failed: "Deploy failed",
        error_spike: "Error spike",
        domain_expiry: "Domain expiring",
        cert_expiry: "Cert expiring",
        security_scan: "Security scan",
      };
      const parts = [data.service, typeLabel[data.alertType] ?? data.alertType];
      if (data.severity) parts.push(data.severity.toUpperCase());
      return parts.join(" · ");
    }

    case "content": {
      if (data.workflow !== "content") return "";
      const typeLabel: Record<string, string> = {
        newsletter: "Newsletter",
        promotion: "Promotion",
        social_digest: "Social digest",
        product_update: "Product update",
        announcement: "Announcement",
      };
      return [data.publisher, typeLabel[data.contentType] ?? data.contentType].join(" · ");
    }

    case "healthcare": {
      if (data.workflow !== "healthcare") return "";
      const typeLabel: Record<string, string> = {
        appointment_reminder: "Appointment reminder",
        appointment_confirmation: "Appointment confirmed",
        test_results: "Test results",
        prescription: "Prescription",
        insurance_update: "Insurance update",
        billing: "Billing",
        referral: "Referral",
      };
      const parts: string[] = [];
      if (data.provider) parts.push(data.provider);
      parts.push(typeLabel[data.eventType] ?? data.eventType);
      return parts.join(" · ");
    }

    case "job": {
      if (data.workflow !== "job") return "";
      const typeLabel: Record<string, string> = {
        application_status: "Application update",
        recruiter_outreach: "Recruiter outreach",
        interview_request: "Interview request",
        offer: "Offer",
        rejection: "Rejection",
        job_posting: "Job posting",
      };
      const parts: string[] = [];
      if (data.company) parts.push(data.company);
      if (data.role) parts.push(data.role);
      parts.push(typeLabel[data.jobType] ?? data.jobType);
      return parts.join(" · ");
    }

    case "support": {
      if (data.workflow !== "support") return "";
      const statusLabel: Record<string, string> = {
        ticket_opened: "Opened",
        ticket_updated: "Updated",
        ticket_resolved: "Resolved",
        ticket_closed: "Closed",
        awaiting_response: "Awaiting response",
        status_update: "Status update",
      };
      const parts = [data.service, statusLabel[data.eventType] ?? data.eventType];
      if (data.ticketId) parts.push(`#${data.ticketId}`);
      return parts.join(" · ");
    }

    case "events": {
      if (data.workflow !== "events") return "";
      const parts = [data.eventName];
      if (data.venueName) parts.push(data.venueName);
      if (data.ticketReference) parts.push(data.ticketReference);
      return parts.join(" · ");
    }

    default:
      return "";
  }
}
