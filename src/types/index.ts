// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

export const CATEGORIES = [
  "login",
  "invoice",
  "job",
  "crm",
  "newsletter",
  "notification",
  "travel",
  "shopping",
  "financial",
  "social",
  "personal",
  "spam",
] as const;

export type Category = (typeof CATEGORIES)[number];

export type CategoryData =
  | LoginData
  | InvoiceData
  | JobData
  | CrmData
  | NewsletterData
  | NotificationData
  | TravelData
  | ShoppingData
  | FinancialData
  | SocialData
  | PersonalData
  | SpamData;

export interface LoginData {
  category: "login";
  loginType: "otp" | "password_reset" | "magic_link" | "verification" | "other";
  code?: string;
  expiresInMinutes?: number;
  service: string;
  actionUrl?: string;
}

export interface InvoiceData {
  category: "invoice";
  invoiceType: "invoice" | "receipt" | "statement" | "payment_confirmation";
  vendor: string;
  amount?: number;
  currency?: string;
  invoiceNumber?: string;
  dueDate?: string;
  lineItems?: Array<{ description: string; amount: number }>;
  downloadUrl?: string;
}

export interface JobData {
  category: "job";
  jobType:
    | "application_status"
    | "recruiter_outreach"
    | "interview_request"
    | "offer"
    | "rejection"
    | "job_posting";
  company?: string;
  role?: string;
  location?: string;
  salary?: string;
  interviewDate?: string;
  applicationStatus?: "submitted" | "reviewing" | "interview" | "offer" | "rejected";
  actionUrl?: string;
}

export interface CrmData {
  category: "crm";
  crmType: "sales_outreach" | "follow_up" | "client_message" | "proposal" | "contract" | "support";
  senderCompany?: string;
  senderRole?: string;
  dealValue?: number;
  currency?: string;
  urgency: "low" | "medium" | "high";
  requiresReply: boolean;
}

export interface NewsletterData {
  category: "newsletter";
  publication: string;
  topics: string[];
  frequency?: "daily" | "weekly" | "monthly" | "irregular";
  unsubscribeUrl?: string;
}

export interface NotificationData {
  category: "notification";
  notificationType: "alert" | "update" | "reminder" | "security" | "system";
  service: string;
  severity: "info" | "warning" | "critical";
  requiresAction: boolean;
  actionUrl?: string;
}

export interface TravelData {
  category: "travel";
  travelType: "flight" | "hotel" | "car_rental" | "train" | "cruise" | "activity" | "itinerary";
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

export interface ShoppingData {
  category: "shopping";
  shoppingType: "order_confirmation" | "shipping" | "delivery" | "return" | "refund";
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
  category: "financial";
  financialType: "statement" | "transaction" | "alert" | "transfer" | "tax";
  institution: string;
  amount?: number;
  currency?: string;
  accountLastFour?: string;
  transactionDate?: string;
  statementPeriod?: string;
}

export interface SocialData {
  category: "social";
  platform: string;
  notificationType:
    | "mention"
    | "follow"
    | "message"
    | "like"
    | "comment"
    | "friend_request"
    | "digest";
  actorName?: string;
  contentPreview?: string;
  actionUrl?: string;
}

export interface PersonalData {
  category: "personal";
  senderName?: string;
  isReply: boolean;
  threadLength?: number;
  sentiment: "positive" | "neutral" | "negative" | "urgent";
  requiresReply: boolean;
}

export interface SpamData {
  category: "spam";
  spamType: "phishing" | "malware" | "unsolicited_marketing" | "scam" | "other";
  confidence: number;
  indicators: string[];
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
  id: string;
  arcId: string;
  accountId: string;
  messageId: string;       // SES dedup key
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

  category: Category;
  categoryData: CategoryData;
  spamScore: number;
  summary: string;
  classificationModelId: string;

  s3Key: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Arc (materialized aggregate of related Signals)
// ---------------------------------------------------------------------------

export type ArcStatus = "active" | "archived" | "deleted";

export interface Arc {
  id: string;
  accountId: string;
  category: Category;
  labels: string[];
  status: ArcStatus;
  summary: string;
  lastSignalAt: string;
  lastUserConfirmedAt?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
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
  category?: Category;   // undefined = all categories
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

export type RuleActionType = "assign_label" | "assign_category" | "archive" | "delete";

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
