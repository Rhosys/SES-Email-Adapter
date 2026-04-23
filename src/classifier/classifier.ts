import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { Category, CategoryData } from "../types/index.js";

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
  category: Category;
  categoryData: CategoryData;
  spamScore: number;
  summary: string;
  labels: string[];
  classificationModelId: string;
}

interface RawClassificationResponse {
  category: Category;
  categoryData: Record<string, unknown>;
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
      category: raw.category,
      categoryData: raw.categoryData as unknown as CategoryData,
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

const CLASSIFICATION_SYSTEM_PROMPT = `You are an email classification engine. Analyze incoming emails and return a JSON object with this exact shape:

{
  "category": "<one of the categories below>",
  "categoryData": { <structured data for the category> },
  "spamScore": <0.0–1.0>,
  "summary": "<one sentence summary>",
  "labels": ["<suggested label>", ...]
}

## Categories

### login
OTPs, password resets, magic links, verification codes, 2FA
{ "category": "login", "loginType": "otp"|"password_reset"|"magic_link"|"verification"|"other", "code": "<code or null>", "expiresInMinutes": <number or null>, "service": "<name>", "actionUrl": "<url or null>" }

### invoice
Invoices, receipts, billing statements, payment confirmations
{ "category": "invoice", "invoiceType": "invoice"|"receipt"|"statement"|"payment_confirmation", "vendor": "<name>", "amount": <number or null>, "currency": "<ISO 4217 or null>", "invoiceNumber": "<string or null>", "dueDate": "<YYYY-MM-DD or null>", "lineItems": [], "downloadUrl": "<url or null>" }

### job
Job applications, recruiter messages, interview scheduling, offers, rejections
{ "category": "job", "jobType": "application_status"|"recruiter_outreach"|"interview_request"|"offer"|"rejection"|"job_posting", "company": "<string or null>", "role": "<string or null>", "location": "<string or null>", "salary": "<string or null>", "interviewDate": "<ISO datetime or null>", "applicationStatus": "submitted"|"reviewing"|"interview"|"offer"|"rejected"|null, "actionUrl": "<url or null>" }

### crm
Sales outreach, client emails, proposals, contracts, follow-ups
{ "category": "crm", "crmType": "sales_outreach"|"follow_up"|"client_message"|"proposal"|"contract"|"support", "senderCompany": "<string or null>", "senderRole": "<string or null>", "dealValue": <number or null>, "currency": "<string or null>", "urgency": "low"|"medium"|"high", "requiresReply": true|false }

### newsletter
Subscription emails, marketing digests, product updates
{ "category": "newsletter", "publication": "<name>", "topics": ["<topic>"], "frequency": "daily"|"weekly"|"monthly"|"irregular"|null, "unsubscribeUrl": "<url or null>" }

### notification
System alerts, app notifications, service status, security alerts
{ "category": "notification", "notificationType": "alert"|"update"|"reminder"|"security"|"system", "service": "<name>", "severity": "info"|"warning"|"critical", "requiresAction": true|false, "actionUrl": "<url or null>" }

### travel
Flight bookings, hotel reservations, car rentals, itineraries
{ "category": "travel", "travelType": "flight"|"hotel"|"car_rental"|"train"|"cruise"|"activity"|"itinerary", "provider": "<name>", "confirmationNumber": "<string or null>", "departureDate": "<YYYY-MM-DD or null>", "returnDate": "<YYYY-MM-DD or null>", "origin": "<city or null>", "destination": "<city>", "passengerName": "<string or null>", "totalAmount": <number or null>, "currency": "<string or null>" }

### shopping
Order confirmations, shipping updates, delivery notifications, returns
{ "category": "shopping", "shoppingType": "order_confirmation"|"shipping"|"delivery"|"return"|"refund", "retailer": "<name>", "orderNumber": "<string or null>", "trackingNumber": "<string or null>", "trackingUrl": "<url or null>", "estimatedDelivery": "<YYYY-MM-DD or null>", "items": [], "totalAmount": <number or null>, "currency": "<string or null>" }

### financial
Bank statements, wire transfers, account alerts, tax documents
{ "category": "financial", "financialType": "statement"|"transaction"|"alert"|"transfer"|"tax", "institution": "<name>", "amount": <number or null>, "currency": "<string or null>", "accountLastFour": "<string or null>", "transactionDate": "<YYYY-MM-DD or null>", "statementPeriod": "<string or null>" }

### social
Social media notifications, community platforms, forum activity
{ "category": "social", "platform": "<Twitter/LinkedIn/Reddit/etc>", "notificationType": "mention"|"follow"|"message"|"like"|"comment"|"friend_request"|"digest", "actorName": "<string or null>", "contentPreview": "<string or null>", "actionUrl": "<url or null>" }

### personal
Direct human-to-human communication, not from automated systems
{ "category": "personal", "senderName": "<string or null>", "isReply": true|false, "threadLength": <number or null>, "sentiment": "positive"|"neutral"|"negative"|"urgent", "requiresReply": true|false }

### spam
Phishing, scams, malware, unsolicited bulk email
{ "category": "spam", "spamType": "phishing"|"malware"|"unsolicited_marketing"|"scam"|"other", "confidence": 0.0–1.0, "indicators": ["<reason>"] }

## Spam scoring
- 0.0–0.2: Clearly legitimate
- 0.2–0.5: Somewhat suspicious
- 0.5–0.8: Likely spam
- 0.8–1.0: Definitely spam/phishing

## Label suggestions
Suggest short, useful labels (e.g. "action-needed", "billing", "recruiting", "urgent", "important"). Return [] if no labels apply.

Return only valid JSON, no markdown.`;
