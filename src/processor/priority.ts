import type { Arc, Signal, ArcUrgency, PushPriority, Workflow, WorkflowData } from "../types/index.js";

const URGENCY_RANK: Record<ArcUrgency, number> = { critical: 4, high: 3, normal: 2, low: 1, silent: 0 };

function promote(current: ArcUrgency, floor: ArcUrgency): ArcUrgency {
  return URGENCY_RANK[current] >= URGENCY_RANK[floor] ? current : floor;
}

export function baseUrgency(workflow: Workflow, data: WorkflowData): ArcUrgency {
  switch (workflow) {
    case "auth":
    case "security":
      return "critical";

    case "financial":
      return (data as { isSuspicious?: boolean }).isSuspicious ? "critical" : "normal";

    case "developer":
      return (data as { severity?: string }).severity === "critical" &&
        (data as { requiresAction?: boolean }).requiresAction
        ? "critical"
        : "normal";

    case "subscription":
      return (data as { eventType?: string }).eventType === "payment_failed" ? "critical" : "normal";

    case "support":
      return (data as { priority?: string }).priority === "urgent" ? "critical" : "normal";

    case "newsletter":
    case "promotions":
    case "onboarding":
    case "social":
      return "low";

    case "notice":
      return "silent";

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
