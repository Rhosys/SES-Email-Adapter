// ---------------------------------------------------------------------------
// Workflows (the kind of email this is — drives display, UX, and views)
// ---------------------------------------------------------------------------

export const WORKFLOWS = [
  "auth",         // OTPs, magic links, password resets, 2FA codes
  "invoice",      // Invoices, receipts, billing statements, payment confirmations
  "order",        // Order confirmations, shipping, delivery, returns, refunds
  "financial",    // Bank statements, wire transfers, transaction alerts, tax documents
  "travel",       // Flights, hotels, car rentals, itineraries, boarding passes
  "job",          // Applications, recruiter outreach, interviews, offers, rejections
  "newsletter",   // Publications, content digests, blogs, editorial content
  "promotions",   // Discount codes, flash sales, abandoned cart, loyalty rewards
  "onboarding",   // Welcome, account setup, getting-started, feature tours
  "social",       // Social media notifications, mentions, community activity
  "crm",          // Sales outreach, proposals, client emails, follow-ups
  "personal",     // Human-to-human correspondence not from automated systems
  "security",     // Suspicious login, breach notices, new device alerts
  "scheduling",   // Calendar invites, appointment confirmations, cancellations
  "support",      // Customer support tickets, helpdesk, service status
  "developer",    // GitHub, CI/CD, error monitoring, domain/cert expiry
  "subscription", // SaaS plan changes, renewal reminders, trial expiry
  "healthcare",   // Appointments, test results, prescriptions, insurance
  "government",   // Tax, benefits, official notices, license renewal
  "notice",        // Privacy policy, ToS updates, data processor changes — auto-archived
  "spam",         // Phishing, scams, malware, unsolicited bulk email
] as const;

export type Workflow = (typeof WORKFLOWS)[number];

export type WorkflowData =
  | AuthData
  | InvoiceData
  | OrderData
  | FinancialData
  | TravelData
  | JobData
  | NewsletterData
  | PromotionsData
  | OnboardingData
  | SocialData
  | CrmData
  | PersonalData
  | SecurityData
  | SchedulingData
  | SupportData
  | DeveloperData
  | SubscriptionData
  | HealthcareData
  | GovernmentData
  | NoticeData
  | SpamData;

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

export interface InvoiceData {
  workflow: "invoice";
  invoiceType: "invoice" | "receipt" | "statement" | "payment_confirmation" | "refund";
  vendor: string;
  amount?: number;
  currency?: string;
  invoiceNumber?: string;
  dueDate?: string;
  lineItems?: Array<{ description: string; amount: number }>;
  downloadUrl?: string;
}

export interface OrderData {
  workflow: "order";
  orderType: "confirmation" | "shipping" | "out_for_delivery" | "delivered" | "return" | "refund" | "cancellation";
  retailer: string;
  orderNumber?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  estimatedDelivery?: string;
  items?: Array<{ name: string; quantity: number; price?: number }>;
  totalAmount?: number;
  currency?: string;
}

export interface FinancialData {
  workflow: "financial";
  financialType: "statement" | "transaction" | "alert" | "transfer" | "tax" | "fraud_alert";
  institution: string;
  amount?: number;
  currency?: string;
  accountLastFour?: string;
  transactionDate?: string;
  statementPeriod?: string;
  isSuspicious?: boolean;
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

export interface NewsletterData {
  workflow: "newsletter";
  publication: string;
  topics: string[];
  frequency?: "daily" | "weekly" | "monthly" | "irregular";
  unsubscribeUrl?: string;
}

export interface PromotionsData {
  workflow: "promotions";
  promotionType: "discount" | "sale" | "flash_sale" | "loyalty" | "referral" | "product_launch" | "abandoned_cart" | "win_back";
  brand: string;
  discountCode?: string;
  discountAmount?: string;
  expiryDate?: string;
  shopUrl?: string;
}

export interface OnboardingData {
  workflow: "onboarding";
  service: string;
  onboardingType: "welcome" | "setup_guide" | "feature_tour" | "tip" | "check_in" | "re_engagement";
  stepNumber?: number;
  totalSteps?: number;
  actionUrl?: string;
}

export interface SocialData {
  workflow: "social";
  platform: string;
  notificationType: "mention" | "follow" | "message" | "like" | "comment" | "friend_request" | "digest" | "event";
  actorName?: string;
  contentPreview?: string;
  actionUrl?: string;
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

export interface PersonalData {
  workflow: "personal";
  senderName?: string;
  isReply: boolean;
  threadLength?: number;
  sentiment: "positive" | "neutral" | "negative" | "urgent";
  requiresReply: boolean;
}

export interface SecurityData {
  workflow: "security";
  alertType: "suspicious_login" | "new_device" | "password_changed" | "breach_notice" | "api_key_exposed" | "account_locked" | "other";
  service: string;
  ipAddress?: string;
  location?: string;
  deviceName?: string;
  requiresAction: boolean;
  actionUrl?: string;
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

export interface SupportData {
  workflow: "support";
  eventType: "ticket_opened" | "ticket_updated" | "ticket_resolved" | "ticket_closed" | "awaiting_response" | "status_update";
  ticketId?: string;
  service: string;
  priority?: "low" | "normal" | "high" | "urgent";
  agentName?: string;
  responseUrl?: string;
}

export interface DeveloperData {
  workflow: "developer";
  platform: "github" | "gitlab" | "bitbucket" | "jira" | "sentry" | "datadog" | "pagerduty" | "vercel" | "aws" | "cloudflare" | "other";
  eventType: "pull_request" | "code_review" | "ci_failure" | "ci_success" | "deployment" | "error_alert" | "domain_expiry" | "cert_expiry" | "security_scan" | "other";
  repository?: string;
  severity?: "info" | "warning" | "critical";
  requiresAction: boolean;
  actionUrl?: string;
}

export interface SubscriptionData {
  workflow: "subscription";
  eventType: "renewal" | "trial_expiring" | "payment_failed" | "plan_changed" | "cancelled" | "reactivated" | "usage_alert";
  service: string;
  planName?: string;
  amount?: number;
  currency?: string;
  nextBillingDate?: string;
  trialEndsAt?: string;
  managementUrl?: string;
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

export interface GovernmentData {
  workflow: "government";
  agency?: string;
  documentType: "tax" | "benefits" | "license" | "permit" | "notice" | "fine" | "voting" | "healthcare" | "other";
  referenceNumber?: string;
  deadlineDate?: string;
  requiresResponse: boolean;
  portalUrl?: string;
}

export interface NoticeData {
  workflow: "notice";
  noticeType: "privacy_policy" | "terms_update" | "data_processor" | "cookie_policy" | "compliance" | "other";
  provider: string;
  effectiveDate?: string;
  documentUrl?: string;
}

export interface SpamData {
  workflow: "spam";
  spamType: "phishing" | "malware" | "unsolicited_marketing" | "scam" | "other";
  confidence: number;
  indicators: string[];
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

export type SignalStatus = "active" | "blocked";

// "email" = inbound SES email; "system" = processor-created (e.g. extracted calendar event); "user" = user-created
export type SignalSource = "email" | "system" | "user";
export type BlockReason = "new_sender" | "spam" | "sender_mismatch" | "reputation" | "onboarding";

// interrupt = push notification popup; ambient = badge only; silent = no push
export type PushPriority = "interrupt" | "ambient" | "silent";

// Per-recipient-address configuration
export interface EmailAddressConfig {
  id: string;
  accountId: string;
  address: string;              // The recipient address, e.g. me@mydomain.com
  filterMode: SenderFilterMode;
  approvedSenders: string[];    // eTLD+1 domains (e.g. "amazon.com", "google.com")
  // Per-address onboarding override; "inherit" defers to blockOnboardingEmails global setting
  onboardingEmailHandling?: "block" | "allow" | "inherit";
  createdAt: string;
  updatedAt: string;
}

// Account-level filtering defaults
export interface AccountFilteringConfig {
  defaultFilterMode: SenderFilterMode;
  newAddressHandling: NewAddressHandling;
  blockOnboardingEmails?: boolean;  // Block all onboarding emails by default
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
  pushPriority: PushPriority;

  s3Key: string;
  status: SignalStatus;
  blockReason?: BlockReason;
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

export type RuleActionType = "assign_label" | "assign_workflow" | "archive" | "delete";

export interface RuleAction {
  type: RuleActionType;
  value?: string;
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
  emailConfigs?: Record<string, EmailAddressConfig>;  // keyed by address
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Domain (ownership record — SES status fetched live)
// ---------------------------------------------------------------------------

export interface Domain {
  id: string;
  accountId: string;
  domain: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PageParams {
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
  total: number;
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
  mail: { messageId: string; source: string };
}
