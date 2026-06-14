import type { Rule } from "../types/index.js";

// ---------------------------------------------------------------------------
// System rules — applied to every account; users can enable/disable individually
// ---------------------------------------------------------------------------

const in_ = (label: string) => ({ "in": [label, { "var": "arc.labels" }] });
const wf_ = (w: string) => ({ "==": [{ "var": "signal.data.workflow" }, w] });
const wfData_ = (field: string) => ({ "var": `signal.data.workflowData.${field}` });

export const SYSTEM_RULES: Rule[] = [
  // --- Sender / content gating (1–8) ----------------------------------------
  { id: "SR-01", accountId: "SYSTEM", name: "Auto-approve sender on matched conversation", condition: JSON.stringify({ "and": [in_("system:workflow:conversation"), in_("system:sender:untrusted"), { "var": "isMatchedArc" }] }), actions: [{ type: "approve_sender" }], status: "enabled", priorityOrder: 1, createdAt: "", updatedAt: "" },
  { id: "SR-02", accountId: "SYSTEM", name: "Block onboarding emails", condition: JSON.stringify(in_("system:workflow:onboarding")), actions: [{ type: "block_hidden" }], status: "enabled", priorityOrder: 2, createdAt: "", updatedAt: "" },
  { id: "SR-03", accountId: "SYSTEM", name: "Block notice emails", condition: JSON.stringify(in_("system:workflow:notice")), actions: [{ type: "block_hidden" }], status: "enabled", priorityOrder: 3, createdAt: "", updatedAt: "" },
  { id: "SR-04", accountId: "SYSTEM", name: "Quarantine high-spam signals", condition: JSON.stringify(in_("system:spam:high")), actions: [{ type: "quarantine_hidden" }], status: "enabled", priorityOrder: 4, createdAt: "", updatedAt: "" },
  { id: "SR-05", accountId: "SYSTEM", name: "Quarantine security alert emails", condition: JSON.stringify(in_("system:auth:security_alert")), actions: [{ type: "quarantine_hidden" }], status: "enabled", priorityOrder: 5, createdAt: "", updatedAt: "" },
  { id: "SR-06", accountId: "SYSTEM", name: "Quarantine medium spam", condition: JSON.stringify(in_("system:spam:medium")), actions: [{ type: "quarantine" }], status: "enabled", priorityOrder: 6, createdAt: "", updatedAt: "" },
  { id: "SR-07", accountId: "SYSTEM", name: "Suppress notification for notice emails", condition: JSON.stringify(in_("system:workflow:notice")), actions: [{ type: "suppress_notification" }], status: "enabled", priorityOrder: 7, createdAt: "", updatedAt: "" },
  { id: "SR-08", accountId: "SYSTEM", name: "Suppress notification for content emails", condition: JSON.stringify(in_("system:workflow:content")), actions: [{ type: "suppress_notification" }], status: "enabled", priorityOrder: 8, createdAt: "", updatedAt: "" },
  // --- Workflow-specific urgency (9–16) ----------------------------------------
  // conversation: high when reply is needed and tone is urgent/negative
  { id: "SR-09", accountId: "SYSTEM", name: "Conversation: high urgency when reply needed and urgent/negative", condition: JSON.stringify({ "and": [wf_("conversation"), { "==": [wfData_("requiresReply"), true] }, { "in": [wfData_("sentiment"), ["urgent", "negative"]] }] }), actions: [{ type: "set_urgency", value: "high" }], status: "enabled", priorityOrder: 9, createdAt: "", updatedAt: "" },
  { id: "SR-10", accountId: "SYSTEM", name: "Conversation: low urgency when user has never replied", condition: JSON.stringify({ "and": [wf_("conversation"), { "!": [in_("system:replied")] }] }), actions: [{ type: "set_urgency", value: "low" }], status: "enabled", priorityOrder: 10, createdAt: "", updatedAt: "" },
  { id: "SR-11", accountId: "SYSTEM", name: "CRM: normal urgency", condition: JSON.stringify({ "and": [wf_("crm")] }), actions: [{ type: "set_urgency", value: "normal" }], status: "enabled", priorityOrder: 11, createdAt: "", updatedAt: "" },
  // support: priority field drives urgency; urgent > priority-based > awaiting_response > lifecycle
  { id: "SR-12", accountId: "SYSTEM", name: "Support: critical urgency for urgent-priority tickets", condition: JSON.stringify({ "and": [wf_("support"), { "==": [wfData_("priority"), "urgent"] }] }), actions: [{ type: "set_urgency", value: "critical" }], status: "enabled", priorityOrder: 12, createdAt: "", updatedAt: "" },
  { id: "SR-13", accountId: "SYSTEM", name: "Support: high urgency for high-priority tickets", condition: JSON.stringify({ "and": [wf_("support"), { "==": [wfData_("priority"), "high"] }] }), actions: [{ type: "set_urgency", value: "high" }], status: "enabled", priorityOrder: 13, createdAt: "", updatedAt: "" },
  { id: "SR-14", accountId: "SYSTEM", name: "Support: high urgency when agent is awaiting response", condition: JSON.stringify({ "and": [wf_("support"), { "==": [wfData_("eventType"), "awaiting_response"] }] }), actions: [{ type: "set_urgency", value: "high" }], status: "enabled", priorityOrder: 14, createdAt: "", updatedAt: "" },
  { id: "SR-15", accountId: "SYSTEM", name: "Support: low urgency for low-priority tickets", condition: JSON.stringify({ "and": [wf_("support"), { "==": [wfData_("priority"), "low"] }, { "!": [in_("system:replied")] }] }), actions: [{ type: "set_urgency", value: "low" }], status: "enabled", priorityOrder: 15, createdAt: "", updatedAt: "" },
  // ticket_opened/resolved/closed are passive lifecycle events — low unless urgency field says otherwise (fired after priority rules so those win)
  { id: "SR-16", accountId: "SYSTEM", name: "Support: low urgency for passive lifecycle events", condition: JSON.stringify({ "and": [wf_("support"), { "in": [wfData_("eventType"), ["ticket_opened", "ticket_resolved", "ticket_closed"]] }, { "!": [in_("system:replied")] }] }), actions: [{ type: "set_urgency", value: "low" }], status: "enabled", priorityOrder: 16, createdAt: "", updatedAt: "" },
  { id: "SR-17", accountId: "SYSTEM", name: "Auto-reply to test emails (pong)", condition: JSON.stringify(in_("system:test")), actions: [{ type: "pong" }], status: "enabled", priorityOrder: 17, createdAt: "", updatedAt: "" },
  // --- Calendar forwarding (18) ----------------------------------------
  { id: "SR-18", accountId: "SYSTEM", name: "Forward calendar invite to user's real calendar", condition: JSON.stringify(in_("system:calendar")), actions: [{ type: "forwardCalendarInvite" }], status: "enabled", priorityOrder: 18, createdAt: "", updatedAt: "" },
];
