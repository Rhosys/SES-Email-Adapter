import type { Email } from "../email/email.js";
import type { Tab, TabFilter, TabSortOrder, TabDisplayConfig } from "../tabs/tabs.js";
import type { EmailCategory } from "../email/categories.js";

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PageParams {
  cursor?: string;
  limit?: number;   // Default 50, max 200
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
  total: number;
}

// ---------------------------------------------------------------------------
// Email endpoints
// ---------------------------------------------------------------------------

export interface ListEmailsParams extends PageParams {
  tabId?: string;
  category?: EmailCategory;
  isRead?: boolean;
  isArchived?: boolean;
  isStarred?: boolean;
  search?: string;
  after?: string;   // ISO datetime — emails received after this
  before?: string;
}

export type EmailListItem = Pick<
  Email,
  | "id"
  | "threadId"
  | "from"
  | "subject"
  | "summary"
  | "category"
  | "priority"
  | "receivedAt"
  | "isRead"
  | "isStarred"
  | "isArchived"
  | "attachments"
> & {
  /** Extracted structured fields for this email's category, omitting the category discriminant. */
  categoryPreview: Record<string, unknown>;
};

export interface UpdateEmailRequest {
  isRead?: boolean;
  isArchived?: boolean;
  isTrashed?: boolean;
  isStarred?: boolean;
  labels?: string[];
}

export interface BulkUpdateEmailsRequest {
  ids: string[];
  update: UpdateEmailRequest;
}

// ---------------------------------------------------------------------------
// Tab endpoints
// ---------------------------------------------------------------------------

export interface CreateTabRequest {
  name: string;
  category: EmailCategory;
  icon?: string;
  color?: string;
  filters?: TabFilter[];
  sortOrder?: TabSortOrder;
  displayConfig?: Partial<TabDisplayConfig>;
  position?: number;
}

export interface UpdateTabRequest {
  name?: string;
  icon?: string;
  color?: string;
  filters?: TabFilter[];
  sortOrder?: TabSortOrder;
  displayConfig?: Partial<TabDisplayConfig>;
  position?: number;
}

export interface ReorderTabsRequest {
  /** Tab IDs in the desired order. */
  orderedIds: string[];
}

// ---------------------------------------------------------------------------
// Domain management
// ---------------------------------------------------------------------------

export interface EmailDomain {
  id: string;
  accountId: string;
  domain: string;
  verificationStatus: "pending" | "verified" | "failed";
  sesRuleSetName: string;
  createdAt: string;
}

export interface AddDomainRequest {
  domain: string;
}

export interface DomainVerificationRecord {
  type: "MX" | "TXT";
  name: string;
  value: string;
  ttl: number;
}

// ---------------------------------------------------------------------------
// Account / sharing
// ---------------------------------------------------------------------------

export interface AccountMember {
  userId: string;
  email: string;
  role: "owner" | "admin" | "member" | "readonly";
  addedAt: string;
}

export interface InviteMemberRequest {
  email: string;
  role: AccountMember["role"];
}

// ---------------------------------------------------------------------------
// Webhook / event notifications
// ---------------------------------------------------------------------------

export interface Webhook {
  id: string;
  accountId: string;
  url: string;
  events: WebhookEvent[];
  signingSecret: string;
  isActive: boolean;
  createdAt: string;
}

export type WebhookEvent =
  | "email.received"
  | "email.classified"
  | "email.spam_detected";

export interface CreateWebhookRequest {
  url: string;
  events: WebhookEvent[];
}

// ---------------------------------------------------------------------------
// Standard API response envelope
// ---------------------------------------------------------------------------

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
