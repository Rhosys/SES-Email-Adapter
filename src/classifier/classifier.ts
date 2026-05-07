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

### payments
Invoices, receipts, billing statements, payment confirmations, refunds, bank statements, wire transfers, transaction alerts, subscription renewals, trial expiry, payment failures, plan changes, tax documents
{ "workflow": "payments", "paymentType": "invoice"|"receipt"|"subscription_renewal"|"payment_failed"|"plan_changed"|"tax"|"wire_transfer"|"refund"|"statement"|"other", "vendor": "<name>", "amount": <number or null>, "currency": "<ISO 4217 or null>", "invoiceNumber": "<string or null>", "dueDate": "<YYYY-MM-DD or null>", "accountLastFour": "<string or null>", "downloadUrl": "<url or null>", "managementUrl": "<url or null>" }

### package
Order confirmations, shipping updates, delivery notifications, returns, refunds, cancellations
{ "workflow": "package", "packageType": "confirmation"|"shipping"|"out_for_delivery"|"delivered"|"return"|"refund"|"cancellation", "retailer": "<name>", "orderNumber": "<string or null>", "trackingNumber": "<string or null>", "trackingUrl": "<url or null>", "estimatedDelivery": "<YYYY-MM-DD or null>", "items": [], "totalAmount": <number or null>, "currency": "<string or null>" }

### travel
Flight bookings, hotel reservations, car rentals, itineraries, check-in reminders, boarding passes
{ "workflow": "travel", "travelType": "flight"|"hotel"|"car_rental"|"train"|"cruise"|"activity"|"itinerary"|"check_in_reminder"|"boarding_pass", "provider": "<name>", "confirmationNumber": "<string or null>", "departureDate": "<YYYY-MM-DD or null>", "returnDate": "<YYYY-MM-DD or null>", "origin": "<city or null>", "destination": "<city or null>", "passengerName": "<string or null>", "totalAmount": <number or null>, "currency": "<string or null>" }

### job
Job applications, recruiter outreach, interview scheduling, offers, rejections, job postings
{ "workflow": "job", "jobType": "application_status"|"recruiter_outreach"|"interview_request"|"offer"|"rejection"|"job_posting", "company": "<string or null>", "role": "<string or null>", "location": "<string or null>", "salary": "<string or null>", "interviewDate": "<ISO datetime or null>", "applicationStatus": "submitted"|"reviewing"|"interview"|"offer"|"rejected"|null, "actionUrl": "<url or null>" }

### content
Publications, editorial digests, blog mailing lists, promotional offers, discount codes, flash sales, abandoned cart reminders, loyalty rewards, product launches, social media digests — commercial or editorial bulk emails
{ "workflow": "content", "contentType": "newsletter"|"promotion"|"social_digest"|"product_update"|"announcement", "publisher": "<name>", "topics": ["<topic>"], "discountCode": "<string or null>", "discountAmount": "<string or null>", "expiryDate": "<YYYY-MM-DD or null>", "unsubscribeUrl": "<url or null>" }

### onboarding
Welcome emails, account setup guides, getting-started tutorials, feature tours, product tips, and re-engagement check-ins sent by apps or services after a user signs up. Distinct from content (no purchase intent) and from support (no ticket).
{ "workflow": "onboarding", "service": "<app/product name>", "onboardingType": "welcome"|"setup_guide"|"feature_tour"|"tip"|"check_in"|"re_engagement", "stepNumber": <number or null>, "totalSteps": <number or null>, "actionUrl": "<url or null>" }

### crm
Sales outreach, business proposals, client emails, contract follow-ups
{ "workflow": "crm", "crmType": "sales_outreach"|"follow_up"|"client_message"|"proposal"|"contract"|"support", "senderCompany": "<string or null>", "senderRole": "<string or null>", "dealValue": <number or null>, "currency": "<string or null>", "urgency": "low"|"medium"|"high", "requiresReply": true|false }

### conversation
Direct human-to-human correspondence not generated by automated systems
{ "workflow": "conversation", "senderName": "<string or null>", "isReply": true|false, "threadLength": <number or null>, "sentiment": "positive"|"neutral"|"negative"|"urgent", "requiresReply": true|false }

### alert
Suspicious login alerts, new device notifications, breach notices, API key exposure, account lockout, fraud alerts, CI/CD failures, deployment failures, error monitoring alerts, domain/certificate expiry, security scan results — anything that signals a system event requiring attention
{ "workflow": "alert", "alertType": "suspicious_login"|"new_device"|"password_changed"|"breach_notice"|"api_key_exposed"|"account_locked"|"fraud_alert"|"ci_failure"|"deployment_failed"|"error_spike"|"domain_expiry"|"cert_expiry"|"security_scan"|"other", "service": "<name>", "severity": "info"|"warning"|"critical"|null, "requiresAction": true|false, "actionUrl": "<url or null>", "ipAddress": "<string or null>", "location": "<string or null>", "deviceName": "<string or null>", "repository": "<string or null>", "errorMessage": "<string or null>" }

### scheduling
Calendar invites, appointment confirmations, meeting reminders, cancellations, reschedule requests
{ "workflow": "scheduling", "eventType": "meeting_invite"|"appointment"|"reminder"|"cancellation"|"reschedule"|"confirmation", "title": "<event name>", "startTime": "<ISO datetime or null>", "endTime": "<ISO datetime or null>", "location": "<string or null>", "organizer": "<string or null>", "attendees": [], "calendarUrl": "<url or null>", "requiresResponse": true|false }

### support
Customer support ticket updates, helpdesk responses, service status notifications
{ "workflow": "support", "eventType": "ticket_opened"|"ticket_updated"|"ticket_resolved"|"ticket_closed"|"awaiting_response"|"status_update", "ticketId": "<string or null>", "service": "<name>", "priority": "low"|"normal"|"high"|"urgent"|null, "agentName": "<string or null>", "responseUrl": "<url or null>" }

### healthcare
Medical appointment reminders, test results, prescription notifications, insurance updates
{ "workflow": "healthcare", "eventType": "appointment_reminder"|"appointment_confirmation"|"test_results"|"prescription"|"insurance_update"|"billing"|"referral", "provider": "<string or null>", "appointmentDate": "<ISO datetime or null>", "location": "<string or null>", "requiresAction": true|false, "portalUrl": "<url or null>" }

### status
Passive informational notices that users are not expected to act on: privacy policy changes, terms of service updates, data processor notices, cookie policy updates, GDPR/compliance notices, phishing-warning bulletins from banks/SaaS ("we will never ask for your password"), and official government correspondence (tax notices, benefits updates, license renewals).

IMPORTANT — phishing-warning notices vs actual phishing:
- "Beware of phishing — we will never ask for your password" from a bank → workflow:"status", statusType:"compliance", spamScore:0.0–0.1
- An email pretending to be a bank and asking you to click a suspicious link → assign the real workflow (e.g. "auth") with spamScore:0.8–1.0

{ "workflow": "status", "statusType": "terms_update"|"privacy_policy"|"data_processor"|"cookie_policy"|"compliance"|"service_notice"|"government"|"account_notification"|"other", "provider": "<name>", "effectiveDate": "<YYYY-MM-DD or null>", "referenceNumber": "<string or null>", "documentUrl": "<url or null>" }

### test
Emails sent by a user to test that their own inbox is working. Detected by obvious test content (subject "test", "testing 123", "hello world", "is this thing on?" etc.) or by the processor overriding the workflow based on sender identity. The processor handles sender-based detection; classify here only when content makes the intent unambiguous.
{ "workflow": "test", "triggeredBy": "user" }

## Spam scoring
spamScore is ALWAYS required and is orthogonal to workflow. Assign the real workflow even for spam:
- A phishing email pretending to be a bank login → workflow:"auth", spamScore:0.95
- A scam pretending to be a shipping update → workflow:"package", spamScore:0.9
- Unsolicited bulk marketing → workflow:"content", spamScore:0.7
- A legitimate newsletter → workflow:"content", spamScore:0.05

Score ranges:
- 0.0–0.2: Clearly legitimate
- 0.2–0.5: Somewhat suspicious
- 0.5–0.8: Likely spam/unwanted
- 0.8–1.0: Definite spam, phishing, or malware

## Label suggestions
Suggest short, useful labels (e.g. "action-needed", "urgent", "billing", "recruiting"). Return [] if none apply.

Return only valid JSON, no markdown.`;
