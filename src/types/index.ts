// ---------------------------------------------------------------------------
// Workflows (the kind of email this is — drives display, UX, and actions)
// ---------------------------------------------------------------------------

export const WORKFLOWS = [
  "auth",          // OTPs, magic links, password resets, 2FA codes — copy/click, expires
  "conversation",  // Human-to-human back-and-forth — read and reply
  "crm",           // Sales outreach, proposals, client emails, follow-ups — reply or dismiss
  "package",       // Order confirmations, shipping, delivery tracking — track or file
  "travel",        // Flights, hotels, itineraries, boarding passes — date-triggered actions
  "payments",      // Invoices, receipts, subscriptions, tax, bank statements — pay or file
  "alert",         // Security events, fraud, CI failures, infra alerts — investigate now
  "content",       // Newsletters, promotions, social digests — read or unsubscribe
  "onboarding",    // Welcome emails, account creation, getting-started — new service signup
  "notice",        // ToS updates, service notices, government notices, security awareness — passive informational
  "healthcare",    // Appointments, test results, prescriptions, insurance
  "job",           // Applications, interviews, offers, rejections — career pipeline
  "support",       // Helpdesk tickets with threaded conversation and ticket ID
  "events",        // Ticketed events: concerts, conferences, sports, theatre — venue + date + seats
  "healthcheck",   // System-generated pipeline validation emails — daily automated checks
  "test",          // Emails sent by the account owner to their own domain — triggers pong
  "unspecified",   // Classification failed or was skipped — email is unclassified
  // NOTE: spam is NOT a workflow. It is expressed via Signal.data.tags (e.g. ["phishing", "credential-harvest"]).
  // A phishing email pretending to be a bank login is workflow:"auth" + tags:["phishing","credential-harvest"].
  // The processor quarantines tagged signals; the workflow captures what kind of
  // email it is (or is pretending to be), which is more actionable than just "spam".
] as const;

export type Workflow = (typeof WORKFLOWS)[number];

// ---------------------------------------------------------------------------
// SQS message types — discriminator for routing in the Lambda handler
// ---------------------------------------------------------------------------

export const SQS_MESSAGE_TYPES = ["reindex", "side_effect", "draft_send", "signal_followup", "rsvp_reminder", "digest_dispatch", "digest_send", "emx_inbound", "emx_dispatch"] as const;
export type SqsMessageType = (typeof SQS_MESSAGE_TYPES)[number];

export type WorkflowData =
  | AuthData
  | ConversationData
  | CrmData
  | PackageData
  | TravelData
  | PaymentsData
  | AlertData
  | ContentData
  | NoticeData
  | HealthcareData
  | JobData
  | SupportData
  | EventsData
  | HealthcheckData
  | TestData
  | UnspecifiedData;

// ---------------------------------------------------------------------------
// Workflow data shapes
// ---------------------------------------------------------------------------

export interface AuthData {
  workflow: "auth";
  authType: "verification" | "password_reset" | "two_factor" | "security_alert" | "other";
  code?: string;
  actionUrl?: string;
  expiresInMinutes?: number;
  service: string;
}

export interface ConversationData {
  workflow: "conversation";
  sentiment: "positive" | "neutral" | "negative" | "urgent";
  requiresReply: boolean;
}

export interface CrmData {
  workflow: "crm";
  senderCompany?: string;
  senderRole?: string;
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
  passengers?: Array<{ name: string }>;
  totalAmount?: number;
  currency?: string;
  flightNumber?: string;
  seatNumber?: string;
  boardingTime?: string;
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
  paymentUrl?: string;
}

export interface AlertData {
  workflow: "alert";
  alertType: string;
  service: string;
  severity?: "info" | "warning" | "critical";
  requiresAction: boolean;
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
}

export interface OnboardingData {
  workflow: "onboarding";
  onboardingType: "welcome" | "verification" | "getting_started" | "trial_started" | "other";
  service: string;
}

export interface NoticeData {
  workflow: "notice";
  noticeType:
    | "terms_update" | "privacy_policy" | "data_processor" | "cookie_policy" | "compliance"
    | "service_notice" | "government" | "account_notification" | "security_awareness" | "other";
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
  patientName?: string;
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
  contactName?: string;
  contactEmail?: string;
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

export interface EventsData {
  workflow: "events";
  eventType: "ticket_confirmation" | "reminder" | "update" | "cancellation" | "venue_change";
  eventName: string;
  venueName?: string;
  venueAddress?: string;
  eventStartDatetime?: string;
  eventEndDatetime?: string;
  performer?: string;
  ticketReference?: string;
  seatDetails?: string;
  ticketCount?: number;
  ticketUrl?: string;
  totalAmount?: number;
  currency?: string;
}

export interface HealthcheckData {
  workflow: "healthcheck";
}

export interface TestData {
  workflow: "test";
  // "user" = sent by an account user; "system" = generated by the platform (e.g. onboarding fallback)
  triggeredBy: "user" | "system";
}

export interface UnspecifiedData {
  workflow: "unspecified";
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

// Default disposition for emails from unknown senders, applied after rules run
export const UNKNOWN_SENDER_POLICIES = ["allow_all", "quarantine_visible", "quarantine_hidden", "block_hidden", "block_reject", "report_violation"] as const;
export type UnknownSenderPolicy = (typeof UNKNOWN_SENDER_POLICIES)[number];

// The policy applied when an account has never explicitly configured AccountFilteringConfig.defaultUnknownSenderPolicy.
// Every place that resolves this "unset" case (processor disposition, alias auto-creation, the API response) must
// agree on this value — divergence here lets a brand-new alias's first email bypass the account's intended default.
export const DEFAULT_UNKNOWN_SENDER_POLICY: UnknownSenderPolicy = "quarantine_visible";

// active = visible in inbox; quarantine_visible = surfaced in review queue; quarantine_hidden = stored but not shown in queue; block_hidden = accepted, silently discarded; block_reject = bounced; report_violation = bounced + reported; draft = user-authored, unsent; pending_send = send initiated, within undo window; sent = delivered via SES
export const SIGNAL_STATUSES = ["active", "block_hidden", "block_reject", "report_violation", "quarantine_visible", "quarantine_hidden", "draft", "pending_send", "sent"] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

export const STATS_CATEGORIES = ["allowed", "blocked", "quarantined", "reported"] as const;
export type StatsCategory = (typeof STATS_CATEGORIES)[number];

// "email" = inbound SES email; "user" = user-created; "ses_feedback" = bounce/delivery notification
export const SIGNAL_SOURCES = ["email", "user", "ses_feedback", "signal"] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export const SIGNAL_TYPES = ["email", "deliverability", "invalid_rule_function", "invalid_template_function", "auto_send_blocked", "calendar_event", "calendar_response", "calendar_invite_invalid", "domain_misconfiguration"] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

// interrupt = push notification popup; ambient = badge only; silent = no push
export const PUSH_PRIORITIES = ["interrupt", "ambient", "silent"] as const;
export type PushPriority = (typeof PUSH_PRIORITIES)[number];

export const THREAD_URGENCIES = ["critical", "high", "normal", "low", "silent"] as const;
export type ThreadUrgency = (typeof THREAD_URGENCIES)[number];



// ---------------------------------------------------------------------------
// Key types for DynamoDB hierarchical schema
// ---------------------------------------------------------------------------

/** Identifies an alias within the ALIAS#{domain}#{aliasAddress} hierarchy */
export interface AliasKey {
  domain: string;      // Full domain, e.g. "acme.com"
  aliasName: string;   // Local part before @, e.g. "me"
}

/** Identifies a sender entry within the SENDER#{domain}#{aliasAddress}#{senderDomain} hierarchy */
export interface SenderKey extends AliasKey {
  senderDomain: string; // eTLD+1 of sender, e.g. "github.com"
}

/** Compute full email address from alias key */
export function aliasAddress(key: AliasKey): string {
  return `${key.aliasName}@${key.domain}`;
}

/** Parse a full email address into an AliasKey */
export function parseAliasAddress(address: string): AliasKey {
  const atIdx = address.lastIndexOf("@");
  if (atIdx < 1) throw new Error(`Invalid email address: ${address}`);
  return { aliasName: address.slice(0, atIdx), domain: address.slice(atIdx + 1) };
}

// Per-recipient-address configuration (an "alias" is any address on a custom domain routed into the system)
export interface Alias {
  id: string;
  accountId: string;
  aliasAddress: string;         // The full recipient address, e.g. me@mydomain.com
  domain: string;               // Full domain, e.g. "acme.com"
  aliasName: string;            // Local part before @, e.g. "me"
  unknownSenderPolicy: UnknownSenderPolicy;
  // eTLD+1 of the site this alias was created for (set by the extension on alias generation)
  createdForOrigin?: string;
  // Set when this alias is backed by an external mailbox (Gmail/Outlook/IMAP/JMAP). Outbound
  // mail from this address must be sent through that provider, not SES — SES is not an
  // authorized sender for e.g. gmail.com, so a SES send would fail DMARC at the recipient.
  emxId?: string;
  createdAt: string;
  updatedAt: string;
}

// Approved/blocked sender domain per alias — stored as individual DynamoDB items
export const SENDER_POLICIES = ["allow", "block_hidden", "block_reject", "report_violation"] as const;
export type SenderPolicy = (typeof SENDER_POLICIES)[number];

export interface AliasSender {
  accountId: string;
  aliasAddress: string;   // Full alias email address (e.g. "me@acme.com")
  domain: string;         // Alias's domain (e.g. "acme.com")
  aliasName: string;      // Alias's local part (e.g. "me")
  senderDomain: string;   // eTLD+1 of sender (e.g. "github.com")
  policy: SenderPolicy;
  addedAt: string;
}

// Email template for auto_draft rule actions
export interface TemplateFunction {
  name: string;      // placeholder name used in subject/body as {{fn.name}}
  code: string;      // user-authored JS: (signal, thread) => string
  lastError?: string; // annotation written when execution fails
}

export interface EmailTemplate {
  id: string;
  accountId: string;
  name: string;
  subject: string;   // supports {{signal.subject}}, {{sender.name}}, {{sender.address}}, {{thread.workflow}}
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
}

// ---------------------------------------------------------------------------
// MatchedRuleResult — per-rule trace written to Signal.matchedRules
// ---------------------------------------------------------------------------

export interface MatchedRuleResult {
  ruleId: string;
  actions: Array<Pick<RuleAction, "type" | "value">>;
  labelsAdded: string[];
  statusChange?: "block_hidden" | "block_reject" | "report_violation" | "quarantine_visible" | "quarantine_hidden" | "archived" | "deleted";
  /** Human-readable explanation — used for synthetic rules (e.g. SR-00) where no DB rule record exists. */
  text?: string;
}

// ---------------------------------------------------------------------------
// Signal data payload interfaces
// ---------------------------------------------------------------------------

export interface SignalAction {
  url: string;
  text: string | null;
}

export type UnsubscribeMethod = "server" | "website" | "mailto";

export interface UnsubscribeInfo {
  type: UnsubscribeMethod;
  url: string;
}

// ---------------------------------------------------------------------------
// Shared fields across inbound and outbound email signals
// ---------------------------------------------------------------------------
interface EmailSignalDataBase {
  receivedAt: string;      // ISO datetime
  summary: string;
  urgency?: ThreadUrgency;
  actions: SignalAction[];
  // Embedding cache, keyed by Bedrock model ID
  // Absent on quarantined/blocked signals (no Aurora write happened).
  // Partially populated if individual Bedrock calls failed (logged at WARN level).
  embeddings?: Record<string, number[]>;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo?: EmailAddress;
  subject: string;
  sentAt?: string;
  attachments: Attachment[];
  headers: Record<string, string>;
  // Envelope recipient — the address that actually received this email
  recipientAddress: string;
  workflow: Workflow;
  workflowData: WorkflowData;
  tags: string[];
  s3Key: string;
  matchedRules?: MatchedRuleResult[];
  // Thread the processor resolved (via full grouping-key / in-reply-to / similarity matching)
  // at receive time. Recorded on quarantined signals — whose thread association is otherwise
  // not persisted — so that approving one reattaches to that thread instead of spawning a
  // duplicate. Not stored in the signal's `threadId` field because a set threadId would move
  // the signal out of the QUARANTINED partition and hide it from the quarantine list.
  matchedThreadId?: string;
  // Unsubscribe info derived from List-Unsubscribe / List-Unsubscribe-Post headers
  unsubscribe?: UnsubscribeInfo;
}

// ---------------------------------------------------------------------------
// Inbound email signal (source: "email") — no textBody, htmlBody stored with truncation guard
// ---------------------------------------------------------------------------
export interface InboundEmailSignalData extends EmailSignalDataBase {
  htmlBody?: string;
  /** Set to true when htmlBody was truncated before storage. Full content recoverable from S3 via s3Key. */
  htmlBodyTruncated?: boolean;
}

// ---------------------------------------------------------------------------
// Outbound email signal (source: "user") — user-composed drafts and sent messages
// ---------------------------------------------------------------------------
export interface OutboundEmailSignalData extends EmailSignalDataBase {
  /** SES message ID assigned after successful delivery via SES. */
  sesMessageId?: string;
  textBody?: string;
  htmlBody?: string;
  sendInitiatedAt?: string;    // ISO 8601 — when POST /send was called
  sendFailureReason?: string;  // "all_recipients_bounced" | "ses_permanent_failure"
}

// Union — used where either inbound or outbound email signals are accepted
export type EmailSignalData = InboundEmailSignalData | OutboundEmailSignalData;

export interface DeliverabilitySignalData {
  linkedSignalId: string;
  bouncedRecipients: Array<{
    address: string;
    bounceType: "permanent" | "transient";
    reason?: string;
  }>;
  subject: string;
}

export interface InvalidRuleFunctionData {
  resourceName: string;
  issue: string;
}

export interface InvalidTemplateFunctionData {
  resourceName: string;
  functionName: string;
  issue: string;
}

export interface AutoSendBlockedData {
  recipientAddress: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Signal (immutable inbound event — generic over data payload)
// ---------------------------------------------------------------------------

export type UserDisplayedRetention = '1 year' | '5 years' | 'forever';

export interface SignalBase {
  // External-facing ID — always a `sgn-` prefixed ID (e.g. "sgn-mRk3oCMDhFXGF7CzHBt22Xabc")
  id: string;
  // Internal storage key used as the DynamoDB table PK suffix.
  // Inbound (SES) signals: "ses-{sesMessageId}" — enables O(1) dedup lookup.
  // User/system signals: same as `id` (the sgn- prefixed ID).
  signalLookupId: string;
  threadId?: string;        // Undefined while signal is blocked pending user action
  gsi3pk?: string;       // GSI3 key for In-Reply-To lookup (ACCT#{accountId}#MSGID#{msgId})
  accountId: string;
  source: SignalSource;
  type: SignalType;
  status: SignalStatus;
  labels: string[];      // Full resolved label set (system + classifier + rule-assigned)
  createdAt: string;
  ttl?: number;   // DynamoDB TTL (epoch seconds) — computed from retentionDuration at write time; absent = never expire
  // ISO 8601 retention duration — the ONLY retention field stored in DynamoDB.
  // Drives DynamoDB TTL (computed at write time) and S3 lifecycle tagging.
  // userDisplayedRetention is NEVER stored — derived at API response time via getUserDisplayedRetention().
  retentionDuration?: import("../processor/retention.js").RetentionDuration;
}

export type Signal<T = EmailSignalData> = SignalBase & { data: T };

export type AnySignal =
  | Signal<EmailSignalData>
  | Signal<DeliverabilitySignalData>
  | Signal<InvalidRuleFunctionData>
  | Signal<InvalidTemplateFunctionData>
  | Signal<AutoSendBlockedData>
  | Signal<import("./calendar.js").CalendarEventData>
  | Signal<import("./calendar.js").CalendarResponseData>
  | Signal<import("./calendar.js").CalendarInviteInvalidData>
  | Signal<import("./calendar.js").DomainMisconfigurationData>;

// Type guard functions for narrowing AnySignal by type field
export function isEmailSignal(signal: AnySignal): signal is Signal<EmailSignalData> {
  return signal.type === "email";
}

export function isDeliverabilitySignal(signal: AnySignal): signal is Signal<DeliverabilitySignalData> {
  return signal.type === "deliverability";
}

export function isInvalidRuleFunctionSignal(signal: AnySignal): signal is Signal<InvalidRuleFunctionData> {
  return signal.type === "invalid_rule_function";
}

export function isInvalidTemplateFunctionSignal(signal: AnySignal): signal is Signal<InvalidTemplateFunctionData> {
  return signal.type === "invalid_template_function";
}

export function isAutoSendBlockedSignal(signal: AnySignal): signal is Signal<AutoSendBlockedData> {
  return signal.type === "auto_send_blocked";
}

// ---------------------------------------------------------------------------
// Thread (materialized aggregate of related Signals)
// ---------------------------------------------------------------------------

export const THREAD_STATUSES = ["active", "archived", "deleted", "report_violation"] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];



export interface Thread {
  id: string;
  accountId: string;
  groupingKey?: string;     // deterministic lookup key; absent = vector-matched thread
  workflow: Workflow;
  labels: string[];
  status: ThreadStatus;
  summary: string;
  lastSignalAt: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
  ttl?: number;   // DynamoDB TTL (epoch seconds) — computed from retentionDuration at write time; absent = never expire
  // ISO 8601 retention duration — from the most recently received signal in the thread
  retentionDuration?: import("../processor/retention.js").RetentionDuration;
  // Message-IDs of emails the user sent on this thread
  sentMessageIds?: string[];
  urgency?: ThreadUrgency;
  // ISO 8601 datetime — when the user wants to be reminded about this thread
  followupAt?: string;
  // Denormalized from the latest inbound signal — used for thread list display
  sender: { address: string; name?: string | undefined };
  recipientAddress: string;
  subject: string;
}

// ---------------------------------------------------------------------------
// Resource (time-based aggregate — "something that resolves on a date",
// derived from signals across the workflows whose WorkflowData carries a
// forward-looking date field)
// ---------------------------------------------------------------------------

export const RESOURCE_STATUSES = ["active", "complete"] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

// The only workflows whose WorkflowData carries a forward-looking date field.
// The other WORKFLOWS values never produce a Resource.
export const RESOURCE_WORKFLOWS = ["package", "travel", "payments", "healthcare", "job", "events"] as const;
export type ResourceWorkflow = (typeof RESOURCE_WORKFLOWS)[number];

export const RESOURCE_ASSET_TYPES = ["qr_code", "barcode", "pkpass"] as const;
export type ResourceAssetType = (typeof RESOURCE_ASSET_TYPES)[number];

export interface ResourceAsset {
  type: ResourceAssetType;
  label: string;
  rawValue: string;
  sourceSignalId: string;
  s3Key?: string;
  extractedAt: string;
}

export interface Resource {
  accountId: string;
  threadId: string;
  workflow: Workflow;
  // Per-workflow natural identifier extracted from workflowData (e.g. package's
  // orderNumber) — distinguishes multiple resources of the same workflow on one
  // thread (e.g. an outbound flight vs. a return flight, both "travel").
  resourceKey: string;
  status: ResourceStatus;
  expectedResolutionDate: string;
  resolvedAt?: string;
  assets: ResourceAsset[];
  createdAt: string;
  updatedAt: string;
  ttl?: number;   // max(threadTtl, epoch(expectedResolutionDate) + 1 year)
}



// ---------------------------------------------------------------------------
// View (configured filter over Threads — replaces Tab)
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
  labels: string[];      // Thread must have ALL of these labels
  sortField: SortField;
  sortDirection: SortDirection;
  position: number;
  layout?: unknown[];    // LayoutNode[] — opaque JSON blob, validated by the frontend
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
  "assign_label", "assign_workflow", "archive", "forward",
  "block_hidden", "block_reject", "quarantine_visible", "quarantine_hidden",
  "set_urgency", "suppress_notification", "pong", "approve_sender",
  "auto_draft", "forwardCalendarInvite",
] as const;
export type RuleActionType = (typeof RULE_ACTION_TYPES)[number];

// System-assigned labels. Return type of assignSystemLabels() — adding here requires explicit approval.
// The compile-time gate: assignSystemLabels() returns SystemLabel[], so any unlisted label is a type error.
export type SystemLabel =
  | "system:sender:untrusted"
  | "system:replied"
  | "system:auth:security_alert"
  | "system:action"
  | "system:calendar";

export interface RuleAction {
  type: RuleActionType;
  value?: string;
}

// ---------------------------------------------------------------------------
// Forwarding targets
// ---------------------------------------------------------------------------

export const FORWARDING_TARGET_TYPES = ["email", "webhook"] as const;
export type ForwardingTargetType = (typeof FORWARDING_TARGET_TYPES)[number];

export const FORWARDING_TARGET_STATUSES = ["pending", "verified", "disabled"] as const;
export type ForwardingTargetStatus = (typeof FORWARDING_TARGET_STATUSES)[number];

export interface ForwardingTarget {
  id: string;
  accountId: string;
  target: string;
  type: ForwardingTargetType;
  status: ForwardingTargetStatus;
  token: string;       // verification token sent to the target
  createdAt: string;
  verifiedAt?: string;
}

// ---------------------------------------------------------------------------
// External Mail Exchange (EMX) — connected external provider accounts
// ---------------------------------------------------------------------------

export const EMX_PLATFORMS = ["gmail", "outlook", "imap", "jmap"] as const;
export type EmxPlatform = (typeof EMX_PLATFORMS)[number];

export const EMX_STATUSES = ["active", "activation_failed"] as const;
export type EmxStatus = (typeof EMX_STATUSES)[number];

export interface ExternalMailExchange {
  id: string;                      // emx_{base58-UUIDv7}{3 check chars}
  accountId: string;
  platform: EmxPlatform;
  emailAddress: string;            // the external mailbox being watched
  status: EmxStatus;
  syncCursor?: string;             // Gmail: historyId; Outlook: full deltaLink URL; IMAP: {uidvalidity}:{lastUid}
  expiresAt?: string;              // ISO datetime — when watch/subscription lapses
  lastSyncAt?: string;             // ISO datetime — last successful sync completion
  providerSubscriptionId?: string; // Graph subscription UUID or "watch" for Gmail
  // Authress userId of the user who linked this mailbox — the `userId` path parameter of
  // GET /v1/connections/{connectionId}/users/{userId}/credentials. This is NOT the
  // provider-side identity id: Authress returns no credentials for a third-party user id.
  // Accounts are multi-user, so the accountId cannot stand in for it (gmail/outlook only).
  connectionUserId?: string;
  encryptionCertificateId?: string; // which RSA key was used (for Outlook subscriptions)
  errorReason?: string;            // human-readable failure reason (only when activation_failed)
  imapConfig?: {
    host: string;
    tlsConfig: "TLS" | "DISABLED";
    username: string;
    encryptedPassword: string;     // base64(iv || authTag || ciphertext) from EncryptionManager
  };
  jmapConfig?: {
    sessionUrl: string;
    username: string;
    encryptedPassword: string;     // base64(iv || authTag || ciphertext) from EncryptionManager
    apiUrl: string;                // from Session object, refreshed on each sync
    downloadUrl: string;           // from Session object, template with {accountId}/{blobId}/{name}
    jmapAccountId: string;         // from primaryAccounts["urn:ietf:params:jmap:mail"]
    inboxId: string;               // from Mailbox/query role=inbox, discovered during activation
  };
  nextSyncTime?: string;           // ISO datetime — when dispatcher should next process (IMAP/JMAP)
  consecutiveFailures?: number;    // Track auth failures for 3-strike rule
  createdAt: string;
  updatedAt: string;
}

export const RULE_STATUSES = ["enabled", "disabled"] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

export interface Rule {
  id: string;
  accountId: string;
  name: string;
  condition: string;     // JSONLogic expression (json_logic) or JS function body (js)
  conditionType?: "json_logic" | "js";  // default: json_logic
  actions: RuleAction[];
  status: RuleStatus;
  priorityOrder: number;
  tags?: Record<string, string>;
  lastError?: string;    // Error comment from last failed execution
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export interface AccountOnboarding {
  completed: boolean;
  completedAt?: string;
  testEmailReceived?: boolean;
  testEmailReceivedAt?: string;
}

export interface Account {
  id: string;
  name: string;
  retentionDuration?: import("../processor/retention.js").RetentionDuration;
  digest?: { frequency: "daily" | "weekly" | "monthly"; forwardingTargetId: string } | null;
  filtering?: AccountFilteringConfig;
  onboarding?: AccountOnboarding;
  billingPlan?: import("../embedding/retention-tier.js").BillingPlan;
  defaultCalendarInviteForwardingTargetId?: string;
  gsi1pk?: string;
  gsi1sk?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// User Configuration (per-user, global — not account-scoped)
// ---------------------------------------------------------------------------

export const POST_SEND_VIEWS = ["return_to_inbox", "stay_on_thread"] as const;
export type PostSendView = (typeof POST_SEND_VIEWS)[number];

export interface IUserConfiguration {
  postSendView: PostSendView;
}

export const USER_CONFIGURATION_DEFAULTS: IUserConfiguration = {
  postSendView: "return_to_inbox",
};

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
  accountId: string;
  domain: string;
  // Absent or "active" == live; "deleted" == soft-deleted (hidden from reads, still
  // blocks other accounts from claiming it, and can be revived by the same account).
  status?: "active" | "deleted";
  // All 4 DNS records (MX, DKIM, SPF, DMARC) verified — domain can receive and send
  receivingSetupComplete: boolean;
  // DKIM + SPF + DMARC CNAMEs verified — domain can sign outbound mail
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
  bounceCount?: number;
  feedback?: unknown;
  linkedSignalId?: string;
  sesMessageId?: string;
}

// ---------------------------------------------------------------------------
// SES feedback (bounce/complaint notifications from SNS)
// ---------------------------------------------------------------------------

// Every event type SES can publish for a *sending* configuration set (matches AWS's
// "event publishing" vocabulary). Our terraform only wires up BOUNCE/COMPLAINT today
// (see aws_sesv2_configuration_set_event_destination.feedback), but the full list is
// enumerated here so an unrecognised type is always a genuine anomaly rather than
// something that quietly falls into the wrong code path.
export const SES_EVENT_TYPES = ["Bounce", "Complaint", "Delivery", "Send", "Reject", "Open", "Click", "RenderingFailure", "DeliveryDelay", "Subscription"] as const;
export type SesEventType = (typeof SES_EVENT_TYPES)[number];

export interface SesFeedback {
  // SESv2 configuration-set event publishing (what this deployment uses — see
  // aws_sesv2_configuration_set_event_destination) puts the discriminator in
  // `eventType`. The older identity-level notification format (SetIdentityNotificationTopic)
  // — and SES's own inbound-receiving notifications, which use "Received" — puts it in
  // `notificationType` instead. Accept either so a message is recognised regardless of
  // which SNS destination style produced it.
  eventType?: SesEventType;
  notificationType?: SesEventType;
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

export function resolveSesEventType(feedback: { eventType?: string; notificationType?: string }): string | undefined {
  return feedback.eventType ?? feedback.notificationType;
}

// ---------------------------------------------------------------------------
// Calendar signal types (re-exported from calendar.ts)
// ---------------------------------------------------------------------------

export type {
  CalendarEventData,
  CalendarAttendee,
  CalendarResponseData,
  CalendarInviteInvalidData,
  DomainMisconfigurationData,
} from "./calendar.js";

export {
  isCalendarEventSignal,
  isCalendarResponseSignal,
  isCalendarInviteInvalidSignal,
  isDomainMisconfigurationSignal,
} from "./calendar.js";
