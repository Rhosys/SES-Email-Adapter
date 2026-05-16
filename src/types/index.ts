// ---------------------------------------------------------------------------
// Workflows (the kind of email this is — drives display, UX, and actions)
// ---------------------------------------------------------------------------

export const WORKFLOWS = [
  "auth",          // OTPs, magic links, password resets, 2FA codes — copy/click, expires
  "conversation",  // Human-to-human back-and-forth — read and reply
  "crm",           // Sales outreach, proposals, client emails, follow-ups — reply or dismiss
  "package",       // Order confirmations, shipping, delivery tracking — track or file
  "travel",        // Flights, hotels, itineraries, boarding passes — date-triggered actions
  "scheduling",    // Calendar invites, appointment confirmations — accept or decline
  "payments",      // Invoices, receipts, subscriptions, tax, bank statements — pay or file
  "alert",         // Security events, fraud, CI failures, infra alerts — investigate now
  "content",       // Newsletters, promotions, social digests — read or unsubscribe
  "onboarding",    // Welcome emails, account creation, getting-started — new service signup
  "status",        // ToS updates, service notices, government notices — passive informational
  "healthcare",    // Appointments, test results, prescriptions, insurance
  "job",           // Applications, interviews, offers, rejections — career pipeline
  "support",       // Helpdesk tickets with threaded conversation and ticket ID
  "test",          // Emails sent by the account owner to their own domain — triggers pong
  // NOTE: spam is NOT a workflow. It is expressed via Signal.spamScore (0–1).
  // A phishing email pretending to be a bank login is workflow:"auth" + spamScore:0.95.
  // The processor blocks high-spamScore signals; the workflow captures what kind of
  // email it is (or is pretending to be), which is more actionable than just "spam".
] as const;

export type Workflow = (typeof WORKFLOWS)[number];

// ---------------------------------------------------------------------------
// SQS message types — discriminator for routing in the Lambda handler
// ---------------------------------------------------------------------------

export const SQS_MESSAGE_TYPES = ["reindex", "side_effect"] as const;
export type SqsMessageType = (typeof SQS_MESSAGE_TYPES)[number];

export type WorkflowData =
  | AuthData
  | ConversationData
  | CrmData
  | PackageData
  | TravelData
  | SchedulingData
  | PaymentsData
  | AlertData
  | ContentData
  | OnboardingData
  | StatusData
  | HealthcareData
  | JobData
  | SupportData
  | TestData;

// ---------------------------------------------------------------------------
// Workflow data shapes
// ---------------------------------------------------------------------------

export interface AuthData {
  workflow: "auth";
  authType: "otp" | "password_reset" | "magic_link" | "verification" | "two_factor" | "other";
  code?: string;
  expiresInMinutes?: number;
  service: string;
  actionUrl?: string;
}

export interface ConversationData {
  workflow: "conversation";
  senderName?: string;
  isReply: boolean;
  threadLength?: number;
  sentiment: "positive" | "neutral" | "negative" | "urgent";
  requiresReply: boolean;
}

export interface CrmData {
  workflow: "crm";
  crmType: "sales_outreach" | "follow_up" | "client_message" | "proposal" | "contract" | "support";
  senderCompany?: string;
  senderRole?: string;
  dealValue?: number;
  currency?: string;
  urgency: "low" | "medium" | "high";
  requiresReply: boolean;
}

export interface PackageData {
  workflow: "package";
  packageType: "confirmation" | "shipping" | "out_for_delivery" | "delivered" | "return" | "refund" | "cancellation";
  retailer: string;
  orderNumber?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  estimatedDelivery?: string;
  items?: Array<{ name: string; quantity: number; price?: number }>;
  totalAmount?: number;
  currency?: string;
}

export interface TravelData {
  workflow: "travel";
  travelType: "flight" | "hotel" | "car_rental" | "train" | "cruise" | "activity" | "itinerary" | "check_in_reminder" | "boarding_pass";
  provider: string;
  confirmationNumber?: string;
  departureDate?: string;
  returnDate?: string;
  origin?: string;
  destination?: string;
  passengerName?: string;
  totalAmount?: number;
  currency?: string;
}

export interface SchedulingData {
  workflow: "scheduling";
  eventType: "meeting_invite" | "appointment" | "reminder" | "cancellation" | "reschedule" | "confirmation";
  title: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  organizer?: string;
  attendees?: string[];
  calendarUrl?: string;
  requiresResponse: boolean;
}

export interface PaymentsData {
  workflow: "payments";
  // money flows both ways: invoice = owed to someone, receipt = already paid, subscription = recurring
  paymentType: "invoice" | "receipt" | "subscription_renewal" | "payment_failed" | "plan_changed" | "tax" | "wire_transfer" | "refund" | "statement" | "other";
  vendor: string;
  amount?: number;
  currency?: string;
  dueDate?: string;
  invoiceNumber?: string;
  accountLastFour?: string;
  downloadUrl?: string;
  managementUrl?: string;
}

export interface AlertData {
  workflow: "alert";
  alertType:
    | "suspicious_login" | "new_device" | "password_changed" | "breach_notice"
    | "api_key_exposed" | "account_locked" | "fraud_alert"
    | "ci_failure" | "deployment_failed" | "error_spike"
    | "domain_expiry" | "cert_expiry" | "security_scan"
    | "other";
  service: string;
  severity?: "info" | "warning" | "critical";
  requiresAction: boolean;
  actionUrl?: string;
  ipAddress?: string;
  location?: string;
  deviceName?: string;
  repository?: string;
  errorMessage?: string;
}

export interface ContentData {
  workflow: "content";
  contentType: "newsletter" | "promotion" | "social_digest" | "product_update" | "announcement";
  publisher: string;
  topics?: string[];
  discountCode?: string;
  discountAmount?: string;
  expiryDate?: string;
  unsubscribeUrl?: string;
}

export interface OnboardingData {
  workflow: "onboarding";
  onboardingType: "welcome" | "verification" | "getting_started" | "trial_started" | "other";
  service: string;
  actionUrl?: string;
}

export interface StatusData {
  workflow: "status";
  statusType:
    | "terms_update" | "privacy_policy" | "data_processor" | "cookie_policy" | "compliance"
    | "service_notice" | "government" | "account_notification" | "other";
  provider: string;
  effectiveDate?: string;
  referenceNumber?: string;
  documentUrl?: string;
}

export interface HealthcareData {
  workflow: "healthcare";
  eventType: "appointment_reminder" | "appointment_confirmation" | "test_results" | "prescription" | "insurance_update" | "billing" | "referral";
  provider?: string;
  appointmentDate?: string;
  location?: string;
  requiresAction: boolean;
  portalUrl?: string;
}

export interface JobData {
  workflow: "job";
  jobType: "application_status" | "recruiter_outreach" | "interview_request" | "offer" | "rejection" | "job_posting";
  company?: string;
  role?: string;
  location?: string;
  salary?: string;
  interviewDate?: string;
  applicationStatus?: "submitted" | "reviewing" | "interview" | "offer" | "rejected";
  actionUrl?: string;
}

export interface SupportData {
  workflow: "support";
  eventType: "ticket_opened" | "ticket_updated" | "ticket_resolved" | "ticket_closed" | "awaiting_response" | "status_update";
  ticketId?: string;
  service: string;
  priority?: "low" | "normal" | "high" | "urgent";
  agentName?: string;
  responseUrl?: string;
}

export interface TestData {
  workflow: "test";
  // "user" = sent by an account user; "system" = generated by the platform (e.g. onboarding fallback)
  triggeredBy: "user" | "system";
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export type NewAddressHandling =
  | "auto_allow"           // First contact always allowed; sender eTLD+1 auto-approved (default)
  | "block_until_approved"; // New addresses blocked until user explicitly approves via POST /arcs

// Default disposition for emails from unknown senders, applied after rules run
export const UNKNOWN_SENDER_POLICIES = ["allow_all", "quarantine_visible", "quarantine_hidden", "block_hidden", "block_reject", "violate_report"] as const;
export type UnknownSenderPolicy = (typeof UNKNOWN_SENDER_POLICIES)[number];

// active = visible in inbox; quarantine_visible = surfaced in review queue; quarantine_hidden = stored but not shown in queue; block_hidden = accepted, silently discarded; block_reject = bounced; violate_report = bounced + reported; draft = user-authored, unsent
export const SIGNAL_STATUSES = ["active", "block_hidden", "block_reject", "violate_report", "quarantine_visible", "quarantine_hidden", "draft"] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

export const STATS_CATEGORIES = ["allowed", "blocked", "quarantined", "violationReport"] as const;
export type StatsCategory = (typeof STATS_CATEGORIES)[number];

// "email" = inbound SES email; "system" = processor-created (e.g. extracted calendar event); "user" = user-created
export const SIGNAL_SOURCES = ["email", "system", "user"] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

// interrupt = push notification popup; ambient = badge only; silent = no push
export const PUSH_PRIORITIES = ["interrupt", "ambient", "silent"] as const;
export type PushPriority = (typeof PUSH_PRIORITIES)[number];

export const ARC_URGENCIES = ["critical", "high", "normal", "low", "silent"] as const;
export type ArcUrgency = (typeof ARC_URGENCIES)[number];

// Per-recipient-address configuration (an "alias" is any address on a custom domain routed into the system)
export interface Alias {
  id: string;
  accountId: string;
  address: string;              // The recipient address, e.g. me@mydomain.com
  unknownSenderPolicy: UnknownSenderPolicy;
  // Spam score at which a signal is treated as spam (0–1). Overrides account default when set.
  spamScoreThreshold?: number;
  // eTLD+1 of the site this alias was created for (set by the extension on alias generation)
  createdForOrigin?: string;
  createdAt: string;
  updatedAt: string;
}

// Approved/blocked sender domain per alias — stored as individual DynamoDB items
export const SENDER_POLICIES = ["allow", "block_hidden", "block_reject", "violate_report"] as const;
export type SenderPolicy = (typeof SENDER_POLICIES)[number];

export interface AliasSender {
  accountId: string;
  aliasAddress: string;
  domain: string;   // eTLD+1
  policy: SenderPolicy;
  addedAt: string;
}

// Email template for auto_reply and auto_draft rule actions
export interface TemplateFunction {
  name: string;      // placeholder name used in subject/body as {{fn.name}}
  code: string;      // user-authored JS: (signal, arc) => string
  lastError?: string; // annotation written when execution fails
}

export interface EmailTemplate {
  id: string;
  accountId: string;
  name: string;
  subject: string;   // supports {{signal.subject}}, {{sender.name}}, {{sender.address}}, {{arc.workflow}}
  body: string;      // same interpolation; unrecognised tokens render as ""
  functions?: TemplateFunction[]; // user-authored JS functions for dynamic template values
  createdAt: string;
  updatedAt: string;
}

// Active API Gateway WebSocket connection for an account
export interface WsConnection {
  connectionId: string;
  accountId: string;
  connectedAt: string;
  ttl?: number;
}

// Account-level filtering defaults
export interface AccountFilteringConfig {
  defaultUnknownSenderPolicy: UnknownSenderPolicy;
  newAddressHandling: NewAddressHandling;
  // Spam score at which a signal is treated as spam (0–1). Default: 0.9.
  // Per-address config can override this. Controls both filter blocking and notification suppression.
  spamScoreThreshold?: number;
}

// Global sender reputation — aggregated across all accounts, keyed by eTLD+1
export interface GlobalSenderReputation {
  domain: string;             // eTLD+1
  verdict?: "allow" | "deny"; // explicit admin override
  verdictReason?: string;
  signalCount: number;        // total signals seen from this domain
  spamCount: number;          // signals classified as spam
  blockCount: number;         // times blocked by any account
  lastSeenAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Core email primitives
// ---------------------------------------------------------------------------

export interface EmailAddress {
  address: string;
  name?: string;
}

export interface Attachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  s3Key: string;
  contentId?: string;
}

// ---------------------------------------------------------------------------
// EmbedTextInput — input to the embed-text builder
// ---------------------------------------------------------------------------

export interface EmbedTextInput {
  accountId: string;
  from: string;
  replyTo?: string;
  returnPath?: string;
  recipientAddress: string;
  subject: string;
  rawTextBody: string;
}

// ---------------------------------------------------------------------------
// MatchedRuleResult — per-rule trace written to Signal.matchedRules
// ---------------------------------------------------------------------------

export interface MatchedRuleResult {
  ruleId: string;
  actions: Array<Pick<RuleAction, "type" | "value">>;
  labelsAdded: string[];
  statusChange?: "block_hidden" | "block_reject" | "violate_report" | "quarantine_visible" | "quarantine_hidden" | "archived" | "deleted";
}

// ---------------------------------------------------------------------------
// Signal (immutable inbound email event)
// ---------------------------------------------------------------------------

export type UserDisplayedRetention = '1 year' | '5 years' | 'forever';

export interface Signal {
  // Discriminated ID encoding origin: "SES#${sesMessageId}" | "SYS#${uuid}" | "USR#${uuid}"
  id: string;
  arcId?: string;        // Undefined while signal is blocked pending user action
  matchedRules?: MatchedRuleResult[];
  accountId: string;
  source: SignalSource;
  receivedAt: string;      // ISO datetime

  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo?: EmailAddress;
  subject: string;
  sentAt?: string;

  textBody?: string;
  htmlBody?: string;
  attachments: Attachment[];
  headers: Record<string, string>;

  // Envelope recipient — the address that actually received this email
  recipientAddress: string;

  workflow: Workflow;
  workflowData: WorkflowData;
  spamScore: number;
  summary: string;
  classificationModelId: string;

  s3Key: string;
  status: SignalStatus;
  urgency?: ArcUrgency;
  createdAt: string;
  ttl?: number;   // DynamoDB TTL (epoch seconds) — computed from retentionDuration at write time; absent = never expire

  // Embedding cache, keyed by Bedrock model ID
  // Absent on quarantined/blocked signals (no Aurora write happened).
  // Partially populated if individual Bedrock calls failed (logged at WARN level).
  embeddings?: Record<string, number[]>;

  // ISO 8601 retention duration — the ONLY retention field stored in DynamoDB.
  // Drives DynamoDB TTL (computed at write time) and S3 lifecycle tagging.
  // userDisplayedRetention is NEVER stored — derived at API response time via getUserDisplayedRetention().
  retentionDuration?: import("../processor/retention.js").RetentionDuration;
}

// ---------------------------------------------------------------------------
// Arc (materialized aggregate of related Signals)
// ---------------------------------------------------------------------------

export const ARC_STATUSES = ["active", "archived", "deleted"] as const;
export type ArcStatus = (typeof ARC_STATUSES)[number];

export interface Arc {
  id: string;
  accountId: string;
  groupingKey?: string;     // deterministic lookup key; absent = vector-matched arc
  workflow: Workflow;
  labels: string[];
  status: ArcStatus;
  summary: string;
  lastSignalAt: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
  ttl?: number;   // DynamoDB TTL (epoch seconds) — computed from retentionDuration at write time; absent = never expire
  // ISO 8601 retention duration — longest of any signal in the arc
  retentionDuration?: import("../processor/retention.js").RetentionDuration;
  // Message-IDs of emails the user sent on this arc
  sentMessageIds?: string[];
  urgency?: ArcUrgency;
}

// ---------------------------------------------------------------------------
// View (configured filter over Arcs — replaces Tab)
// ---------------------------------------------------------------------------

export const SORT_FIELDS = ["lastSignalAt", "createdAt"] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export interface View {
  id: string;
  accountId: string;
  name: string;
  icon?: string;
  color?: string;
  workflow?: Workflow;    // undefined = all workflows
  labels: string[];      // Arc must have ALL of these labels
  sortField: SortField;
  sortDirection: SortDirection;
  position: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Label (account-scoped tag)
// ---------------------------------------------------------------------------

export interface Label {
  id: string;
  accountId: string;
  name: string;
  color?: string;
  icon?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Rule (JSONLogic-based automation)
// ---------------------------------------------------------------------------

export const RULE_ACTION_TYPES = [
  "assign_label", "assign_workflow", "archive", "delete", "forward",
  "block_hidden", "block_reject", "quarantine", "quarantine_hidden",
  "set_urgency", "suppress_notification", "pong", "approve_sender",
  "auto_reply", "auto_draft",
] as const;
export type RuleActionType = (typeof RULE_ACTION_TYPES)[number];

// System-assigned labels. Return type of assignSystemLabels() — adding here requires explicit approval.
// The compile-time gate: assignSystemLabels() returns SystemLabel[], so any unlisted label is a type error.
export type SystemLabel =
  | "system:workflow:auth" | "system:workflow:conversation" | "system:workflow:crm"
  | "system:workflow:package" | "system:workflow:travel" | "system:workflow:scheduling"
  | "system:workflow:payments" | "system:workflow:alert" | "system:workflow:content"
  | "system:workflow:onboarding" | "system:workflow:status" | "system:workflow:healthcare"
  | "system:workflow:job" | "system:workflow:support" | "system:workflow:test"
  | "system:spam:high"
  | "system:spam:medium"
  | "system:sender:untrusted"
  | "system:replied"
  | "system:test";

export interface RuleAction {
  type: RuleActionType;
  value?: string;
  disabled?: boolean;  // auto-set when forward target bounces permanently
}

// ---------------------------------------------------------------------------
// Verified forwarding addresses
// ---------------------------------------------------------------------------

export interface VerifiedForwardingAddress {
  id: string;
  accountId: string;
  address: string;
  status: "pending" | "verified";
  token: string;       // verification token sent to the address
  createdAt: string;
  verifiedAt?: string;
}

export const RULE_STATUSES = ["enabled", "disabled"] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

export interface Rule {
  id: string;
  accountId: string;
  name: string;
  condition: string;     // JSONLogic expression as JSON string
  conditionType?: "json_logic" | "js";  // default: json_logic
  code?: string;         // JavaScript function body when conditionType is "js"
  actions: RuleAction[];
  status: RuleStatus;
  priorityOrder: number;
  tags?: Record<string, string>;
  lastError?: string;    // Error comment from last failed execution
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface EmailNotificationSettings {
  enabled: boolean;
  address: string;              // Address to send notifications to
  frequency: "instant" | "hourly" | "daily";
}

export interface PushNotificationSettings {
  enabled: boolean;
  // Device tokens registered separately via push registration endpoint
}

export interface NotificationSettings {
  email?: EmailNotificationSettings;
  push?: PushNotificationSettings;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export interface AccountOnboarding {
  completed: boolean;
  completedAt?: string;
}

export interface Account {
  id: string;
  name: string;
  deletionRetentionDays: number;
  notifications?: NotificationSettings;
  filtering?: AccountFilteringConfig;
  onboarding?: AccountOnboarding;
  billingPlan?: import("../embedding/retention-tier.js").BillingPlan;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export interface DnsRecord {
  name: string;
  type: "CNAME" | "MX" | "TXT";
  value: string;          // expected value to set in DNS
  currentValue?: string;  // resolved value at last health check (absent = not yet checked)
  status: "verified" | "failing" | "pending";
}

export interface Domain {
  id: string;
  accountId: string;
  domain: string;
  // Tier 1: MX record set up → can receive email
  receivingSetupComplete: boolean;
  // Tier 2: DKIM + SPF + DMARC set up → can reply and forward
  senderSetupComplete: boolean;
  // Health state populated by the weekly DNS check job
  receivingHealthy?: boolean;
  senderHealthy?: boolean;
  failingRecords?: string[];  // DNS record names that failed at last check
  lastCheckedAt?: string;
  lastHealthyAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PageParams {
  cursor?: string;
  limit?: number;
}

// Internal DB page type — API layer maps this to named collection envelopes
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

// Pagination sub-object used in all collection response envelopes
export interface Pagination {
  cursor: string | null;
}

// Error body returned by all API error responses (status code is in the HTTP header)
export interface ApiErrorBody {
  title: string;
  errorCode?: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Suppression list
// ---------------------------------------------------------------------------

export const SUPPRESSION_REASONS = ["hard_bounce", "soft_bounce", "complaint", "manual"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export interface SuppressedAddress {
  address: string;
  reason: SuppressionReason;
  suppressedAt: string;
  ttl?: number;
}

// ---------------------------------------------------------------------------
// SES feedback (bounce/complaint notifications from SNS)
// ---------------------------------------------------------------------------

export interface SesFeedback {
  notificationType: "Bounce" | "Complaint" | "Delivery";
  bounce?: {
    bounceType: "Permanent" | "Transient" | "Undetermined";
    bounceSubType: string;
    bouncedRecipients: Array<{ emailAddress: string; status?: string; action?: string }>;
    timestamp: string;
  };
  complaint?: {
    complainedRecipients: Array<{ emailAddress: string }>;
    complaintFeedbackType?: string;
    timestamp: string;
  };
  mail: { messageId: string; source: string; tags?: Record<string, string> };
}
