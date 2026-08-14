/**
 * A labelled enum value for LLM-facing workflow fields.
 *
 * Every enum value sent to the classifier carries a human-readable description
 * so the model can disambiguate semantically similar options regardless of the
 * email's language.
 */
export class EnumValue {
  readonly value: string;
  readonly description: string;

  constructor(value: string, description: string) {
    if (!value) throw new Error("EnumValue: value must be non-empty");
    if (!description) throw new Error(`EnumValue "${value}": description must be non-empty`);
    this.value = value;
    this.description = description;
  }

  toPromptFragment(): string {
    return `"${this.value}" (${this.description})`;
  }
}

export interface WorkflowFieldDefinition {
  name: string;
  type: string;
  required: boolean;
  enumValues?: EnumValue[];
  notes?: string;
  /** When true, this field is a thread identity field — used for embedding-based thread matching. */
  identity?: boolean;
}

export interface WorkflowDefinition {
  name: string;
  description: string;
  fields: WorkflowFieldDefinition[];
  /** When false, the classifier is forbidden from assigning this workflow — it is system-assigned only. Default: true. */
  classifierAssignable?: boolean;
}

const e = (value: string, description: string) => new EnumValue(value, description);

export const CLASSIFIER_WORKFLOW_REGISTRY: WorkflowDefinition[] = [
  {
    name: "auth",
    description: "OTPs, password resets, magic links, email verification, 2FA codes",
    fields: [
      { name: "authType", type: "enum", required: true, enumValues: [
        e("verification", "email/account verification via a code to copy, a link to click, or both — includes OTPs, confirmation codes, magic links, and email address confirmations"),
        e("password_reset", "link or instructions to reset a forgotten password"),
        e("two_factor", "second-factor authentication setup or backup codes"),
        e("security_alert", "notification about a security event on the account"),
        e("other", "authentication-related email that does not fit the above categories"),
      ] },
      { name: "code", type: "string", required: false, notes: "The code the user should copy — extract if present in subject or body" },
      { name: "actionUrl", type: "string", required: false, notes: "The verification/login URL the user should click — extract if present" },
      { name: "expiresInMinutes", type: "number", required: false },
      { name: "service", type: "string", required: true, identity: true },
    ],
  },
  {
    name: "conversation",
    description: "Human-to-human back-and-forth — read and reply",
    fields: [
      { name: "sentiment", type: "enum", required: true, enumValues: [
        e("positive", "friendly, grateful, or enthusiastic tone"),
        e("neutral", "factual or informational tone without strong emotion"),
        e("negative", "unhappy, frustrated, or critical tone"),
        e("urgent", "time-sensitive or pressing tone requiring immediate attention"),
      ] },
      { name: "requiresReply", type: "boolean", required: true },
    ],
  },
  {
    name: "crm",
    description: "Sales outreach, proposals, client emails, follow-ups",
    fields: [
      { name: "senderCompany", type: "string", required: false, identity: true },
      { name: "senderRole", type: "string", required: false },
    ],
  },
  {
    name: "package",
    description: "Order confirmations, shipping, delivery tracking",
    fields: [
      { name: "packageType", type: "enum", required: true, enumValues: [
        e("confirmation", "order placed and acknowledged by the retailer"),
        e("shipping", "package has been shipped or is in transit"),
        e("out_for_delivery", "package is on the delivery vehicle today"),
        e("delivered", "package has been delivered"),
        e("return", "return initiated or return label provided"),
        e("refund", "refund issued for a returned or cancelled order"),
        e("cancellation", "order has been cancelled"),
      ] },
      { name: "retailer", type: "string", required: true, identity: true },
      { name: "orderNumber", type: "string", required: false, identity: true },
      { name: "trackingNumber", type: "string", required: false },
      { name: "trackingUrl", type: "string", required: false },
      { name: "estimatedDelivery", type: "date", required: false },
      { name: "items", type: "array", required: false, notes: "Array<{ name: string; quantity: number; price?: number }>" },
      { name: "totalAmount", type: "number", required: false },
      { name: "currency", type: "string", required: false },
    ],
  },
  {
    name: "travel",
    description: "Flights, hotels, itineraries, boarding passes — date-triggered actions",
    fields: [
      { name: "travelType", type: "enum", required: true, enumValues: [
        e("flight", "commercial air travel booking or update"),
        e("hotel", "hotel or accommodation reservation"),
        e("car_rental", "rental car booking"),
        e("train", "rail travel booking"),
        e("cruise", "cruise ship booking"),
        e("activity", "tour, excursion, or activity reservation"),
        e("itinerary", "combined multi-segment travel plan"),
        e("check_in_reminder", "reminder to check in before departure"),
        e("boarding_pass", "boarding pass or mobile check-in confirmation"),
      ] },
      { name: "provider", type: "string", required: true, identity: true },
      { name: "confirmationNumber", type: "string", required: false, identity: true },
      { name: "departureDate", type: "date", required: false },
      { name: "returnDate", type: "date", required: false },
      { name: "origin", type: "string", required: false, identity: true },
      { name: "destination", type: "string", required: false, identity: true },
      { name: "passengers", type: "array", required: false, notes: "Array<{ name: string }>" },
      { name: "totalAmount", type: "number", required: false },
      { name: "currency", type: "string", required: false },
      { name: "flightNumber", type: "string", required: false },
      { name: "seatNumber", type: "string", required: false },
      { name: "boardingTime", type: "date", required: false },
    ],
  },
  {
    name: "payments",
    description: "Invoices, receipts, subscriptions, tax, bank statements",
    fields: [
      { name: "paymentType", type: "enum", required: true, enumValues: [
        e("invoice", "bill requesting payment — not yet paid"),
        e("receipt", "confirmation of a completed payment"),
        e("subscription_renewal", "recurring subscription charge or renewal notice"),
        e("payment_failed", "payment attempt that was declined or failed"),
        e("plan_changed", "subscription plan upgrade, downgrade, or tier change"),
        e("tax", "tax document, statement, or tax-related notification"),
        e("wire_transfer", "bank wire or ACH transfer notification"),
        e("refund", "money returned to the payer"),
        e("statement", "periodic account or billing statement"),
        e("other", "payment-related email that does not fit the above categories"),
      ] },
      { name: "vendor", type: "string", required: true, identity: true },
      { name: "amount", type: "number", required: false },
      { name: "currency", type: "string", required: false },
      { name: "dueDate", type: "date", required: false },
      { name: "invoiceNumber", type: "string", required: false, identity: true },
      { name: "accountLastFour", type: "string", required: false },
      { name: "downloadUrl", type: "string", required: false },
      { name: "managementUrl", type: "string", required: false },
      { name: "paymentUrl", type: "string", required: false },
    ],
  },
  {
    name: "alert",
    description: "Events requiring the user to act — security (suspicious login, fraud, breach), infrastructure (CI failures, error spikes, cert/domain expiry), or account enforcement (frozen, suspended, compliance takedown, content removal deadline). If inaction leads to consequences, this is an alert.",
    fields: [
      { name: "alertType", type: "enum", required: true, enumValues: [
        e("suspicious_login", "unrecognised login attempt from an unusual location or device"),
        e("new_device", "first sign-in from a new device or browser"),
        e("password_changed", "password was recently changed — verify it was intentional"),
        e("breach_notice", "data breach affecting the user's account or credentials"),
        e("api_key_exposed", "API key or secret found in a public repository or log"),
        e("account_locked", "account locked due to failed login attempts or policy violation"),
        e("fraud_alert", "suspicious transaction or fraudulent activity detected"),
        e("ci_failure", "CI/CD pipeline build or test failure"),
        e("deployment_failed", "production or staging deployment did not succeed"),
        e("error_spike", "sudden increase in application errors or exceptions"),
        e("domain_expiry", "domain name approaching or past its expiration date"),
        e("cert_expiry", "TLS/SSL certificate approaching or past its expiration date"),
        e("security_scan", "results from an automated security or vulnerability scan"),
        e("other", "alert that does not fit the above categories — use a descriptive snake_case value if none fit"),
      ], notes: "Common values listed — use a descriptive snake_case value if none fit" },
      { name: "service", type: "string", required: true, identity: true },
      { name: "severity", type: "enum", required: false, enumValues: [
        e("info", "informational — no immediate risk"),
        e("warning", "potential issue that may need attention soon"),
        e("critical", "immediate action required to prevent damage or loss"),
      ] },
      { name: "requiresAction", type: "boolean", required: true },
      { name: "ipAddress", type: "string", required: false },
      { name: "location", type: "string", required: false },
      { name: "deviceName", type: "string", required: false },
      { name: "repository", type: "string", required: false, identity: true },
      { name: "errorMessage", type: "string", required: false },
    ],
  },
  {
    name: "content",
    description: "Newsletters, promotions, social digests — read or unsubscribe",
    fields: [
      { name: "contentType", type: "enum", required: true, enumValues: [
        e("newsletter", "recurring editorial or curated content digest"),
        e("promotion", "marketing offer, sale, or discount"),
        e("social_digest", "summary of social media activity or notifications"),
        e("product_update", "changelog, new feature announcement, or release notes"),
        e("announcement", "one-off company or service announcement"),
      ] },
      { name: "publisher", type: "string", required: true, identity: true },
      { name: "topics", type: "array", required: false, notes: "string[]" },
      { name: "discountCode", type: "string", required: false },
      { name: "discountAmount", type: "string", required: false },
      { name: "expiryDate", type: "date", required: false },
    ],
  },
  {
    name: "onboarding",
    description: "Welcome emails, account creation, getting-started — new service signup",
    fields: [
      { name: "onboardingType", type: "enum", required: true, enumValues: [
        e("welcome", "initial welcome message after account creation"),
        e("verification", "confirm email ownership via a link during signup — part of the onboarding flow"),
        e("getting_started", "tutorial, walkthrough, or onboarding guide"),
        e("trial_started", "free trial has begun — includes trial details or expiry"),
        e("other", "onboarding-related email that does not fit the above categories"),
      ] },
      { name: "service", type: "string", required: true, identity: true },
    ],
  },
  {
    name: "notice",
    description: "ToS updates, service notices, government notices, security awareness campaigns — passive informational where no user action is required and no consequence occurs from inaction. If the email requires the user to act (remove content, respond, pay, unlock) or warns of consequences for inaction (account frozen, service terminated), use 'alert' instead. Use security_awareness for mass-sent phishing warnings, 'think before you click' emails, and generic credential-safety reminders from banks or service providers.",
    fields: [
      { name: "noticeType", type: "enum", required: true, enumValues: [
        e("terms_update", "terms of service or user agreement change"),
        e("privacy_policy", "privacy policy update"),
        e("data_processor", "data processing agreement or sub-processor change"),
        e("cookie_policy", "cookie or tracking policy update"),
        e("compliance", "regulatory or compliance notification"),
        e("service_notice", "planned maintenance, outage, or service status update"),
        e("government", "government or municipal official notice"),
        e("account_notification", "informational account change — no action needed"),
        e("security_awareness", "mass-sent phishing warning or credential-safety reminder"),
        e("other", "passive informational notice that does not fit the above categories"),
      ] },
      { name: "provider", type: "string", required: true, identity: true },
      { name: "effectiveDate", type: "date", required: false },
      { name: "referenceNumber", type: "string", required: false, identity: true },
      { name: "documentUrl", type: "string", required: false },
    ],
  },
  {
    name: "healthcare",
    description: "Appointments, test results, prescriptions, insurance",
    fields: [
      { name: "eventType", type: "enum", required: true, enumValues: [
        e("appointment_reminder", "upcoming appointment reminder"),
        e("appointment_confirmation", "appointment booked or confirmed"),
        e("test_results", "lab, imaging, or diagnostic test results available"),
        e("prescription", "prescription filled, renewed, or ready for pickup"),
        e("insurance_update", "insurance coverage, claims, or benefits change"),
        e("billing", "medical bill or explanation of benefits"),
        e("referral", "referral to a specialist or another provider"),
      ] },
      { name: "provider", type: "string", required: false, identity: true },
      { name: "appointmentDate", type: "date", required: false },
      { name: "location", type: "string", required: false },
      { name: "requiresAction", type: "boolean", required: true },
      { name: "portalUrl", type: "string", required: false },
      { name: "patientName", type: "string", required: false, identity: true },
    ],
  },
  {
    name: "job",
    description: "Applications, interviews, offers, rejections — career pipeline",
    fields: [
      { name: "jobType", type: "enum", required: true, enumValues: [
        e("application_status", "update on a previously submitted job application"),
        e("recruiter_outreach", "unsolicited contact from a recruiter about a role"),
        e("interview_request", "invitation to schedule or attend an interview"),
        e("offer", "formal job offer or offer letter"),
        e("rejection", "application rejected or position filled"),
        e("job_posting", "new job listing or role advertisement"),
      ] },
      { name: "company", type: "string", required: false, identity: true },
      { name: "role", type: "string", required: false, identity: true },
      { name: "location", type: "string", required: false },
      { name: "salary", type: "string", required: false },
      { name: "interviewDate", type: "date", required: false },
      { name: "applicationStatus", type: "enum", required: false, enumValues: [
        e("submitted", "application received by the employer"),
        e("reviewing", "application is being reviewed"),
        e("interview", "candidate has been invited to interview"),
        e("offer", "offer has been extended"),
        e("rejected", "application was rejected"),
      ] },
      { name: "contactName", type: "string", required: false },
      { name: "contactEmail", type: "string", required: false },
    ],
  },
  {
    name: "support",
    description: "Helpdesk tickets with threaded conversation and ticket ID",
    fields: [
      { name: "eventType", type: "enum", required: true, enumValues: [
        e("ticket_opened", "new support ticket created"),
        e("ticket_updated", "existing ticket received a new reply or note"),
        e("ticket_resolved", "issue marked as resolved by the support agent"),
        e("ticket_closed", "ticket closed — no further action expected"),
        e("awaiting_response", "support team is waiting for the user to reply"),
        e("status_update", "ticket status or priority changed"),
      ] },
      { name: "ticketId", type: "string", required: false, identity: true },
      { name: "service", type: "string", required: true, identity: true },
      { name: "priority", type: "enum", required: false, enumValues: [
        e("low", "no urgency — can be addressed at convenience"),
        e("normal", "standard priority — typical response time"),
        e("high", "important issue needing prompt attention"),
        e("urgent", "critical issue requiring immediate response"),
      ] },
      { name: "agentName", type: "string", required: false },
      { name: "responseUrl", type: "string", required: false },
    ],
  },
  {
    name: "events",
    description: "Ticketed events: concerts, conferences, sports, theatre — venue + date + seats",
    fields: [
      { name: "eventType", type: "enum", required: true, enumValues: [
        e("ticket_confirmation", "event ticket purchase confirmed"),
        e("reminder", "upcoming event reminder"),
        e("update", "event details changed — time, lineup, or other info"),
        e("cancellation", "event has been cancelled"),
        e("venue_change", "event location has changed"),
      ] },
      { name: "eventName", type: "string", required: true, identity: true },
      { name: "venueName", type: "string", required: false, identity: true },
      { name: "venueAddress", type: "string", required: false },
      { name: "eventStartDatetime", type: "date", required: false },
      { name: "eventEndDatetime", type: "date", required: false },
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
    name: "healthcheck",
    description: "System-generated pipeline validation emails — daily automated checks",
    fields: [],
    classifierAssignable: false,
  },
  {
    name: "test",
    description: "Emails sent by the account owner to their own domain — triggers pong",
    fields: [],
    classifierAssignable: false,
  },
  {
    name: "unspecified",
    description: "Classification failed or was skipped — email is unclassified",
    fields: [],
    classifierAssignable: false,
  },
];
