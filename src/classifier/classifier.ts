import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { Workflow, WorkflowData } from "../types/index.js";

export const CLASSIFICATION_MODEL_ID = "us.anthropic.claude-opus-4-5-20251101-v1:0";
export const EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0";

export interface ClassificationInput {
  from: string;
  to: string[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  receivedAt: string;
  headers: Record<string, string>;
}

export interface ClassificationOutput {
  workflow: Workflow;
  workflowData: WorkflowData;
  spamScore: number;
  summary: string;
  labels: string[];
  classificationModelId: string;
}

interface RawClassificationResponse {
  workflow: Workflow;
  workflowData: Record<string, unknown>;
  spamScore: number;
  summary: string;
  labels: string[];
}

export class SignalClassifier {
  private readonly client: BedrockRuntimeClient;

  constructor(client?: BedrockRuntimeClient) {
    this.client = client ?? new BedrockRuntimeClient({});
  }

  async classify(input: ClassificationInput): Promise<ClassificationOutput> {
    const content = this.formatContent(input);
    const requestBody = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 2048,
      system: CLASSIFICATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    };

    const response = await this.client.send(
      new InvokeModelCommand({
        modelId: CLASSIFICATION_MODEL_ID,
        contentType: "application/json",
        accept: "application/json",
        body: new TextEncoder().encode(JSON.stringify(requestBody)),
      }),
    );

    const result = JSON.parse(new TextDecoder().decode(response.body)) as {
      content: Array<{ type: string; text: string }>;
    };

    const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
    const raw = JSON.parse(text) as RawClassificationResponse;

    return {
      workflow: raw.workflow,
      workflowData: raw.workflowData as unknown as WorkflowData,
      spamScore: raw.spamScore,
      summary: raw.summary,
      labels: raw.labels,
      classificationModelId: CLASSIFICATION_MODEL_ID,
    };
  }

  async embed(text: string): Promise<number[]> {
    const requestBody = {
      inputText: text.slice(0, 8000),
      dimensions: 1024,
      normalize: true,
    };

    const response = await this.client.send(
      new InvokeModelCommand({
        modelId: EMBEDDING_MODEL_ID,
        contentType: "application/json",
        accept: "application/json",
        body: new TextEncoder().encode(JSON.stringify(requestBody)),
      }),
    );

    const result = JSON.parse(new TextDecoder().decode(response.body)) as { embedding: number[] };
    return result.embedding;
  }

  private formatContent(input: ClassificationInput): string {
    const body = input.textBody ?? stripHtml(input.htmlBody ?? "");
    const truncated = body.length > 4000 ? body.slice(0, 4000) + "\n[... truncated]" : body;

    const relevantHeaders = Object.entries(input.headers)
      .filter(([k]) => RELEVANT_HEADERS.has(k.toLowerCase()))
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");

    return [
      `From: ${input.from}`,
      `To: ${input.to.join(", ")}`,
      `Subject: ${input.subject}`,
      `Received: ${input.receivedAt}`,
      relevantHeaders ? `Headers:\n${relevantHeaders}` : "",
      "",
      "Body:",
      truncated,
    ]
      .filter(Boolean)
      .join("\n");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RELEVANT_HEADERS = new Set([
  "dkim-signature",
  "x-spam-status",
  "x-spam-score",
  "x-mailer",
  "list-unsubscribe",
  "precedence",
  "x-ses-receipt",
  "authentication-results",
  "received-spf",
  "dmarc",
]);

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const CLASSIFICATION_SYSTEM_PROMPT = `You are an email workflow classification engine. Analyze incoming emails and return a JSON object:

{
  "workflow": "<one of the workflows below>",
  "workflowData": { <structured data for the workflow> },
  "spamScore": <0.0–1.0>,
  "summary": "<one sentence summary>",
  "labels": ["<suggested label>", ...]
}

## Workflows

### auth
OTPs, password resets, magic links, email verification, 2FA codes
{ "workflow": "auth", "authType": "otp"|"password_reset"|"magic_link"|"verification"|"two_factor"|"other", "code": "<extracted code or null>", "expiresInMinutes": <number or null>, "service": "<name>", "actionUrl": "<url or null>" }

### invoice
Invoices, receipts, billing statements, payment confirmations, refund notices
{ "workflow": "invoice", "invoiceType": "invoice"|"receipt"|"statement"|"payment_confirmation"|"refund", "vendor": "<name>", "amount": <number or null>, "currency": "<ISO 4217 or null>", "invoiceNumber": "<string or null>", "dueDate": "<YYYY-MM-DD or null>", "lineItems": [], "downloadUrl": "<url or null>" }

### order
Order confirmations, shipping updates, delivery notifications, returns, refunds, cancellations
{ "workflow": "order", "orderType": "confirmation"|"shipping"|"out_for_delivery"|"delivered"|"return"|"refund"|"cancellation", "retailer": "<name>", "orderNumber": "<string or null>", "trackingNumber": "<string or null>", "trackingUrl": "<url or null>", "estimatedDelivery": "<YYYY-MM-DD or null>", "items": [], "totalAmount": <number or null>, "currency": "<string or null>" }

### financial
Bank statements, wire transfers, transaction alerts, fraud alerts, tax documents
{ "workflow": "financial", "financialType": "statement"|"transaction"|"alert"|"transfer"|"tax"|"fraud_alert", "institution": "<name>", "amount": <number or null>, "currency": "<string or null>", "accountLastFour": "<string or null>", "transactionDate": "<YYYY-MM-DD or null>", "statementPeriod": "<string or null>", "isSuspicious": true|false }

### travel
Flight bookings, hotel reservations, car rentals, itineraries, check-in reminders, boarding passes
{ "workflow": "travel", "travelType": "flight"|"hotel"|"car_rental"|"train"|"cruise"|"activity"|"itinerary"|"check_in_reminder"|"boarding_pass", "provider": "<name>", "confirmationNumber": "<string or null>", "departureDate": "<YYYY-MM-DD or null>", "returnDate": "<YYYY-MM-DD or null>", "origin": "<city or null>", "destination": "<city or null>", "passengerName": "<string or null>", "totalAmount": <number or null>, "currency": "<string or null>" }

### job
Job applications, recruiter outreach, interview scheduling, offers, rejections, job postings
{ "workflow": "job", "jobType": "application_status"|"recruiter_outreach"|"interview_request"|"offer"|"rejection"|"job_posting", "company": "<string or null>", "role": "<string or null>", "location": "<string or null>", "salary": "<string or null>", "interviewDate": "<ISO datetime or null>", "applicationStatus": "submitted"|"reviewing"|"interview"|"offer"|"rejected"|null, "actionUrl": "<url or null>" }

### newsletter
Publications, editorial digests, blog mailing lists, curated content
{ "workflow": "newsletter", "publication": "<name>", "topics": ["<topic>"], "frequency": "daily"|"weekly"|"monthly"|"irregular"|null, "unsubscribeUrl": "<url or null>" }

### promotions
Promotional offers, discount codes, flash sales, abandoned cart reminders, loyalty rewards, product launches — commercial emails whose primary goal is driving a purchase or re-engagement with an offer
{ "workflow": "promotions", "promotionType": "discount"|"sale"|"flash_sale"|"loyalty"|"referral"|"product_launch"|"abandoned_cart"|"win_back", "brand": "<name>", "discountCode": "<string or null>", "discountAmount": "<string or null>", "expiryDate": "<YYYY-MM-DD or null>", "shopUrl": "<url or null>" }

### onboarding
Welcome emails, account setup guides, getting-started tutorials, feature tours, product tips, and re-engagement check-ins sent by apps or services after a user signs up. Distinct from promotions (no purchase intent) and newsletters (not editorial).
{ "workflow": "onboarding", "service": "<app/product name>", "onboardingType": "welcome"|"setup_guide"|"feature_tour"|"tip"|"check_in"|"re_engagement", "stepNumber": <number or null>, "totalSteps": <number or null>, "actionUrl": "<url or null>" }

### social
Social media notifications, community platforms, forum activity, event invites
{ "workflow": "social", "platform": "<Twitter/LinkedIn/Reddit/etc>", "notificationType": "mention"|"follow"|"message"|"like"|"comment"|"friend_request"|"digest"|"event", "actorName": "<string or null>", "contentPreview": "<string or null>", "actionUrl": "<url or null>" }

### crm
Sales outreach, business proposals, client emails, contract follow-ups
{ "workflow": "crm", "crmType": "sales_outreach"|"follow_up"|"client_message"|"proposal"|"contract"|"support", "senderCompany": "<string or null>", "senderRole": "<string or null>", "dealValue": <number or null>, "currency": "<string or null>", "urgency": "low"|"medium"|"high", "requiresReply": true|false }

### personal
Direct human-to-human correspondence not generated by automated systems
{ "workflow": "personal", "senderName": "<string or null>", "isReply": true|false, "threadLength": <number or null>, "sentiment": "positive"|"neutral"|"negative"|"urgent", "requiresReply": true|false }

### security
Suspicious login alerts, new device notifications, breach notices, API key exposure, account lockout
{ "workflow": "security", "alertType": "suspicious_login"|"new_device"|"password_changed"|"breach_notice"|"api_key_exposed"|"account_locked"|"other", "service": "<name>", "ipAddress": "<string or null>", "location": "<string or null>", "deviceName": "<string or null>", "requiresAction": true|false, "actionUrl": "<url or null>" }

### scheduling
Calendar invites, appointment confirmations, meeting reminders, cancellations, reschedule requests
{ "workflow": "scheduling", "eventType": "meeting_invite"|"appointment"|"reminder"|"cancellation"|"reschedule"|"confirmation", "title": "<event name>", "startTime": "<ISO datetime or null>", "endTime": "<ISO datetime or null>", "location": "<string or null>", "organizer": "<string or null>", "attendees": [], "calendarUrl": "<url or null>", "requiresResponse": true|false }

### support
Customer support ticket updates, helpdesk responses, service status notifications
{ "workflow": "support", "eventType": "ticket_opened"|"ticket_updated"|"ticket_resolved"|"ticket_closed"|"awaiting_response"|"status_update", "ticketId": "<string or null>", "service": "<name>", "priority": "low"|"normal"|"high"|"urgent"|null, "agentName": "<string or null>", "responseUrl": "<url or null>" }

### developer
GitHub/GitLab PRs and reviews, CI/CD results, error monitoring alerts, domain/certificate expiry
{ "workflow": "developer", "platform": "github"|"gitlab"|"bitbucket"|"jira"|"sentry"|"datadog"|"pagerduty"|"vercel"|"aws"|"cloudflare"|"other", "eventType": "pull_request"|"code_review"|"ci_failure"|"ci_success"|"deployment"|"error_alert"|"domain_expiry"|"cert_expiry"|"security_scan"|"other", "repository": "<string or null>", "severity": "info"|"warning"|"critical"|null, "requiresAction": true|false, "actionUrl": "<url or null>" }

### subscription
SaaS subscription renewals, trial expiry, payment failures, plan changes, cancellations
{ "workflow": "subscription", "eventType": "renewal"|"trial_expiring"|"payment_failed"|"plan_changed"|"cancelled"|"reactivated"|"usage_alert", "service": "<name>", "planName": "<string or null>", "amount": <number or null>, "currency": "<string or null>", "nextBillingDate": "<YYYY-MM-DD or null>", "trialEndsAt": "<ISO datetime or null>", "managementUrl": "<url or null>" }

### healthcare
Medical appointment reminders, test results, prescription notifications, insurance updates
{ "workflow": "healthcare", "eventType": "appointment_reminder"|"appointment_confirmation"|"test_results"|"prescription"|"insurance_update"|"billing"|"referral", "provider": "<string or null>", "appointmentDate": "<ISO datetime or null>", "location": "<string or null>", "requiresAction": true|false, "portalUrl": "<url or null>" }

### government
Tax notices, benefits updates, license renewals, official government correspondence
{ "workflow": "government", "agency": "<string or null>", "documentType": "tax"|"benefits"|"license"|"permit"|"notice"|"fine"|"voting"|"healthcare"|"other", "referenceNumber": "<string or null>", "deadlineDate": "<YYYY-MM-DD or null>", "requiresResponse": true|false, "portalUrl": "<url or null>" }

### notice
Privacy policy changes, terms of service updates, data processor changes, cookie policy updates, GDPR/compliance notices — bulk regulatory emails sent by automated systems that users are not expected to read or act on
{ "workflow": "notice", "noticeType": "privacy_policy"|"terms_update"|"data_processor"|"cookie_policy"|"compliance"|"other", "provider": "<name>", "effectiveDate": "<YYYY-MM-DD or null>", "documentUrl": "<url or null>" }

## Spam scoring
spamScore is ALWAYS required and is orthogonal to workflow. Assign the real workflow even for spam:
- A phishing email pretending to be a bank login → workflow:"auth", spamScore:0.95
- A scam pretending to be a shipping update → workflow:"order", spamScore:0.9
- Unsolicited bulk marketing → workflow:"promotions", spamScore:0.7
- A legitimate newsletter → workflow:"newsletter", spamScore:0.05

Score ranges:
- 0.0–0.2: Clearly legitimate
- 0.2–0.5: Somewhat suspicious
- 0.5–0.8: Likely spam/unwanted
- 0.8–1.0: Definite spam, phishing, or malware

## Label suggestions
Suggest short, useful labels (e.g. "action-needed", "urgent", "billing", "recruiting"). Return [] if none apply.

Return only valid JSON, no markdown.`;
