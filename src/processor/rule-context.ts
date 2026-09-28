import type { Signal, Thread } from "../types/index.js";

import { isInboundEmailSignalData } from "../types/index.js";
import type { EmailAddress, Workflow, WorkflowData } from "../types/index.js";
import { hasCalendarAttachment } from "./calendar/ics-parser.js";

// Curated signal/thread shape exposed to rule conditions and template functions.
// Keep this an explicit allowlist — never widen by passing the raw Signal/Thread objects.
// `body` is the message body — the rendered HTML for inbound (received) email, and the
// user-authored markdown for outbound drafts. workflow/workflowData are inbound-only
// classification, absent (undefined) on outbound.
export interface RuleSignalContext {
  id: string;
  from: EmailAddress;
  subject: string;
  summary: string;
  body?: string;
  workflow?: Workflow;
  recipientAddress: string;
  workflowData?: WorkflowData;
  // Whether THIS message carries a calendar attachment (.ics / text/calendar), so a
  // forwarding rule can fire only on messages that actually bear an invite — not on
  // every message that lands on a thread already labelled system:calendar.
  hasCalendarInvite: boolean;
}
export type RuleThreadContext = Pick<Thread, "id" | "labels" | "urgency" | "summary" | "workflow" | "status">;

export function toRuleSignalContext(signal: Signal): RuleSignalContext {
  const data = signal.data;
  const body = isInboundEmailSignalData(data) ? data.htmlBody : data.textBody;
  return {
    id: signal.id,
    from: data.from,
    subject: data.subject,
    summary: data.summary,
    ...(body !== undefined ? { body } : {}),
    recipientAddress: data.recipientAddress,
    hasCalendarInvite: hasCalendarAttachment(data.attachments ?? []),
    ...(isInboundEmailSignalData(data) ? { workflow: data.workflow, workflowData: data.workflowData } : {}),
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
