import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmailClassifier } from "./classifier.js";
import type { ClassificationInput } from "./classifier.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const githubOtpEmail: ClassificationInput = {
  from: "noreply@github.com",
  to: ["user@example.com"],
  subject: "Your GitHub launch code",
  textBody: "Your authentication code is 483921. This code will expire in 15 minutes.",
  receivedAt: "2024-01-15T10:30:00Z",
  headers: {
    "authentication-results": "spf=pass dkim=pass dmarc=pass",
    "dkim-signature": "v=1; a=rsa-sha256; d=github.com",
  },
};

const stripeInvoiceEmail: ClassificationInput = {
  from: "receipts+abc123@stripe.com",
  to: ["user@example.com"],
  subject: "Your receipt from Acme Corp",
  textBody: `Invoice #INV-2024-001
Amount due: $149.00 USD
Due date: February 1, 2024

Thank you for your payment.`,
  receivedAt: "2024-01-15T09:00:00Z",
  headers: { "authentication-results": "spf=pass dkim=pass" },
};

const recruiterEmail: ClassificationInput = {
  from: "sarah.recruiter@techcorp.com",
  to: ["user@example.com"],
  subject: "Exciting Senior Software Engineer opportunity at TechCorp",
  textBody: `Hi,

I came across your profile and wanted to reach out about a Senior Software Engineer
role at TechCorp. The position offers $180k-$220k base salary in San Francisco.

Would you be open to a 30-minute call this week?

Best,
Sarah`,
  receivedAt: "2024-01-15T14:00:00Z",
  headers: { "authentication-results": "spf=pass dkim=pass" },
};

const phishingEmail: ClassificationInput = {
  from: "security@paypa1.com",
  to: ["user@example.com"],
  subject: "⚠️ URGENT: Your account has been suspended",
  textBody: `Your PayPal account has been suspended due to suspicious activity.
Click here immediately to restore access: http://paypal-restore-account.ru/login
Enter your username and password to verify your identity.`,
  receivedAt: "2024-01-15T08:00:00Z",
  headers: { "authentication-results": "spf=fail dkim=fail" },
};

const shippingEmail: ClassificationInput = {
  from: "tracking@amazon.com",
  to: ["user@example.com"],
  subject: "Your package is out for delivery today",
  textBody: `Your order has shipped!
Order #112-3456789-0000001
Tracking: 1Z999AA10123456784
Estimated delivery: Today by 8pm
Track package: https://amazon.com/track/1Z999AA10123456784`,
  receivedAt: "2024-01-15T07:00:00Z",
  headers: { "authentication-results": "spf=pass dkim=pass" },
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@anthropic-ai/sdk", () => {
  const mockParse = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { parse: mockParse },
    })),
    __mockParse: mockParse,
  };
});

function getMockParse() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("@anthropic-ai/sdk") as { __mockParse: ReturnType<typeof vi.fn> }).__mockParse;
}

function mockClaudeResponse(raw: object) {
  getMockParse().mockResolvedValueOnce({ parsed_output: raw });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EmailClassifier", () => {
  let classifier: EmailClassifier;

  beforeEach(() => {
    vi.clearAllMocks();
    classifier = new EmailClassifier("test-api-key");
  });

  // -------------------------------------------------------------------------
  // Login / OTP
  // -------------------------------------------------------------------------

  describe("login emails", () => {
    it("classifies a GitHub OTP as login with code extracted", async () => {
      mockClaudeResponse({
        category: "login",
        categoryData: {
          category: "login",
          loginType: "otp",
          code: "483921",
          expiresInMinutes: 15,
          service: "GitHub",
          actionUrl: null,
        },
        spamScore: 0.0,
        isValid: true,
        summary: "GitHub authentication code 483921, expires in 15 minutes.",
        priority: "urgent",
        failedChecks: [],
      });

      const result = await classifier.classify(githubOtpEmail);

      expect(result.category).toBe("login");
      expect(result.categoryData).toMatchObject({
        category: "login",
        loginType: "otp",
        code: "483921",
        expiresInMinutes: 15,
        service: "GitHub",
      });
      expect(result.priority).toBe("urgent");
      expect(result.spamScore).toBeLessThan(0.1);
      expect(result.isValid).toBe(true);
    });

    it("marks OTP emails as urgent priority", async () => {
      mockClaudeResponse({
        category: "login",
        categoryData: { category: "login", loginType: "otp", code: "123456", service: "Slack", expiresInMinutes: 5 },
        spamScore: 0.0,
        isValid: true,
        summary: "Slack OTP code.",
        priority: "urgent",
        failedChecks: [],
      });

      const result = await classifier.classify({
        ...githubOtpEmail,
        from: "noreply@slack.com",
        subject: "Your Slack verification code: 123456",
      });

      expect(result.priority).toBe("urgent");
    });
  });

  // -------------------------------------------------------------------------
  // Invoice
  // -------------------------------------------------------------------------

  describe("invoice emails", () => {
    it("classifies a Stripe receipt and extracts amount and invoice number", async () => {
      mockClaudeResponse({
        category: "invoice",
        categoryData: {
          category: "invoice",
          invoiceType: "receipt",
          vendor: "Acme Corp",
          amount: 149.0,
          currency: "USD",
          invoiceNumber: "INV-2024-001",
          dueDate: "2024-02-01",
          lineItems: [],
          downloadUrl: null,
        },
        spamScore: 0.0,
        isValid: true,
        summary: "Receipt from Acme Corp for $149.00 USD, invoice INV-2024-001.",
        priority: "normal",
        failedChecks: [],
      });

      const result = await classifier.classify(stripeInvoiceEmail);

      expect(result.category).toBe("invoice");
      expect(result.categoryData).toMatchObject({
        vendor: "Acme Corp",
        amount: 149.0,
        currency: "USD",
        invoiceNumber: "INV-2024-001",
      });
      expect(result.isValid).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Job / recruiting
  // -------------------------------------------------------------------------

  describe("job emails", () => {
    it("classifies recruiter outreach and extracts company, role and salary", async () => {
      mockClaudeResponse({
        category: "job",
        categoryData: {
          category: "job",
          jobType: "recruiter_outreach",
          company: "TechCorp",
          role: "Senior Software Engineer",
          location: "San Francisco",
          salary: "$180k-$220k",
          interviewDate: null,
          applicationStatus: null,
          actionUrl: null,
        },
        spamScore: 0.05,
        isValid: true,
        summary: "Recruiter outreach from TechCorp for Senior Software Engineer, $180k-$220k in San Francisco.",
        priority: "normal",
        failedChecks: [],
      });

      const result = await classifier.classify(recruiterEmail);

      expect(result.category).toBe("job");
      expect(result.categoryData).toMatchObject({
        jobType: "recruiter_outreach",
        company: "TechCorp",
        salary: "$180k-$220k",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Spam / phishing
  // -------------------------------------------------------------------------

  describe("spam detection", () => {
    it("flags phishing email as invalid with high spam score", async () => {
      mockClaudeResponse({
        category: "spam",
        categoryData: {
          category: "spam",
          spamType: "phishing",
          confidence: 0.97,
          indicators: [
            "Sender domain paypa1.com impersonates PayPal",
            "SPF and DKIM authentication failures",
            "Urgency language with credential request",
            "Suspicious redirect domain (.ru)",
          ],
        },
        spamScore: 0.97,
        isValid: false,
        summary: "Phishing email impersonating PayPal requesting credentials.",
        priority: "low",
        failedChecks: [
          { check: "spf_dkim_alignment", reason: "SPF and DKIM both failed" },
          { check: "domain_impersonation", reason: "paypa1.com impersonates paypal.com" },
        ],
      });

      const result = await classifier.classify(phishingEmail);

      expect(result.isValid).toBe(false);
      expect(result.spamScore).toBeGreaterThan(0.9);
      expect(result.category).toBe("spam");
      expect(result.validationResult.failedChecks).toHaveLength(2);
      if (result.categoryData.category === "spam") {
        expect(result.categoryData.indicators).toContain("Sender domain paypa1.com impersonates PayPal");
      }
    });

    it("returns failedChecks populated from validation failures", async () => {
      mockClaudeResponse({
        category: "spam",
        categoryData: { category: "spam", spamType: "phishing", confidence: 0.9, indicators: ["test"] },
        spamScore: 0.9,
        isValid: false,
        summary: "Spam.",
        priority: "low",
        failedChecks: [
          { check: "domain_mismatch", reason: "Domain does not match claimed sender" },
        ],
      });

      const result = await classifier.classify(phishingEmail);

      expect(result.validationResult.isValid).toBe(false);
      expect(result.validationResult.failedChecks[0]).toMatchObject({
        name: "domain_mismatch",
        passed: false,
        detail: "Domain does not match claimed sender",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Shopping
  // -------------------------------------------------------------------------

  describe("shopping emails", () => {
    it("classifies shipping update and extracts tracking info", async () => {
      mockClaudeResponse({
        category: "shopping",
        categoryData: {
          category: "shopping",
          shoppingType: "shipping",
          retailer: "Amazon",
          orderNumber: "112-3456789-0000001",
          trackingNumber: "1Z999AA10123456784",
          trackingUrl: "https://amazon.com/track/1Z999AA10123456784",
          estimatedDelivery: "2024-01-15",
          items: [],
          totalAmount: null,
          currency: null,
        },
        spamScore: 0.0,
        isValid: true,
        summary: "Amazon package out for delivery today, tracking 1Z999AA10123456784.",
        priority: "normal",
        failedChecks: [],
      });

      const result = await classifier.classify(shippingEmail);

      expect(result.category).toBe("shopping");
      expect(result.categoryData).toMatchObject({
        shoppingType: "shipping",
        retailer: "Amazon",
        trackingNumber: "1Z999AA10123456784",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Claude API integration
  // -------------------------------------------------------------------------

  describe("API call shape", () => {
    it("sends email content including from, subject and body to Claude", async () => {
      mockClaudeResponse({
        category: "personal",
        categoryData: { category: "personal", isReply: false, sentiment: "neutral", requiresReply: false },
        spamScore: 0.0,
        isValid: true,
        summary: "A personal email.",
        priority: "normal",
        failedChecks: [],
      });

      await classifier.classify(githubOtpEmail);

      const mockParse = getMockParse();
      const callArgs = mockParse.mock.calls[0][0] as {
        messages: Array<{ role: string; content: string }>;
        system: Array<{ type: string; text: string }>;
      };

      const userContent = callArgs.messages[0]?.content as string;
      expect(userContent).toContain("noreply@github.com");
      expect(userContent).toContain("Your GitHub launch code");
      expect(userContent).toContain("483921");

      // System prompt must be present and cached
      expect(callArgs.system[0]).toMatchObject({
        type: "text",
        cache_control: { type: "ephemeral" },
      });
    });

    it("uses claude-opus-4-7 model", async () => {
      mockClaudeResponse({
        category: "personal",
        categoryData: { category: "personal", isReply: false, sentiment: "neutral", requiresReply: false },
        spamScore: 0.0,
        isValid: true,
        summary: "A personal email.",
        priority: "normal",
        failedChecks: [],
      });

      await classifier.classify(githubOtpEmail);

      const callArgs = getMockParse().mock.calls[0][0] as { model: string };
      expect(callArgs.model).toBe("claude-opus-4-7");
    });

    it("enables adaptive thinking", async () => {
      mockClaudeResponse({
        category: "personal",
        categoryData: { category: "personal", isReply: false, sentiment: "neutral", requiresReply: false },
        spamScore: 0.0,
        isValid: true,
        summary: "A personal email.",
        priority: "normal",
        failedChecks: [],
      });

      await classifier.classify(githubOtpEmail);

      const callArgs = getMockParse().mock.calls[0][0] as { thinking: { type: string } };
      expect(callArgs.thinking).toMatchObject({ type: "adaptive" });
    });

    it("truncates very long email bodies to avoid token overflow", async () => {
      mockClaudeResponse({
        category: "newsletter",
        categoryData: { category: "newsletter", publication: "Test", topics: [], frequency: null, unsubscribeUrl: null },
        spamScore: 0.1,
        isValid: true,
        summary: "Newsletter.",
        priority: "low",
        failedChecks: [],
      });

      const longBody = "x".repeat(10_000);
      await classifier.classify({ ...githubOtpEmail, textBody: longBody });

      const callArgs = getMockParse().mock.calls[0][0] as {
        messages: Array<{ role: string; content: string }>;
      };
      const content = callArgs.messages[0]?.content as string;
      expect(content.length).toBeLessThan(6000);
      expect(content).toContain("[... truncated]");
    });
  });
});
