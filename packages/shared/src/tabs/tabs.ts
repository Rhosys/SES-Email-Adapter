import type { EmailCategory } from "../email/categories.js";

/**
 * A Tab is a user-configured view over their inbox.
 *
 * Each tab is typed to a category (e.g. "login", "invoice"), but users
 * can create multiple tabs of the same category with different filters —
 * e.g. three "login" tabs for GitHub, Google, and AWS respectively.
 *
 * The UI renders emails according to the tab's display config, which is
 * tailored to each category (e.g. invoices show amount/vendor/due-date;
 * logins show the OTP code prominently).
 */
export interface Tab {
  id: string;                    // UUID
  accountId: string;
  userId: string;

  name: string;                  // User-facing label, e.g. "GitHub Logins"
  category: EmailCategory;       // Determines UI layout and available fields
  icon?: string;                 // Emoji or icon identifier
  color?: string;                // Hex color for tab accent

  filters: TabFilter[];          // All filters ANDed together
  sortOrder: TabSortOrder;
  displayConfig: TabDisplayConfig;

  position: number;              // Ordering in the tab bar
  isDefault: boolean;            // Cannot be deleted, always present
  isShared: boolean;             // Visible to all account members

  createdAt: string;
  updatedAt: string;
}

/** A single filter condition. Multiple filters are ANDed together. */
export type TabFilter =
  | SenderFilter
  | DomainFilter
  | SubjectFilter
  | LabelFilter
  | CategoryDataFilter;

export interface SenderFilter {
  type: "sender";
  op: "equals" | "contains" | "starts_with" | "ends_with";
  value: string;
}

export interface DomainFilter {
  type: "domain";
  op: "equals" | "in";
  value: string | string[];
}

export interface SubjectFilter {
  type: "subject";
  op: "contains" | "matches_regex";
  value: string;
}

export interface LabelFilter {
  type: "label";
  value: string;
}

/**
 * Filter on extracted category data fields, e.g. only show invoices
 * from "vendor = Stripe" or jobs with status = "interview".
 */
export interface CategoryDataFilter {
  type: "category_data";
  field: string;   // Dot-path into CategoryData, e.g. "vendor", "jobType"
  op: "equals" | "contains" | "in" | "gt" | "lt";
  value: string | number | string[];
}

export type TabSortOrder =
  | { field: "receivedAt" | "sentAt" | "priority" | "spamScore"; direction: "asc" | "desc" }
  | { field: "category_data"; subField: string; direction: "asc" | "desc" };

/**
 * Per-category display configuration.
 *
 * The UI uses this to decide which fields to prominently show in the
 * email list row and email detail pane for this tab's category.
 */
export interface TabDisplayConfig {
  /** Fields to show as columns in the list view (ordered). */
  listColumns: DisplayColumn[];
  /** Fields to highlight in the detail pane header area. */
  detailHighlights: string[];
  /** Whether to show email body or just structured data in detail. */
  bodyDisplay: "full" | "collapsed" | "hidden";
  /** Group emails in list by this field (optional). */
  groupBy?: string;
}

export interface DisplayColumn {
  field: string;         // Dot-path into Email or CategoryData
  label: string;
  width?: "auto" | "sm" | "md" | "lg";
  format?: ColumnFormat;
}

export type ColumnFormat =
  | { type: "text" }
  | { type: "date"; relative?: boolean }
  | { type: "currency"; currency?: string }
  | { type: "badge"; colorMap?: Record<string, string> }
  | { type: "code" }  // Prominently styled for OTP codes
  | { type: "link" };

/** The default tab configurations applied to new accounts. */
export const DEFAULT_TAB_CONFIGS: Omit<Tab, "id" | "accountId" | "userId" | "createdAt" | "updatedAt">[] = [
  {
    name: "Inbox",
    category: "personal",
    icon: "📥",
    color: "#4F46E5",
    filters: [],
    sortOrder: { field: "receivedAt", direction: "desc" },
    displayConfig: {
      listColumns: [
        { field: "from.name", label: "From", width: "md" },
        { field: "subject", label: "Subject", width: "auto" },
        { field: "summary", label: "Preview", width: "auto" },
        { field: "receivedAt", label: "Date", width: "sm", format: { type: "date", relative: true } },
      ],
      detailHighlights: [],
      bodyDisplay: "full",
    },
    position: 0,
    isDefault: true,
    isShared: false,
  },
  {
    name: "Logins",
    category: "login",
    icon: "🔐",
    color: "#059669",
    filters: [],
    sortOrder: { field: "receivedAt", direction: "desc" },
    displayConfig: {
      listColumns: [
        { field: "categoryData.service", label: "Service", width: "md" },
        { field: "categoryData.loginType", label: "Type", width: "sm", format: { type: "badge" } },
        { field: "categoryData.code", label: "Code", width: "sm", format: { type: "code" } },
        { field: "receivedAt", label: "Received", width: "sm", format: { type: "date", relative: true } },
      ],
      detailHighlights: ["categoryData.code", "categoryData.expiresInMinutes", "categoryData.actionUrl"],
      bodyDisplay: "collapsed",
    },
    position: 1,
    isDefault: true,
    isShared: false,
  },
  {
    name: "Invoices",
    category: "invoice",
    icon: "🧾",
    color: "#D97706",
    filters: [],
    sortOrder: { field: "receivedAt", direction: "desc" },
    displayConfig: {
      listColumns: [
        { field: "categoryData.vendor", label: "Vendor", width: "md" },
        { field: "categoryData.amount", label: "Amount", width: "sm", format: { type: "currency" } },
        { field: "categoryData.invoiceNumber", label: "Invoice #", width: "sm" },
        { field: "categoryData.dueDate", label: "Due", width: "sm", format: { type: "date" } },
      ],
      detailHighlights: ["categoryData.amount", "categoryData.dueDate", "categoryData.downloadUrl"],
      bodyDisplay: "collapsed",
      groupBy: "categoryData.vendor",
    },
    position: 2,
    isDefault: true,
    isShared: false,
  },
  {
    name: "Jobs",
    category: "job",
    icon: "💼",
    color: "#7C3AED",
    filters: [],
    sortOrder: { field: "receivedAt", direction: "desc" },
    displayConfig: {
      listColumns: [
        { field: "categoryData.company", label: "Company", width: "md" },
        { field: "categoryData.role", label: "Role", width: "auto" },
        { field: "categoryData.applicationStatus", label: "Status", width: "sm", format: { type: "badge", colorMap: { submitted: "#6B7280", reviewing: "#3B82F6", interview: "#F59E0B", offer: "#10B981", rejected: "#EF4444" } } },
        { field: "receivedAt", label: "Date", width: "sm", format: { type: "date", relative: true } },
      ],
      detailHighlights: ["categoryData.applicationStatus", "categoryData.interviewDate", "categoryData.salary"],
      bodyDisplay: "full",
    },
    position: 3,
    isDefault: true,
    isShared: false,
  },
  {
    name: "Shopping",
    category: "shopping",
    icon: "📦",
    color: "#DC2626",
    filters: [],
    sortOrder: { field: "receivedAt", direction: "desc" },
    displayConfig: {
      listColumns: [
        { field: "categoryData.retailer", label: "Retailer", width: "md" },
        { field: "categoryData.shoppingType", label: "Type", width: "sm", format: { type: "badge" } },
        { field: "categoryData.trackingNumber", label: "Tracking", width: "md" },
        { field: "categoryData.estimatedDelivery", label: "Delivery", width: "sm", format: { type: "date" } },
      ],
      detailHighlights: ["categoryData.trackingUrl", "categoryData.estimatedDelivery", "categoryData.totalAmount"],
      bodyDisplay: "collapsed",
    },
    position: 4,
    isDefault: true,
    isShared: false,
  },
  {
    name: "Travel",
    category: "travel",
    icon: "✈️",
    color: "#0891B2",
    filters: [],
    sortOrder: { field: "category_data", subField: "departureDate", direction: "asc" },
    displayConfig: {
      listColumns: [
        { field: "categoryData.provider", label: "Provider", width: "md" },
        { field: "categoryData.travelType", label: "Type", width: "sm", format: { type: "badge" } },
        { field: "categoryData.destination", label: "Destination", width: "md" },
        { field: "categoryData.departureDate", label: "Departure", width: "sm", format: { type: "date" } },
      ],
      detailHighlights: ["categoryData.confirmationNumber", "categoryData.departureDate", "categoryData.totalAmount"],
      bodyDisplay: "collapsed",
    },
    position: 5,
    isDefault: true,
    isShared: false,
  },
];
