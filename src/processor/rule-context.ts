import type { Signal, Arc } from "../types/index.js";

// Curated signal/arc shape exposed to rule conditions and template functions.
// Keep this an explicit allowlist — never widen by passing the raw Signal/Arc objects.
export type RuleSignalContext = Pick<Signal["data"], "from" | "subject" | "summary" | "workflow" | "recipientAddress" | "workflowData"> & Pick<Signal, "id">;
export type RuleArcContext = Pick<Arc, "id" | "labels" | "urgency" | "summary" | "workflow" | "status">;

export function toRuleSignalContext(signal: Signal): RuleSignalContext {
  return {
    id: signal.id,
    from: signal.data.from,
    subject: signal.data.subject,
    summary: signal.data.summary,
    workflow: signal.data.workflow,
    recipientAddress: signal.data.recipientAddress,
    workflowData: signal.data.workflowData,
  };
}

export function toRuleArcContext(arc: Arc): RuleArcContext {
  return {
    id: arc.id,
    labels: arc.labels,
    ...(arc.urgency !== undefined ? { urgency: arc.urgency } : {}),
    summary: arc.summary,
    workflow: arc.workflow,
    status: arc.status,
  };
}
