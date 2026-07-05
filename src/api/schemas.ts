import { z } from "@hono/zod-openapi";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const Workflow = z.enum([
  "auth", "conversation", "crm", "package", "travel", "payments", "alert",
  "content", "onboarding", "notice", "healthcare", "job", "support", "test",
]);

export const ThreadStatus = z.enum(["active", "archived", "deleted", "report_violation"]);
export const ThreadUrgency = z.enum(["critical", "high", "normal", "low", "silent"]);

export const SignalStatus = z.enum([
  "active", "block_hidden", "block_reject", "report_violation",
  "quarantine_visible", "quarantine_hidden", "draft", "pending_send", "sent",
]);

// Simplified from internal {email, user, ses_feedback, signal} — API exposes system | user only
export const SignalSource = z.enum(["system", "user"]);

export const SignalType = z.enum([
  "email", "deliverability", "invalid_rule_function", "invalid_template_function",
  "auto_send_blocked", "calendar_event", "calendar_response",
  "calendar_invite_invalid", "domain_misconfiguration",
]);

export const UnknownSenderPolicy = z.enum([
  "allow_all", "quarantine_visible", "quarantine_hidden",
  "block_hidden", "block_reject", "report_violation",
]);

export const SenderPolicy = z.enum(["allow", "block_hidden", "block_reject", "report_violation"]);

export const RuleActionType = z.enum([
  "assign_label", "assign_workflow", "archive", "forward",
  "block_hidden", "block_reject", "quarantine_visible", "quarantine_hidden",
  "set_urgency", "suppress_notification", "pong", "approve_sender",
  "auto_draft", "forwardCalendarInvite",
]);

export const RuleStatus = z.enum(["enabled", "disabled"]);
export const SortField = z.enum(["lastSignalAt", "createdAt"]);
export const SortDirection = z.enum(["asc", "desc"]);

export const RetentionDuration = z.enum([
  "P1M", "P2M", "P3M", "P5M", "P6M",
  "P1Y", "P2Y", "P5Y", "P10Y", "P100Y", "Infinity",
]);

export const ErrorCode = z.enum([
  "ACCOUNT_EXISTS",
  "ACCOUNT_NOT_FOUND",
  "ALIAS_EXISTS",
  "ALIAS_NOT_FOUND",
  "THREAD_NOT_FOUND",
  "DOMAIN_EXISTS",
  "DOMAIN_MISCONFIGURATION",
  "DOMAIN_NOT_FOUND",
  "DOMAIN_NOT_REGISTERED",
  "FORWARDING_ADDRESS_NOT_FOUND",
  "INVALID_CODE",
  "INVALID_CONDITION",
  "INVALID_EMAIL",
  "INVALID_RECIPIENT_DOMAIN",
  "INVALID_STATUS",
  "INVALID_STATUS_TRANSITION",
  "INVALID_TOKEN",
  "INVALID_WEBHOOK_CONFIG",
  "INVITE_CREATION_FAILED",
  "LABEL_NOT_FOUND",
  "MISSING_CODE",
  "NOT_CALENDAR_EVENT",
  "NO_ALIAS_ADDRESS",
  "PLAN_FEATURE_REQUIRED",
  "RSVP_SEND_FAILED",
  "RULE_NOT_FOUND",
  "SENDER_EXISTS",
  "SENDER_NOT_FOUND",
  "SYSTEM_RULE_IMMUTABLE",
  "SIGNAL_ALREADY_SENT",
  "SIGNAL_THREAD_MISMATCH",
  "SIGNAL_NOT_DRAFT",
  "SIGNAL_NOT_EDITABLE",
  "SIGNAL_NOT_FOUND",
  "SIGNAL_NOT_REVIEWABLE",
  "TEMPLATE_NOT_FOUND",
  "UNVERIFIED_FORWARD_TARGET",
  "UNVERIFIED_CALENDAR_TARGET",
  "TARGET_IN_USE",
  "VIEW_NOT_FOUND",
]);

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export const Pagination = z.object({
  cursor: z.string().nullable(),
}).openapi("Pagination");

export const ErrorResponse = z.object({
  title: z.string(),
  errorCode: ErrorCode.optional(),
  details: z.unknown().optional(),
  errorId: z.string().readonly(),
}).openapi("ErrorResponse");

export const EmailAddress = z.object({
  address: z.string(),
  name: z.string().optional(),
}).openapi("EmailAddress");

export const Attachment = z.object({
  attachmentId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  url: z.string().optional(),
}).openapi("Attachment");

export const MatchedRuleAction = z.object({
  type: RuleActionType,
  value: z.string().optional(),
}).openapi("MatchedRuleAction");

export const MatchedRuleResult = z.object({
  ruleId: z.string(),
  actions: z.array(MatchedRuleAction),
  labelsAdded: z.array(z.string()),
  statusChange: z.string().optional(),
  text: z.string().optional(),
}).openapi("MatchedRuleResult");

// ---------------------------------------------------------------------------
// WorkflowData sub-types (Signal.data.workflowData)
// ---------------------------------------------------------------------------

export const AuthData = z.object({
  workflow: z.literal("auth"),
  authType: z.enum(["otp", "password_reset", "magic_link", "verification", "two_factor", "security_alert", "other"]),
  code: z.string().optional(),
  expiresInMinutes: z.number().optional(),
  service: z.string(),
  actionUrl: z.string().optional(),
}).openapi("AuthData");

export const ConversationData = z.object({
  workflow: z.literal("conversation"),
  sentiment: z.enum(["positive", "neutral", "negative", "urgent"]),
  requiresReply: z.boolean(),
}).openapi("ConversationData");

export const CrmData = z.object({
  workflow: z.literal("crm"),
  senderCompany: z.string().optional(),
  senderRole: z.string().optional(),
}).openapi("CrmData");

export const PackageData = z.object({
  workflow: z.literal("package"),
  packageType: z.enum(["confirmation", "shipping", "out_for_delivery", "delivered", "return", "refund", "cancellation"]),
  retailer: z.string(),
  orderNumber: z.string().optional(),
  trackingNumber: z.string().optional(),
  trackingUrl: z.string().optional(),
  estimatedDelivery: z.string().optional(),
  items: z.array(z.object({ name: z.string(), quantity: z.number(), price: z.number().optional() })).optional(),
}).openapi("PackageData");

export const TravelData = z.object({
  workflow: z.literal("travel"),
  travelType: z.enum(["flight", "hotel", "car_rental", "train", "cruise", "activity", "itinerary", "check_in_reminder", "boarding_pass"]),
  provider: z.string(),
  confirmationNumber: z.string().optional(),
  departureDate: z.string().optional(),
  returnDate: z.string().optional(),
  origin: z.string().optional(),
  destination: z.string().optional(),
  passengers: z.array(z.object({ name: z.string() })).optional(),
  totalAmount: z.number().optional(),
  currency: z.string().optional(),
}).openapi("TravelData");

export const PaymentsData = z.object({
  workflow: z.literal("payments"),
  paymentType: z.enum(["invoice", "receipt", "subscription_renewal", "payment_failed", "plan_changed", "tax", "wire_transfer", "refund", "statement", "other"]),
  vendor: z.string(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  dueDate: z.string().optional(),
  invoiceNumber: z.string().optional(),
  accountLastFour: z.string().optional(),
  downloadUrl: z.string().optional(),
  managementUrl: z.string().optional(),
}).openapi("PaymentsData");

export const AlertData = z.object({
  workflow: z.literal("alert"),
  alertType: z.enum([
    "suspicious_login", "new_device", "password_changed", "breach_notice",
    "api_key_exposed", "account_locked", "fraud_alert",
    "ci_failure", "deployment_failed", "error_spike",
    "domain_expiry", "cert_expiry", "security_scan", "other",
  ]),
  service: z.string(),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  requiresAction: z.boolean(),
  actionUrl: z.string().optional(),
  ipAddress: z.string().optional(),
  location: z.string().optional(),
  deviceName: z.string().optional(),
  repository: z.string().optional(),
  errorMessage: z.string().optional(),
}).openapi("AlertData");

export const ContentData = z.object({
  workflow: z.literal("content"),
  contentType: z.enum(["newsletter", "promotion", "social_digest", "product_update", "announcement"]),
  publisher: z.string(),
  topics: z.array(z.string()).optional(),
  discountCode: z.string().optional(),
  discountAmount: z.string().optional(),
  expiryDate: z.string().optional(),
}).openapi("ContentData");

export const NoticeData = z.object({
  workflow: z.literal("notice"),
  noticeType: z.enum(["terms_update", "privacy_policy", "data_processor", "cookie_policy", "compliance", "service_notice", "government", "account_notification", "security_awareness", "other"]),
  provider: z.string(),
  effectiveDate: z.string().optional(),
  referenceNumber: z.string().optional(),
  documentUrl: z.string().optional(),
}).openapi("NoticeData");

export const HealthcareData = z.object({
  workflow: z.literal("healthcare"),
  eventType: z.enum(["appointment_reminder", "appointment_confirmation", "test_results", "prescription", "insurance_update", "billing", "referral"]),
  provider: z.string().optional(),
  appointmentDate: z.string().optional(),
  location: z.string().optional(),
  requiresAction: z.boolean(),
  portalUrl: z.string().optional(),
}).openapi("HealthcareData");

export const JobData = z.object({
  workflow: z.literal("job"),
  jobType: z.enum(["application_status", "recruiter_outreach", "interview_request", "offer", "rejection", "job_posting"]),
  company: z.string().optional(),
  role: z.string().optional(),
  location: z.string().optional(),
  salary: z.string().optional(),
  interviewDate: z.string().optional(),
  applicationStatus: z.enum(["submitted", "reviewing", "interview", "offer", "rejected"]).optional(),
  actionUrl: z.string().optional(),
}).openapi("JobData");

export const SupportData = z.object({
  workflow: z.literal("support"),
  eventType: z.enum(["ticket_opened", "ticket_updated", "ticket_resolved", "ticket_closed", "awaiting_response", "status_update"]),
  ticketId: z.string().optional(),
  service: z.string(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  agentName: z.string().optional(),
  responseUrl: z.string().optional(),
}).openapi("SupportData");

export const TestData = z.object({
  workflow: z.literal("test"),
  triggeredBy: z.enum(["user", "system"]),
}).openapi("TestData");

export const WorkflowData = z.discriminatedUnion("workflow", [
  AuthData, ConversationData, CrmData, PackageData, TravelData,
  PaymentsData, AlertData, ContentData, NoticeData,
  HealthcareData, JobData, SupportData, TestData,
]).openapi("WorkflowData");

// ---------------------------------------------------------------------------
// Signal data payloads
// ---------------------------------------------------------------------------

export const UnsubscribeInfo = z.object({
  type: z.enum(["server", "website", "mailto"]),
  url: z.string(),
}).openapi("UnsubscribeInfo");

export const InboundEmailSignalData = z.object({
  receivedAt: z.string(),
  summary: z.string(),
  urgency: ThreadUrgency.optional(),
  from: EmailAddress,
  to: z.array(EmailAddress),
  cc: z.array(EmailAddress),
  replyTo: EmailAddress.optional(),
  subject: z.string(),
  body: z.string().optional(),
  attachments: z.array(Attachment),
  headers: z.record(z.string(), z.string()),
  recipientAddress: z.string(),
  workflow: Workflow,
  workflowData: WorkflowData.optional(),
  matchedRules: z.array(MatchedRuleResult).optional(),
  unsubscribe: UnsubscribeInfo.optional(),
}).openapi("InboundEmailSignalData");

export const OutboundEmailSignalData = z.object({
  from: EmailAddress,
  to: z.array(EmailAddress),
  cc: z.array(EmailAddress),
  bcc: z.array(EmailAddress),
  replyTo: EmailAddress.optional(),
  subject: z.string(),
  body: z.string().optional(),
  attachments: z.array(Attachment),
  sentAt: z.string().optional().readonly(),
  sendInitiatedAt: z.string().readonly(),
  sendFailureReason: z.string().optional().readonly(),
}).openapi("OutboundEmailSignalData");

export const DeliverabilitySignalData = z.object({
  linkedSignalId: z.string(),
  bouncedRecipients: z.array(z.object({
    address: z.string(),
    bounceType: z.enum(["permanent", "transient"]),
    reason: z.string().optional(),
  })),
  subject: z.string(),
}).openapi("DeliverabilitySignalData");

export const InvalidRuleFunctionData = z.object({
  resourceName: z.string(),
  issue: z.string(),
}).openapi("InvalidRuleFunctionData");

export const InvalidTemplateFunctionData = z.object({
  resourceName: z.string(),
  functionName: z.string(),
  issue: z.string(),
}).openapi("InvalidTemplateFunctionData");

export const AutoSendBlockedData = z.object({
  recipientAddress: z.string(),
  reason: z.string().optional(),
}).openapi("AutoSendBlockedData");

export const CalendarAttendee = z.object({
  address: z.string(),
  name: z.string().optional(),
  rsvpStatus: z.string().optional(),
  optional: z.boolean().optional(),
}).openapi("CalendarAttendee");

export const CalendarEventData = z.object({
  title: z.string(),
  description: z.string().optional(),
  startTime: z.string(),
  endTime: z.string().optional(),
  location: z.string().optional(),
  url: z.string().optional(),
  organizer: z.string(),
  organizerName: z.string().optional(),
  attendees: z.array(CalendarAttendee),
  linkedSignalId: z.string(),
}).openapi("CalendarEventData");

export const CalendarResponseData = z.object({
  rsvpResponse: z.enum(["accepted", "declined", "tentative"]),
  respondedAt: z.string(),
  linkedSignalId: z.string(),
}).openapi("CalendarResponseData");

export const CalendarInviteInvalidData = z.object({
  reason: z.string(),
  linkedSignalId: z.string(),
}).openapi("CalendarInviteInvalidData");

export const DomainMisconfigurationData = z.object({
  reason: z.string(),
  linkedSignalId: z.string(),
  aliasAddress: z.string(),
  domain: z.string(),
}).openapi("DomainMisconfigurationData");

// ---------------------------------------------------------------------------
// Signal (base + typed variants)
// ---------------------------------------------------------------------------

const SignalBase = {
  signalId: z.string().readonly(),
  threadId: z.string().nullable().readonly(),
  source: SignalSource,
  status: SignalStatus,
  createdAt: z.string().readonly(),
};

export const EmailInboundSignal = z.object({
  ...SignalBase,
  type: z.literal("email"),
  data: InboundEmailSignalData,
}).openapi("EmailInboundSignal");

export const EmailOutboundSignal = z.object({
  ...SignalBase,
  type: z.literal("email"),
  data: OutboundEmailSignalData,
}).openapi("EmailOutboundSignal");

export const DeliverabilitySignal = z.object({
  ...SignalBase,
  type: z.literal("deliverability"),
  data: DeliverabilitySignalData,
}).openapi("DeliverabilitySignal");

export const InvalidRuleFunctionSignal = z.object({
  ...SignalBase,
  type: z.literal("invalid_rule_function"),
  data: InvalidRuleFunctionData,
}).openapi("InvalidRuleFunctionSignal");

export const InvalidTemplateFunctionSignal = z.object({
  ...SignalBase,
  type: z.literal("invalid_template_function"),
  data: InvalidTemplateFunctionData,
}).openapi("InvalidTemplateFunctionSignal");

export const AutoSendBlockedSignal = z.object({
  ...SignalBase,
  type: z.literal("auto_send_blocked"),
  data: AutoSendBlockedData,
}).openapi("AutoSendBlockedSignal");

export const CalendarEventSignal = z.object({
  ...SignalBase,
  type: z.literal("calendar_event"),
  data: CalendarEventData,
}).openapi("CalendarEventSignal");

export const CalendarResponseSignal = z.object({
  ...SignalBase,
  type: z.literal("calendar_response"),
  data: CalendarResponseData,
}).openapi("CalendarResponseSignal");

export const CalendarInviteInvalidSignal = z.object({
  ...SignalBase,
  type: z.literal("calendar_invite_invalid"),
  data: CalendarInviteInvalidData,
}).openapi("CalendarInviteInvalidSignal");

export const DomainMisconfigurationSignal = z.object({
  ...SignalBase,
  type: z.literal("domain_misconfiguration"),
  data: DomainMisconfigurationData,
}).openapi("DomainMisconfigurationSignal");

export const Signal = z.union([
  EmailInboundSignal,
  EmailOutboundSignal,
  DeliverabilitySignal,
  InvalidRuleFunctionSignal,
  InvalidTemplateFunctionSignal,
  AutoSendBlockedSignal,
  CalendarEventSignal,
  CalendarResponseSignal,
  CalendarInviteInvalidSignal,
  DomainMisconfigurationSignal,
]).openapi("Signal");

// Draft signal (source: user, status: draft) — simplified shape for compose
export const DraftSignal = z.object({
  ...SignalBase,
  type: z.literal("email"),
  data: OutboundEmailSignalData,
});

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

export const Thread = z.object({
  threadId: z.string().readonly(),
  workflow: Workflow,
  labels: z.array(z.string()),
  status: ThreadStatus,
  summary: z.string(),
  lastSignalAt: z.string().readonly(),
  deletedAt: z.string().optional().readonly(),
  createdAt: z.string().readonly(),
  updatedAt: z.string().readonly(),
  retentionDuration: RetentionDuration.optional().readonly(),
  urgency: ThreadUrgency.optional(),
  followupAt: z.string().datetime().optional().readonly(),
  senderAddress: z.string(),
  recipientAddress: z.string(),
  subject: z.string(),
}).openapi("Thread");

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export const DnsRecord = z.object({
  name: z.string(),
  type: z.enum(["CNAME", "MX", "TXT"]),
  value: z.string(),
  currentValue: z.string().optional(),
  status: z.enum(["verified", "failing", "pending"]),
}).openapi("DnsRecord");

export const Domain = z.object({
  domainId: z.string().readonly(),
  domain: z.string(),
  receivingSetupComplete: z.boolean(),
  senderSetupComplete: z.boolean(),
  createdAt: z.string().readonly(),
  updatedAt: z.string().readonly(),
}).openapi("Domain");

export const DomainWithRecords = Domain.extend({
  records: z.array(DnsRecord).readonly(),
}).openapi("DomainWithRecords");

// ---------------------------------------------------------------------------
// Alias
// ---------------------------------------------------------------------------

export const Alias = z.object({
  alias: z.string().readonly(),
  address: z.string(),
  unknownSenderPolicy: UnknownSenderPolicy,
  createdAt: z.string().readonly(),
  updatedAt: z.string().readonly(),
}).openapi("Alias");

// ---------------------------------------------------------------------------
// AliasSender
// ---------------------------------------------------------------------------

export const AliasSender = z.object({
  alias: z.string(),
  sender: z.string(),
  policy: SenderPolicy,
  createdAt: z.string().readonly(),
  updatedAt: z.string().readonly(),
}).openapi("AliasSender");

// ---------------------------------------------------------------------------
// Label
// ---------------------------------------------------------------------------

export const Label = z.object({
  label: z.string().readonly(),
  name: z.string(),
  color: z.string().optional(),
  icon: z.string().optional(),
  createdAt: z.string().readonly(),
}).openapi("Label");

// ---------------------------------------------------------------------------
// Rule
// ---------------------------------------------------------------------------

export const RuleAction = z.object({
  type: RuleActionType,
  value: z.string().optional(),
}).openapi("RuleAction");

export const Rule = z.object({
  ruleId: z.string().readonly(),
  name: z.string(),
  condition: z.string().optional(),
  conditionType: z.enum(["json_logic", "js"]).optional(),
  actions: z.array(RuleAction),
  status: RuleStatus,
  priorityOrder: z.number(),
  type: z.enum(["IMMUTABLE"]).optional(),
  createdAt: z.string().readonly(),
  updatedAt: z.string().readonly(),
}).openapi("Rule");

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export const View = z.object({
  viewId: z.string().readonly(),
  name: z.string(),
  icon: z.string().optional(),
  color: z.string().optional(),
  workflow: Workflow.optional(),
  labels: z.array(z.string()),
  sortField: SortField,
  sortDirection: SortDirection,
  position: z.number(),
  layout: z.array(z.unknown()).optional(),
  createdAt: z.string().readonly(),
  updatedAt: z.string().readonly(),
}).openapi("View");

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export const EmailNotificationSettings = z.object({
  enabled: z.boolean(),
  address: z.string(),
  frequency: z.enum(["instant", "hourly", "daily"]),
}).openapi("EmailNotificationSettings");

export const PushNotificationSettings = z.object({
  enabled: z.boolean(),
}).openapi("PushNotificationSettings");

export const NotificationSettings = z.object({
  email: EmailNotificationSettings.optional(),
  push: PushNotificationSettings.optional(),
}).openapi("NotificationSettings");

export const AccountFilteringConfig = z.object({
  defaultUnknownSenderPolicy: UnknownSenderPolicy
    .describe("Disposition applied to emails from senders not explicitly allowed, for any alias on this account that has no alias-level override. Defaults to \"quarantine_visible\" for accounts that have never explicitly set this value."),
}).openapi("AccountFilteringConfig");

export const AccountOnboarding = z.object({
  completed: z.boolean(),
  completedAt: z.string().optional(),
  testEmailReceived: z.boolean().optional(),
  testEmailReceivedAt: z.string().optional(),
}).openapi("AccountOnboarding");

export const Account = z.object({
  accountId: z.string().readonly(),
  name: z.string(),
  retentionDuration: RetentionDuration.optional(),
  digest: z.object({ frequency: z.enum(["daily", "weekly", "monthly"]), forwardingTargetId: z.string() }).nullable().optional(),
  filtering: AccountFilteringConfig,
  onboarding: AccountOnboarding.optional(),
  billingPlan: z.string().optional(),
  afterSendAction: z.enum(["archive", "keep_active"]).optional(),
  defaultCalendarInviteForwardingTargetId: z.string().optional(),
  createdAt: z.string().readonly(),
  updatedAt: z.string().readonly(),
}).openapi("Account");

// ---------------------------------------------------------------------------
// EmailTemplate
// ---------------------------------------------------------------------------

export const TemplateFunction = z.object({
  name: z.string(),
  code: z.string(),
  lastError: z.string().optional(),
}).openapi("TemplateFunction");

export const EmailTemplate = z.object({
  templateId: z.string().readonly(),
  name: z.string(),
  subject: z.string(),
  body: z.string(),
  functions: z.array(TemplateFunction).optional(),
  createdAt: z.string().readonly(),
  updatedAt: z.string().readonly(),
}).openapi("EmailTemplate");

// ---------------------------------------------------------------------------
// ForwardingTarget
// ---------------------------------------------------------------------------

export const ForwardingTarget = z.object({
  target: z.string(),
  type: z.enum(["email", "webhook"]),
  status: z.enum(["pending", "verified", "disabled"]),
  createdAt: z.string().readonly(),
  verifiedAt: z.string().optional().readonly(),
}).openapi("ForwardingTarget");

// ---------------------------------------------------------------------------
// Response wrappers
// ---------------------------------------------------------------------------

export const ListThreadsResponse = z.object({ threads: z.array(Thread), pagination: Pagination });
export const ListSignalsResponse = z.object({ signals: z.array(Signal), pagination: Pagination });
export const ListViewsResponse = z.object({ views: z.array(View) });
export const ListLabelsResponse = z.object({ labels: z.array(Label) });
export const ListRulesResponse = z.object({ rules: z.array(Rule) });
export const ListDomainsResponse = z.object({ domains: z.array(Domain) });
export const ListAliasesResponse = z.object({ aliases: z.array(Alias) });
export const ListSendersResponse = z.object({ senders: z.array(AliasSender) });
export const ListTemplatesResponse = z.object({ templates: z.array(EmailTemplate) });
export const ListForwardingTargetsResponse = z.object({ forwardingTargets: z.array(ForwardingTarget) });

export const SignalSendResponse = Signal.and(z.object({
  undoExpiresAt: z.string().readonly(),
}));

// ---------------------------------------------------------------------------
// User Configuration
// ---------------------------------------------------------------------------

export const UserConfiguration = z.object({
  postSendView: z.enum(["return_to_inbox", "stay_on_thread"]),
});

// ---------------------------------------------------------------------------
// TypeScript types (inferred from zod schemas — value + type share same name)
// ---------------------------------------------------------------------------

export type Workflow = z.infer<typeof Workflow>;
export type ThreadStatus = z.infer<typeof ThreadStatus>;
export type ThreadUrgency = z.infer<typeof ThreadUrgency>;
export type SignalStatus = z.infer<typeof SignalStatus>;
export type SignalSource = z.infer<typeof SignalSource>;
export type SignalType = z.infer<typeof SignalType>;
export type ErrorCode = z.infer<typeof ErrorCode>;
export type Pagination = z.infer<typeof Pagination>;
export type ErrorResponse = z.infer<typeof ErrorResponse>;
export type EmailAddress = z.infer<typeof EmailAddress>;
export type Attachment = z.infer<typeof Attachment>;
export type WorkflowData = z.infer<typeof WorkflowData>;
export type InboundEmailSignalData = z.infer<typeof InboundEmailSignalData>;
export type OutboundEmailSignalData = z.infer<typeof OutboundEmailSignalData>;
export type Thread = z.infer<typeof Thread>;
export type Signal = z.infer<typeof Signal>;
export type DraftSignal = z.infer<typeof DraftSignal>;
export type Domain = z.infer<typeof Domain>;
export type DomainWithRecords = z.infer<typeof DomainWithRecords>;
export type DnsRecord = z.infer<typeof DnsRecord>;
export type Alias = z.infer<typeof Alias>;
export type AliasSender = z.infer<typeof AliasSender>;
export type Label = z.infer<typeof Label>;
export type Rule = z.infer<typeof Rule>;
export type View = z.infer<typeof View>;
export type Account = z.infer<typeof Account>;
export type EmailTemplate = z.infer<typeof EmailTemplate>;
export type ForwardingTarget = z.infer<typeof ForwardingTarget>;
