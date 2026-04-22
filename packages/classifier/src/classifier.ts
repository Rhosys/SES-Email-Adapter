import Anthropic from "@anthropic-ai/sdk";
import type {
  EmailCategory,
  CategoryData,
  Email,
  ValidationResult,
} from "@ses-adapter/shared";

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
  category: EmailCategory;
  categoryData: CategoryData;
  spamScore: number;
  isValid: boolean;
  summary: string;
  priority: Email["priority"];
  validationResult: ValidationResult;
}

/**
 * Claude-powered email classifier.
 *
 * Uses adaptive thinking + structured outputs to reliably classify emails
 * into first-class category experiences and extract structured data.
 *
 * The system prompt is cached (cache_control) since it's large and stable.
 * Only the per-email content changes per request.
 */
export class EmailClassifier {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({ apiKey: apiKey ?? process.env["ANTHROPIC_API_KEY"] });
  }

  async classify(input: ClassificationInput): Promise<ClassificationOutput> {
    const emailContent = this.formatEmailContent(input);
    const schema = buildOutputSchema();

    const response = await this.client.messages.parse({
      model: "claude-opus-4-7",
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema },
      },
      system: [
        {
          type: "text",
          text: CLASSIFICATION_SYSTEM_PROMPT,
          // Cache the large, stable system prompt — reused across all emails.
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: emailContent,
        },
      ],
    });

    const raw = response.parsed_output as RawClassificationResponse;
    return this.mapResponse(raw);
  }

  private formatEmailContent(input: ClassificationInput): string {
    const body = input.textBody ?? stripHtml(input.htmlBody ?? "");
    const truncatedBody = body.length > 4000 ? body.slice(0, 4000) + "\n[... truncated]" : body;

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
      truncatedBody,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private mapResponse(raw: RawClassificationResponse): ClassificationOutput {
    const validationResult: ValidationResult = {
      isValid: raw.isValid,
      spamScore: raw.spamScore,
      failedChecks: raw.failedChecks.map((c) => ({
        name: c.check,
        passed: false,
        detail: c.reason,
      })),
    };

    return {
      category: raw.category,
      categoryData: raw.categoryData as CategoryData,
      spamScore: raw.spamScore,
      isValid: raw.isValid,
      summary: raw.summary,
      priority: raw.priority,
      validationResult,
    };
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
// JSON Schema for structured output
// ---------------------------------------------------------------------------

interface RawClassificationResponse {
  category: EmailCategory;
  categoryData: Record<string, unknown>;
  spamScore: number;
  isValid: boolean;
  summary: string;
  priority: "urgent" | "high" | "normal" | "low";
  failedChecks: Array<{ check: string; reason: string }>;
}

function buildOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["category", "categoryData", "spamScore", "isValid", "summary", "priority", "failedChecks"],
    properties: {
      category: {
        type: "string",
        enum: [
          "login", "invoice", "job", "crm", "newsletter",
          "notification", "travel", "shopping", "financial",
          "social", "personal", "spam",
        ],
        description: "The primary category of this email.",
      },
      categoryData: {
        type: "object",
        description: "Structured data extracted for the category. Shape varies by category value.",
        additionalProperties: true,
      },
      spamScore: {
        type: "number",
        description: "0.0 = definitely not spam, 1.0 = definitely spam.",
      },
      isValid: {
        type: "boolean",
        description: "False if this email should be silently dropped (spam, phishing, invalid).",
      },
      summary: {
        type: "string",
        description: "One sentence summary of what this email is about.",
      },
      priority: {
        type: "string",
        enum: ["urgent", "high", "normal", "low"],
        description: "How urgently the user should see this email.",
      },
      failedChecks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["check", "reason"],
          properties: {
            check: { type: "string" },
            reason: { type: "string" },
          },
        },
        description: "Validation checks that failed (empty if all passed).",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// System prompt (cached — kept stable)
// ---------------------------------------------------------------------------

const CLASSIFICATION_SYSTEM_PROMPT = `You are an email classification engine for a next-generation email client. Your job is to analyze incoming emails and:

1. Classify them into the correct category
2. Extract structured data specific to that category
3. Assess spam/validity
4. Summarize in one sentence
5. Assign priority

## Categories and their categoryData schemas

### login
For: OTPs, password resets, magic links, email verification, 2FA codes
{
  "category": "login",
  "loginType": "otp" | "password_reset" | "magic_link" | "verification" | "other",
  "code": "<the actual code if visible, e.g. '847291'>",
  "expiresInMinutes": <number or null>,
  "service": "<service name, e.g. 'GitHub'>",
  "actionUrl": "<primary CTA URL or null>"
}

### invoice
For: invoices, receipts, payment confirmations, billing statements
{
  "category": "invoice",
  "invoiceType": "invoice" | "receipt" | "statement" | "payment_confirmation",
  "vendor": "<vendor name>",
  "amount": <number or null>,
  "currency": "<ISO 4217 or null>",
  "invoiceNumber": "<string or null>",
  "dueDate": "<YYYY-MM-DD or null>",
  "lineItems": [{ "description": "...", "amount": 0.00 }],
  "downloadUrl": "<URL or null>"
}

### job
For: job applications, recruiter messages, interview scheduling, offers, rejections
{
  "category": "job",
  "jobType": "application_status" | "recruiter_outreach" | "interview_request" | "offer" | "rejection" | "job_posting",
  "company": "<string or null>",
  "role": "<string or null>",
  "location": "<string or null>",
  "salary": "<string or null>",
  "interviewDate": "<ISO datetime or null>",
  "applicationStatus": "submitted" | "reviewing" | "interview" | "offer" | "rejected" | null,
  "actionUrl": "<URL or null>"
}

### crm
For: sales outreach, client emails, business proposals, follow-ups, contracts
{
  "category": "crm",
  "crmType": "sales_outreach" | "follow_up" | "client_message" | "proposal" | "contract" | "support",
  "senderCompany": "<string or null>",
  "senderRole": "<string or null>",
  "dealValue": <number or null>,
  "currency": "<string or null>",
  "urgency": "low" | "medium" | "high",
  "requiresReply": true | false
}

### newsletter
For: subscription emails, marketing digests, product updates, content newsletters
{
  "category": "newsletter",
  "publication": "<name>",
  "topics": ["topic1", "topic2"],
  "frequency": "daily" | "weekly" | "monthly" | "irregular" | null,
  "unsubscribeUrl": "<URL or null>"
}

### notification
For: system alerts, app notifications, service status updates, security alerts
{
  "category": "notification",
  "notificationType": "alert" | "update" | "reminder" | "security" | "system",
  "service": "<service name>",
  "severity": "info" | "warning" | "critical",
  "requiresAction": true | false,
  "actionUrl": "<URL or null>"
}

### travel
For: flight bookings, hotel reservations, car rentals, itineraries
{
  "category": "travel",
  "travelType": "flight" | "hotel" | "car_rental" | "train" | "cruise" | "activity" | "itinerary",
  "provider": "<airline/hotel/etc>",
  "confirmationNumber": "<string or null>",
  "departureDate": "<YYYY-MM-DD or null>",
  "returnDate": "<YYYY-MM-DD or null>",
  "origin": "<city or null>",
  "destination": "<city>",
  "passengerName": "<string or null>",
  "totalAmount": <number or null>,
  "currency": "<string or null>"
}

### shopping
For: order confirmations, shipping updates, delivery notifications, returns
{
  "category": "shopping",
  "shoppingType": "order_confirmation" | "shipping" | "delivery" | "return" | "refund",
  "retailer": "<name>",
  "orderNumber": "<string or null>",
  "trackingNumber": "<string or null>",
  "trackingUrl": "<URL or null>",
  "estimatedDelivery": "<YYYY-MM-DD or null>",
  "items": [{ "name": "...", "quantity": 1, "price": 0.00 }],
  "totalAmount": <number or null>,
  "currency": "<string or null>"
}

### financial
For: bank statements, wire transfers, account alerts, tax documents
{
  "category": "financial",
  "financialType": "statement" | "transaction" | "alert" | "transfer" | "tax",
  "institution": "<bank/institution name>",
  "amount": <number or null>,
  "currency": "<string or null>",
  "accountLastFour": "<string or null>",
  "transactionDate": "<YYYY-MM-DD or null>",
  "statementPeriod": "<string or null>"
}

### social
For: social media notifications, community platforms, forum activity
{
  "category": "social",
  "platform": "<Twitter/LinkedIn/Reddit/etc>",
  "notificationType": "mention" | "follow" | "message" | "like" | "comment" | "friend_request" | "digest",
  "actorName": "<string or null>",
  "contentPreview": "<string or null>",
  "actionUrl": "<URL or null>"
}

### personal
For: direct human-to-human communication, not from automated systems
{
  "category": "personal",
  "senderName": "<string or null>",
  "isReply": true | false,
  "threadLength": <number or null>,
  "sentiment": "positive" | "neutral" | "negative" | "urgent",
  "requiresReply": true | false
}

### spam
For: phishing, scams, malware, unsolicited bulk email, fake delivery notices
{
  "category": "spam",
  "spamType": "phishing" | "malware" | "unsolicited_marketing" | "scam" | "other",
  "confidence": 0.0–1.0,
  "indicators": ["<reason1>", "<reason2>"]
}

## Spam and validation rules

Set isValid=false and assign category="spam" when ANY of the following apply:
- Email is clearly phishing (fake domain, urgency + credential request)
- Email contains malicious links or attachments
- Sender domain does not match claimed identity (when verifiable from headers)
- Email is from a known spam pattern
- SPF/DKIM/DMARC authentication failures are present in headers AND content looks suspicious

Set spamScore appropriately for all emails:
- 0.0–0.2: Clearly legitimate
- 0.2–0.5: Somewhat suspicious (bulk unsolicited marketing, tracking-heavy)
- 0.5–0.8: Likely spam
- 0.8–1.0: Definitely spam/phishing

## Priority rules

- urgent: Security alerts, 2FA codes about to expire, interview in <24h, flight today
- high: Invoices due soon, job offers requiring response, crm requiring immediate reply
- normal: Regular business email, standard notifications, newsletters
- low: Marketing, social notifications, newsletters

Be precise. Extract all available structured data. For dates, use ISO format.`;
