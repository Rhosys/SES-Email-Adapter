import type { ArcUrgency, PushPriority, Workflow, WorkflowData } from "../types/index.js";

export function baseUrgency(workflow: Workflow, data: WorkflowData): ArcUrgency {
  switch (workflow) {
    case "auth":
      return "critical";

    // alerts: critical when action is required, high otherwise
    case "alert":
      return (data as { requiresAction?: boolean }).requiresAction ? "critical" : "high";

    // payments: payment_failed demands immediate action
    case "payments":
      return (data as { paymentType?: string }).paymentType === "payment_failed" ? "critical" : "normal";

    // passive content — low noise
    case "content":
      return "low";

    // onboarding and status emails are silent — passive, never interrupt
    case "onboarding":
    case "status":
      return "silent";

    // test emails are high — user is actively waiting for confirmation
    case "test":
      return "high";

    default:
      return "normal";
  }
}

// Maps an ArcUrgency to the equivalent mobile push notification tier.
export function urgencyToPushPriority(urgency: ArcUrgency): PushPriority {
  if (urgency === "critical" || urgency === "high") return "interrupt";
  if (urgency === "normal" || urgency === "low") return "ambient";
  return "silent";
}
