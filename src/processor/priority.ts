import type { ThreadUrgency, PushPriority, Workflow, WorkflowData } from "../types/index.js";

export function baseUrgency(workflow: Workflow, data: WorkflowData): ThreadUrgency {
  switch (workflow) {
    case "auth":
      return "critical";

    // payments: payment_failed demands immediate action
    case "payments":
      return (data as { paymentType?: string }).paymentType === "payment_failed" ? "critical" : "normal";

    // passive content — low noise
    case "content":
      return "low";

    // notice: passive unless the user must act (e.g. remove content before an account freeze)
    case "notice":
      return (data as { requiresAction?: boolean }).requiresAction === true ? "high" : "silent";

    // onboarding emails are silent — passive, never interrupt
    case "onboarding":
      return "silent";

    // test emails are high — user is actively waiting for confirmation
    case "test":
      return "high";

    default:
      return "normal";
  }
}

// Maps a ThreadUrgency to the equivalent mobile push notification tier.
export function urgencyToPushPriority(urgency: ThreadUrgency): PushPriority {
  if (urgency === "critical" || urgency === "high") return "interrupt";
  if (urgency === "normal" || urgency === "low") return "ambient";
  return "silent";
}
