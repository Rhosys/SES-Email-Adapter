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
  statusType: "terms_update" | "privacy_policy" | "service_notice" | "government" | "account_notification" | "other";
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

// How strictly an email address filters incoming signals by sender
export type SenderFilterMode =
  | "strict"       // sender eTLD+1 must be approved AND spam score must be low
  | "sender_match" // sender eTLD+1 must be approved (spam score ignored)
  | "notify_new"   // allow approved senders, block + notify on new senders (default)
  | "allow_all";   // no filtering

// active = visible; quarantined = user notified + shown for review; blocked = silent; draft = user-authored, unsent
export type SignalStatus = "active" | "blocked" | "quarantined" | "draft";

// "email" = inbound SES email; "system" = processor-created (e.g. extracted calendar event); "user" = user-created
export type SignalSource = "email" | "system" | "user";

// interrupt = push notification popup; ambient = badge only; silent = no push
export type PushPriority = "interrupt" | "ambient" | "silent";

// Unified urgency level that drives all notification channels (push, digest, UI).
// Derived by priorityCalculator — do not set manually.
export type ArcUrgency = "critical" | "high" | "normal" | "low" | "silent";

// Per-recipient-address configuration (an "alias" is any address on a custom domain routed into the system)
export interface Alias {
  id: string;
  accountId: string;
  address: string;              // The recipient address, e.g. me@mydomain.com
  filterMode: SenderFilterMode;
  approvedSenders: string[];    // eTLD+1 domains (e.g. "amazon.com", "google.com")
  // Spam score at which a signal is treated as spam (0–1). Overrides account default when set.
  spamScoreThreshold?: number;
  // eTLD+1 of the site this alias was created for (set by the extension on alias generation)
  createdForOrigin?: string;
  createdAt: string;
  updatedAt: string;
}

// Account-level filtering defaults
export interface AccountFilteringConfig {
  defaultFilterMode: SenderFilterMode;
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
// Signal (immutable inbound email event)
// ---------------------------------------------------------------------------

export interface Signal {
  // Discriminated ID encoding origin: "SES#${sesMessageId}" | "SYS#${uuid}" | "USR#${uuid}"
  id: string;
  arcId?: string;        // Undefined while signal is blocked pending user action
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
  createdAt: string;
  ttl?: number;   // Unix seconds; absent = never expire
}

// ---------------------------------------------------------------------------
// Arc (materialized aggregate of related Signals)
// ---------------------------------------------------------------------------

export type ArcStatus = "active" | "archived" | "deleted";

export interface Arc {
  id: string;
  accountId: string;
  groupingKey?: string;     // deterministic lookup key; absent = vector-matched arc
  workflow: Workflow;
  labels: string[];
  status: ArcStatus;
  summary: string;
  lastSignalAt: string;
  lastUserConfirmedAt?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
  ttl?: number;   // Unix seconds; absent = never expire
  // Message-IDs of emails the user sent on this arc — checked by priorityCalculator to detect replies
  sentMessageIds?: string[];
  // Derived by priorityCalculator; drives push, email digest section, and UI prominence
  urgency?: ArcUrgency;
}

// ---------------------------------------------------------------------------
// View (configured filter over Arcs — replaces Tab)
// ---------------------------------------------------------------------------

export type SortField = "lastSignalAt" | "createdAt";
export type SortDirection = "asc" | "desc";

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

export type RuleActionType =
  | "assign_label"
  | "assign_workflow"
  | "archive"
  | "delete"
  | "forward"
  | "block"
  | "quarantine"
  | "set_urgency"
  | "suppress_notification"
  | "pong"
  | "approve_sender";

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
  | "system:urgency:critical" | "system:urgency:high" | "system:urgency:normal"
  | "system:urgency:low" | "system:urgency:silent"
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

export interface Rule {
  id: string;
  accountId: string;
  name: string;
  condition: string;     // JSONLogic expression as JSON string
  actions: RuleAction[];
  position: number;
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

export interface Account {
  id: string;
  name: string;
  deletionRetentionDays: number;
  notifications?: NotificationSettings;
  filtering?: AccountFilteringConfig;
  aliases?: Record<string, Alias>;  // keyed by address
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

export type SuppressionReason = "hard_bounce" | "soft_bounce" | "complaint" | "manual";

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
