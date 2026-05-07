import type { Arc, Signal, ArcUrgency, PushPriority, Workflow, WorkflowData } from "../types/index.js";

export const URGENCY_RANK: Record<ArcUrgency, number> = { critical: 4, high: 3, normal: 2, low: 1, silent: 0 };

function promote(current: ArcUrgency, floor: ArcUrgency): ArcUrgency {
  return URGENCY_RANK[current] >= URGENCY_RANK[floor] ? current : floor;
}

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

    case "support": {
      const d = data as { eventType?: string; priority?: string };
      // lifecycle states that need no action regardless of priority
      if (d.eventType === "ticket_opened" || d.eventType === "ticket_resolved" || d.eventType === "ticket_closed") return "low";
      // agent is waiting on the user — stalls the ticket if ignored
      if (d.eventType === "awaiting_response") return "high";
      if (d.priority === "urgent") return "critical";
      if (d.priority === "high") return "high";
      if (d.priority === "low") return "low";
      return "normal";
    }

    case "conversation": {
      const d = data as { requiresReply?: boolean; sentiment?: string };
      if (d.requiresReply) {
        return (d.sentiment === "urgent" || d.sentiment === "negative") ? "high" : "normal";
      }
      return d.sentiment === "positive" ? "low" : "normal";
    }

    case "crm": {
      const d = data as { crmType?: string; urgency?: string };
      if (d.crmType === "contract" || d.crmType === "proposal") return "high";
      if (d.urgency === "high") return "high";
      if (d.urgency === "medium") return "normal";
      return "low";
    }

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

// Derives the urgency level for an arc after a new signal arrives.
// Arcs where the user has sent at least one outbound email are promoted to at
// least "high" — any reply represents explicit prior engagement.
export function priorityCalculator(arc: Arc, signal: Signal): ArcUrgency {
  const base = baseUrgency(signal.workflow, signal.workflowData);
  if (arc.sentMessageIds && arc.sentMessageIds.length > 0) {
    return promote(base, "high");
  }
  return base;
}

// Maps an ArcUrgency to the equivalent mobile push notification tier.
export function urgencyToPushPriority(urgency: ArcUrgency): PushPriority {
  if (urgency === "critical" || urgency === "high") return "interrupt";
  if (urgency === "normal" || urgency === "low") return "ambient";
  return "silent";
}
