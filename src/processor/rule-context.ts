import type { Signal, Thread } from "../types/index.js";

// Curated signal/thread shape exposed to rule conditions and template functions.
// Keep this an explicit allowlist — never widen by passing the raw Signal/Thread objects.
export type RuleSignalContext = Pick<Signal["data"], "from" | "subject" | "summary" | "workflow" | "recipientAddress" | "workflowData"> & Pick<Signal, "id">;
export type RuleThreadContext = Pick<Thread, "id" | "labels" | "urgency" | "summary" | "workflow" | "status">;

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

export function toRuleThreadContext(thread: Thread): RuleThreadContext {
  return {
    id: thread.id,
    labels: thread.labels,
    ...(thread.urgency !== undefined ? { urgency: thread.urgency } : {}),
    summary: thread.summary,
    workflow: thread.workflow,
    status: thread.status,
  };
}
