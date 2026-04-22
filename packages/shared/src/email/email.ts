import type { CategoryData, EmailCategory } from "./categories.js";

/** Raw email as received from SES before processing. */
export interface RawEmail {
  messageId: string;
  timestamp: string;         // ISO datetime
  source: string;            // Envelope sender
  destination: string[];     // Envelope recipients
  s3Key: string;             // Location of full MIME in S3
}

/** An address with optional display name. */
export interface EmailAddress {
  address: string;
  name?: string;
}

/** A parsed, processed email stored in the database. */
export interface Email {
  id: string;                // UUID
  accountId: string;         // Authress account owner
  userId?: string;           // Shared-to user, if different from account owner
  messageId: string;         // SES message ID (dedup key)
  threadId: string;          // Groups emails in the same conversation

  // Core headers
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo?: EmailAddress;
  subject: string;
  receivedAt: string;        // ISO datetime
  sentAt?: string;           // Date header from sender

  // Content
  textBody?: string;
  htmlBody?: string;
  attachments: Attachment[];

  // AI-derived
  category: EmailCategory;
  categoryData: CategoryData;
  spamScore: number;         // 0-1, even for non-spam categories
  isValid: boolean;          // Passed spam/validation checks
  summary: string;           // One-sentence AI summary
  priority: "urgent" | "high" | "normal" | "low";

  // Delivery domain (which inbox received this)
  recipientDomain: string;
  recipientLocalPart: string;

  // State
  isRead: boolean;
  isArchived: boolean;
  isTrashed: boolean;
  isStarred: boolean;
  labels: string[];

  createdAt: string;
  updatedAt: string;
}

export interface Attachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  s3Key: string;
  contentId?: string;        // For inline attachments (CID references)
}

/** Validation result from the spam/validity pipeline. */
export interface ValidationResult {
  isValid: boolean;
  spamScore: number;
  failedChecks: ValidationCheck[];
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
  detail?: string;
}
