import type { Workflow } from "../types/index.js";

export interface WorkflowFieldDefinition {
  name: string;
  type: string;
  required: boolean;
  enumValues?: string[];
  notes?: string;
}

export interface WorkflowDefinition {
  name: Workflow;
  description: string;
  fields: WorkflowFieldDefinition[];
}

export const WORKFLOW_REGISTRY: WorkflowDefinition[] = [
  {
    name: "auth",
    description: "OTPs, password resets, magic links, email verification, 2FA codes",
    fields: [
      { name: "authType", type: "enum", required: true, enumValues: ["otp", "password_reset", "magic_link", "verification", "two_factor", "security_alert", "other"] },
      { name: "code", type: "string", required: false },
      { name: "expiresInMinutes", type: "number", required: false },
      { name: "service", type: "string", required: true },
      { name: "actionUrl", type: "string", required: false },
    ],
  },
  {
    name: "conversation",
    description: "Human-to-human back-and-forth — read and reply",
    fields: [
      { name: "sentiment", type: "enum", required: true, enumValues: ["positive", "neutral", "negative", "urgent"] },
      { name: "requiresReply", type: "boolean", required: true },
    ],
  },
  {
    name: "crm",
    description: "Sales outreach, proposals, client emails, follow-ups",
    fields: [
      { name: "senderCompany", type: "string", required: false },
      { name: "senderRole", type: "string", required: false },
    ],
  },
  {
    name: "package",
    description: "Order confirmations, shipping, delivery tracking",
    fields: [
      { name: "packageType", type: "enum", required: true, enumValues: ["confirmation", "shipping", "out_for_delivery", "delivered", "return", "refund", "cancellation"] },
      { name: "retailer", type: "string", required: true },
      { name: "orderNumber", type: "string", required: false },
      { name: "trackingNumber", type: "string", required: false },
      { name: "trackingUrl", type: "string", required: false },
      { name: "estimatedDelivery", type: "string", required: false },
      { name: "items", type: "array", required: false, notes: "Array<{ name: string; quantity: number; price?: number }>" },
      { name: "totalAmount", type: "number", required: false },
      { name: "currency", type: "string", required: false },
    ],
  },
  {
    name: "travel",
    description: "Flights, hotels, itineraries, boarding passes — date-triggered actions",
    fields: [
      { name: "travelType", type: "enum", required: true, enumValues: ["flight", "hotel", "car_rental", "train", "cruise", "activity", "itinerary", "check_in_reminder", "boarding_pass"] },
      { name: "provider", type: "string", required: true },
      { name: "confirmationNumber", type: "string", required: false },
      { name: "departureDate", type: "string", required: false },
      { name: "returnDate", type: "string", required: false },
      { name: "origin", type: "string", required: false },
      { name: "destination", type: "string", required: false },
      { name: "passengers", type: "array", required: false, notes: "Array<{ name: string }>" },
      { name: "totalAmount", type: "number", required: false },
      { name: "currency", type: "string", required: false },
      { name: "flightNumber", type: "string", required: false },
      { name: "seatNumber", type: "string", required: false },
      { name: "boardingTime", type: "string", required: false },
    ],
  },
  {
    name: "payments",
    description: "Invoices, receipts, subscriptions, tax, bank statements",
    fields: [
      { name: "paymentType", type: "enum", required: true, enumValues: ["invoice", "receipt", "subscription_renewal", "payment_failed", "plan_changed", "tax", "wire_transfer", "refund", "statement", "other"] },
      { name: "vendor", type: "string", required: true },
      { name: "amount", type: "number", required: false },
      { name: "currency", type: "string", required: false },
      { name: "dueDate", type: "string", required: false },
      { name: "invoiceNumber", type: "string", required: false },
      { name: "accountLastFour", type: "string", required: false },
      { name: "downloadUrl", type: "string", required: false },
      { name: "managementUrl", type: "string", required: false },
      { name: "paymentUrl", type: "string", required: false },
    ],
  },
  {
    name: "alert",
    description: "Security events specific to the user's account — suspicious login, fraud, CI failures, infra alerts — investigate now. NOT for mass-sent phishing awareness or 'think before you click' campaigns (use status:security_awareness).",
    fields: [
      { name: "alertType", type: "enum", required: true, enumValues: ["suspicious_login", "new_device", "password_changed", "breach_notice", "api_key_exposed", "account_locked", "fraud_alert", "ci_failure", "deployment_failed", "error_spike", "domain_expiry", "cert_expiry", "security_scan", "other"] },
      { name: "service", type: "string", required: true },
      { name: "severity", type: "enum", required: false, enumValues: ["info", "warning", "critical"] },
      { name: "requiresAction", type: "boolean", required: true },
      { name: "actionUrl", type: "string", required: false },
      { name: "ipAddress", type: "string", required: false },
      { name: "location", type: "string", required: false },
      { name: "deviceName", type: "string", required: false },
      { name: "repository", type: "string", required: false },
      { name: "errorMessage", type: "string", required: false },
    ],
  },
  {
    name: "content",
    description: "Newsletters, promotions, social digests — read or unsubscribe",
    fields: [
      { name: "contentType", type: "enum", required: true, enumValues: ["newsletter", "promotion", "social_digest", "product_update", "announcement"] },
      { name: "publisher", type: "string", required: true },
      { name: "topics", type: "array", required: false, notes: "string[]" },
      { name: "discountCode", type: "string", required: false },
      { name: "discountAmount", type: "string", required: false },
      { name: "expiryDate", type: "string", required: false },
      { name: "unsubscribeUrl", type: "string", required: false },
    ],
  },
  {
    name: "onboarding",
    description: "Welcome emails, account creation, getting-started — new service signup",
    fields: [
      { name: "onboardingType", type: "enum", required: true, enumValues: ["welcome", "verification", "getting_started", "trial_started", "other"] },
      { name: "service", type: "string", required: true },
      { name: "actionUrl", type: "string", required: false },
    ],
  },
  {
    name: "status",
    description: "ToS updates, service notices, government notices, security awareness campaigns — passive informational, no action required. Use security_awareness for mass-sent phishing warnings, 'think before you click' emails, and generic credential-safety reminders from banks or service providers.",
    fields: [
      { name: "statusType", type: "enum", required: true, enumValues: ["terms_update", "privacy_policy", "data_processor", "cookie_policy", "compliance", "service_notice", "government", "account_notification", "security_awareness", "other"] },
      { name: "provider", type: "string", required: true },
      { name: "effectiveDate", type: "string", required: false },
      { name: "referenceNumber", type: "string", required: false },
      { name: "documentUrl", type: "string", required: false },
    ],
  },
  {
    name: "healthcare",
    description: "Appointments, test results, prescriptions, insurance",
    fields: [
      { name: "eventType", type: "enum", required: true, enumValues: ["appointment_reminder", "appointment_confirmation", "test_results", "prescription", "insurance_update", "billing", "referral"] },
      { name: "provider", type: "string", required: false },
      { name: "appointmentDate", type: "string", required: false },
      { name: "location", type: "string", required: false },
      { name: "requiresAction", type: "boolean", required: true },
      { name: "portalUrl", type: "string", required: false },
      { name: "patientName", type: "string", required: false },
    ],
  },
  {
    name: "job",
    description: "Applications, interviews, offers, rejections — career pipeline",
    fields: [
      { name: "jobType", type: "enum", required: true, enumValues: ["application_status", "recruiter_outreach", "interview_request", "offer", "rejection", "job_posting"] },
      { name: "company", type: "string", required: false },
      { name: "role", type: "string", required: false },
      { name: "location", type: "string", required: false },
      { name: "salary", type: "string", required: false },
      { name: "interviewDate", type: "string", required: false },
      { name: "applicationStatus", type: "enum", required: false, enumValues: ["submitted", "reviewing", "interview", "offer", "rejected"] },
      { name: "actionUrl", type: "string", required: false },
      { name: "contactName", type: "string", required: false },
      { name: "contactEmail", type: "string", required: false },
    ],
  },
  {
    name: "support",
    description: "Helpdesk tickets with threaded conversation and ticket ID",
    fields: [
      { name: "eventType", type: "enum", required: true, enumValues: ["ticket_opened", "ticket_updated", "ticket_resolved", "ticket_closed", "awaiting_response", "status_update"] },
      { name: "ticketId", type: "string", required: false },
      { name: "service", type: "string", required: true },
      { name: "priority", type: "enum", required: false, enumValues: ["low", "normal", "high", "urgent"] },
      { name: "agentName", type: "string", required: false },
      { name: "responseUrl", type: "string", required: false },
    ],
  },
  {
    name: "events",
    description: "Ticketed events: concerts, conferences, sports, theatre — venue + date + seats",
    fields: [
      { name: "eventType", type: "enum", required: true, enumValues: ["ticket_confirmation", "reminder", "update", "cancellation", "venue_change"] },
      { name: "eventName", type: "string", required: true },
      { name: "venueName", type: "string", required: false },
      { name: "venueAddress", type: "string", required: false },
      { name: "eventStartDatetime", type: "string", required: false },
      { name: "eventEndDatetime", type: "string", required: false },
      { name: "performer", type: "string", required: false },
      { name: "ticketReference", type: "string", required: false },
      { name: "seatDetails", type: "string", required: false },
      { name: "ticketCount", type: "number", required: false },
      { name: "ticketUrl", type: "string", required: false },
      { name: "totalAmount", type: "number", required: false },
      { name: "currency", type: "string", required: false },
    ],
  },
  {
    name: "test",
    description: "Emails sent by the account owner to their own domain — triggers pong",
    fields: [
      { name: "triggeredBy", type: "enum", required: true, enumValues: ["user", "system"] },
    ],
  },
];
