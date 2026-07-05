import type { Rule } from "../types/index.js";

// ---------------------------------------------------------------------------
// System rules — applied to every account; users can enable/disable individually
// ---------------------------------------------------------------------------

const in_ = (label: string) => ({ "in": [label, { "var": "thread.labels" }] });
const wf_ = (w: string) => ({ "==": [{ "var": "signal.workflow" }, w] });
const wfData_ = (field: string) => ({ "var": `signal.workflowData.${field}` });

export const SYSTEM_RULES: Rule[] = [
  // --- Sender / content gating (1–9) ----------------------------------------
  { id: "SR-01", accountId: "SYSTEM", name: "Auto-approve sender on matched conversation", condition: JSON.stringify({ "and": [wf_("conversation"), in_("system:sender:untrusted"), { "var": "isMatchedThread" }] }), actions: [{ type: "approve_sender" }], status: "enabled", priorityOrder: 100, createdAt: "", updatedAt: "" },
  { id: "SR-02", accountId: "SYSTEM", name: "Show onboarding emails with action URL in quarantine", condition: JSON.stringify({ "and": [wf_("onboarding"), { "!!": [wfData_("actionUrl")] }] }), actions: [{ type: "quarantine_visible" }], status: "enabled", priorityOrder: 150, createdAt: "", updatedAt: "" },
  { id: "SR-03", accountId: "SYSTEM", name: "Block onboarding emails", condition: JSON.stringify(wf_("onboarding")), actions: [{ type: "quarantine_hidden" }], status: "enabled", priorityOrder: 200, createdAt: "", updatedAt: "" },
  { id: "SR-04", accountId: "SYSTEM", name: "Block notice emails", condition: JSON.stringify(wf_("notice")), actions: [{ type: "block_hidden" }], status: "enabled", priorityOrder: 300, createdAt: "", updatedAt: "" },
  { id: "SR-05", accountId: "SYSTEM", name: "Quarantine spam-tagged signals", condition: JSON.stringify(in_("system:spam")), actions: [{ type: "quarantine_hidden" }], status: "enabled", priorityOrder: 400, createdAt: "", updatedAt: "" },
  { id: "SR-06", accountId: "SYSTEM", name: "Quarantine security alert emails", condition: JSON.stringify(in_("system:auth:security_alert")), actions: [{ type: "quarantine_hidden" }], status: "enabled", priorityOrder: 500, createdAt: "", updatedAt: "" },
  { id: "SR-08", accountId: "SYSTEM", name: "Suppress notification for notice emails", condition: JSON.stringify(wf_("notice")), actions: [{ type: "suppress_notification" }], status: "enabled", priorityOrder: 700, createdAt: "", updatedAt: "" },
  { id: "SR-09", accountId: "SYSTEM", name: "Suppress notification for content emails", condition: JSON.stringify(wf_("content")), actions: [{ type: "suppress_notification" }], status: "enabled", priorityOrder: 800, createdAt: "", updatedAt: "" },
  // --- Workflow-specific urgency (10–17) ----------------------------------------
  // conversation: high when reply is needed and tone is urgent/negative
  { id: "SR-10", accountId: "SYSTEM", name: "Conversation: high urgency when reply needed and urgent/negative", condition: JSON.stringify({ "and": [wf_("conversation"), { "==": [wfData_("requiresReply"), true] }, { "in": [wfData_("sentiment"), ["urgent", "negative"]] }] }), actions: [{ type: "set_urgency", value: "high" }], status: "enabled", priorityOrder: 900, createdAt: "", updatedAt: "" },
  { id: "SR-11", accountId: "SYSTEM", name: "Conversation: low urgency when user has never replied", condition: JSON.stringify({ "and": [wf_("conversation"), { "!": [in_("system:replied")] }] }), actions: [{ type: "set_urgency", value: "low" }], status: "enabled", priorityOrder: 1000, createdAt: "", updatedAt: "" },
  { id: "SR-12", accountId: "SYSTEM", name: "CRM: normal urgency", condition: JSON.stringify({ "and": [wf_("crm")] }), actions: [{ type: "set_urgency", value: "normal" }], status: "enabled", priorityOrder: 1100, createdAt: "", updatedAt: "" },
  // support: priority field drives urgency; urgent > priority-based > awaiting_response > lifecycle
  { id: "SR-13", accountId: "SYSTEM", name: "Support: critical urgency for urgent-priority tickets", condition: JSON.stringify({ "and": [wf_("support"), { "==": [wfData_("priority"), "urgent"] }] }), actions: [{ type: "set_urgency", value: "critical" }], status: "enabled", priorityOrder: 1200, createdAt: "", updatedAt: "" },
  { id: "SR-14", accountId: "SYSTEM", name: "Support: high urgency for high-priority tickets", condition: JSON.stringify({ "and": [wf_("support"), { "==": [wfData_("priority"), "high"] }] }), actions: [{ type: "set_urgency", value: "high" }], status: "enabled", priorityOrder: 1300, createdAt: "", updatedAt: "" },
  { id: "SR-15", accountId: "SYSTEM", name: "Support: high urgency when agent is awaiting response", condition: JSON.stringify({ "and": [wf_("support"), { "==": [wfData_("eventType"), "awaiting_response"] }] }), actions: [{ type: "set_urgency", value: "high" }], status: "enabled", priorityOrder: 1400, createdAt: "", updatedAt: "" },
  { id: "SR-16", accountId: "SYSTEM", name: "Support: low urgency for low-priority tickets", condition: JSON.stringify({ "and": [wf_("support"), { "==": [wfData_("priority"), "low"] }, { "!": [in_("system:replied")] }] }), actions: [{ type: "set_urgency", value: "low" }], status: "enabled", priorityOrder: 1500, createdAt: "", updatedAt: "" },
  // ticket_opened/resolved/closed are passive lifecycle events — low unless urgency field says otherwise (fired after priority rules so those win)
  { id: "SR-17", accountId: "SYSTEM", name: "Support: low urgency for passive lifecycle events", condition: JSON.stringify({ "and": [wf_("support"), { "in": [wfData_("eventType"), ["ticket_opened", "ticket_resolved", "ticket_closed"]] }, { "!": [in_("system:replied")] }] }), actions: [{ type: "set_urgency", value: "low" }], status: "enabled", priorityOrder: 1600, createdAt: "", updatedAt: "" },
  { id: "SR-18", accountId: "SYSTEM", name: "Auto-reply to test emails (pong)", condition: JSON.stringify(wf_("test")), actions: [{ type: "pong" }], status: "enabled", priorityOrder: 1700, createdAt: "", updatedAt: "" },
  // --- Calendar forwarding (19) ----------------------------------------
  { id: "SR-19", accountId: "SYSTEM", name: "Forward calendar invite to user's real calendar", condition: JSON.stringify(in_("system:calendar")), actions: [{ type: "forwardCalendarInvite" }], status: "enabled", priorityOrder: 1800, createdAt: "", updatedAt: "" },
];
