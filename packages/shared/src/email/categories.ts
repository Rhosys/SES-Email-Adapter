/**
 * First-class email category experiences.
 *
 * Each category maps to a distinct UI tab type with its own
 * structured data extraction schema and display layout.
 */
export const EMAIL_CATEGORIES = [
  "login",        // OTPs, password resets, verification codes, magic links
  "invoice",      // Invoices, receipts, billing statements, payment confirmations
  "job",          // Job postings, application status, recruiter outreach, interview scheduling
  "crm",          // Sales outreach, client communication, business proposals, follow-ups
  "newsletter",   // Subscriptions, marketing digests, product updates
  "notification", // System alerts, app notifications, service updates
  "travel",       // Flight/hotel bookings, itineraries, check-in reminders
  "shopping",     // Order confirmations, shipping updates, delivery notifications
  "financial",    // Bank statements, wire transfers, account alerts
  "social",       // Social media notifications, community activity
  "personal",     // Direct human-to-human communication
  "spam",         // Unsolicited, phishing, malicious
] as const;

export type EmailCategory = typeof EMAIL_CATEGORIES[number];

/** Structured data extracted for each category. Union discriminated by `category`. */
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
  code?: string;        // The actual OTP/code, if present
  expiresInMinutes?: number;
  service: string;      // e.g. "GitHub", "Google"
  actionUrl?: string;
}

export interface InvoiceData {
  category: "invoice";
  invoiceType: "invoice" | "receipt" | "statement" | "payment_confirmation";
  vendor: string;
  amount?: number;
  currency?: string;
  invoiceNumber?: string;
  dueDate?: string;     // ISO date string
  lineItems?: Array<{ description: string; amount: number }>;
  downloadUrl?: string;
}

export interface JobData {
  category: "job";
  jobType: "application_status" | "recruiter_outreach" | "interview_request" | "offer" | "rejection" | "job_posting";
  company?: string;
  role?: string;
  location?: string;
  salary?: string;
  interviewDate?: string; // ISO datetime
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
  departureDate?: string;   // ISO date
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
  estimatedDelivery?: string; // ISO date
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
  notificationType: "mention" | "follow" | "message" | "like" | "comment" | "friend_request" | "digest";
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
  confidence: number;   // 0-1
  indicators: string[]; // Human-readable reasons
}
