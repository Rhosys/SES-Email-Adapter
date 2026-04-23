import { describe, it, expect, vi, beforeEach } from "vitest";
import { SignalClassifier, CLASSIFICATION_MODEL_ID, EMBEDDING_MODEL_ID } from "./classifier.js";
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
  textBody: `Invoice #INV-2024-001\nAmount due: $149.00 USD\nDue date: February 1, 2024`,
  receivedAt: "2024-01-15T09:00:00Z",
  headers: { "authentication-results": "spf=pass dkim=pass" },
};

const recruiterEmail: ClassificationInput = {
  from: "sarah.recruiter@techcorp.com",
  to: ["user@example.com"],
  subject: "Exciting Senior Software Engineer opportunity at TechCorp",
  textBody: `Hi,\n\nSenior Software Engineer role at TechCorp. $180k-$220k in San Francisco.\n\nBest, Sarah`,
  receivedAt: "2024-01-15T14:00:00Z",
  headers: { "authentication-results": "spf=pass dkim=pass" },
};

const phishingEmail: ClassificationInput = {
  from: "security@paypa1.com",
  to: ["user@example.com"],
  subject: "⚠️ URGENT: Your account has been suspended",
  textBody: `Your PayPal account has been suspended. Click: http://paypal-restore.ru/login`,
  receivedAt: "2024-01-15T08:00:00Z",
  headers: { "authentication-results": "spf=fail dkim=fail" },
};

const shippingEmail: ClassificationInput = {
  from: "tracking@amazon.com",
  to: ["user@example.com"],
  subject: "Your package is out for delivery today",
  textBody: `Order #112-3456789\nTracking: 1Z999AA10123456784\nDelivery: Today by 8pm`,
  receivedAt: "2024-01-15T07:00:00Z",
  headers: { "authentication-results": "spf=pass dkim=pass" },
};

// ---------------------------------------------------------------------------
// Bedrock mock
// ---------------------------------------------------------------------------

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  InvokeModelCommand: vi.fn().mockImplementation((params: unknown) => params),
}));

function mockClassifyResponse(raw: object) {
  const body = new TextEncoder().encode(
    JSON.stringify({ content: [{ type: "text", text: JSON.stringify(raw) }] }),
  );
  mockSend.mockResolvedValueOnce({ body });
}

function mockEmbedResponse(embedding: number[]) {
  const body = new TextEncoder().encode(JSON.stringify({ embedding }));
  mockSend.mockResolvedValueOnce({ body });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SignalClassifier", () => {
  let classifier: SignalClassifier;

  beforeEach(() => {
    vi.clearAllMocks();
    classifier = new SignalClassifier();
  });

  // -------------------------------------------------------------------------
  // classify — login / OTP
  // -------------------------------------------------------------------------

  describe("login emails", () => {
    it("classifies a GitHub OTP as login with code extracted", async () => {
      mockClassifyResponse({
        category: "login",
        categoryData: {
          category: "login",
          loginType: "otp",
          code: "483921",
          expiresInMinutes: 15,
          service: "GitHub",
        },
        spamScore: 0.0,
        summary: "GitHub authentication code 483921, expires in 15 minutes.",
        labels: [],
      });

      const result = await classifier.classify(githubOtpEmail);

      expect(result.category).toBe("login");
      expect(result.categoryData).toMatchObject({
        category: "login",
        loginType: "otp",
        code: "483921",
        service: "GitHub",
      });
      expect(result.spamScore).toBeLessThan(0.1);
      expect(result.classificationModelId).toBe(CLASSIFICATION_MODEL_ID);
    });
  });

  // -------------------------------------------------------------------------
  // classify — invoice
  // -------------------------------------------------------------------------

  describe("invoice emails", () => {
    it("extracts amount, vendor, and invoice number from a Stripe receipt", async () => {
      mockClassifyResponse({
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
        },
        spamScore: 0.0,
        summary: "Receipt from Acme Corp for $149.00.",
        labels: ["billing"],
      });

      const result = await classifier.classify(stripeInvoiceEmail);

      expect(result.category).toBe("invoice");
      expect(result.categoryData).toMatchObject({ vendor: "Acme Corp", amount: 149.0 });
      expect(result.labels).toContain("billing");
    });
  });

  // -------------------------------------------------------------------------
  // classify — job
  // -------------------------------------------------------------------------

  describe("job emails", () => {
    it("extracts company, role, and salary from recruiter outreach", async () => {
      mockClassifyResponse({
        category: "job",
        categoryData: {
          category: "job",
          jobType: "recruiter_outreach",
          company: "TechCorp",
          role: "Senior Software Engineer",
          location: "San Francisco",
          salary: "$180k-$220k",
        },
        spamScore: 0.05,
        summary: "Recruiter outreach from TechCorp for Senior Software Engineer, $180k-$220k.",
        labels: ["recruiting"],
      });

      const result = await classifier.classify(recruiterEmail);

      expect(result.category).toBe("job");
      expect(result.categoryData).toMatchObject({ jobType: "recruiter_outreach", company: "TechCorp" });
    });
  });

  // -------------------------------------------------------------------------
  // classify — spam
  // -------------------------------------------------------------------------

  describe("spam detection", () => {
    it("flags phishing email with high spam score", async () => {
      mockClassifyResponse({
        category: "spam",
        categoryData: {
          category: "spam",
          spamType: "phishing",
          confidence: 0.97,
          indicators: [
            "Sender domain paypa1.com impersonates PayPal",
            "SPF and DKIM authentication failures",
            "Suspicious redirect domain (.ru)",
          ],
        },
        spamScore: 0.97,
        summary: "Phishing email impersonating PayPal.",
        labels: [],
      });

      const result = await classifier.classify(phishingEmail);

      expect(result.spamScore).toBeGreaterThan(0.9);
      expect(result.category).toBe("spam");
      if (result.categoryData.category === "spam") {
        expect(result.categoryData.indicators).toContain("Sender domain paypa1.com impersonates PayPal");
      }
    });
  });

  // -------------------------------------------------------------------------
  // classify — shopping
  // -------------------------------------------------------------------------

  describe("shopping emails", () => {
    it("extracts tracking number and retailer from a shipping update", async () => {
      mockClassifyResponse({
        category: "shopping",
        categoryData: {
          category: "shopping",
          shoppingType: "shipping",
          retailer: "Amazon",
          orderNumber: "112-3456789",
          trackingNumber: "1Z999AA10123456784",
          trackingUrl: "https://amazon.com/track/1Z999AA10123456784",
          estimatedDelivery: "2024-01-15",
          items: [],
        },
        spamScore: 0.0,
        summary: "Amazon package out for delivery, tracking 1Z999AA10123456784.",
        labels: [],
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
  // classify — labels
  // -------------------------------------------------------------------------

  describe("label suggestions", () => {
    it("returns suggested labels from the classifier", async () => {
      mockClassifyResponse({
        category: "personal",
        categoryData: { category: "personal", isReply: false, sentiment: "neutral", requiresReply: true },
        spamScore: 0.0,
        summary: "A personal email.",
        labels: ["action-needed", "important"],
      });

      const result = await classifier.classify(githubOtpEmail);

      expect(result.labels).toEqual(["action-needed", "important"]);
    });

    it("returns empty labels array when classifier suggests none", async () => {
      mockClassifyResponse({
        category: "newsletter",
        categoryData: { category: "newsletter", publication: "Test", topics: [] },
        spamScore: 0.1,
        summary: "Newsletter.",
        labels: [],
      });

      const result = await classifier.classify(githubOtpEmail);

      expect(result.labels).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // classify — Bedrock call shape
  // -------------------------------------------------------------------------

  describe("Bedrock call shape", () => {
    it("includes from, subject, and body in the message content", async () => {
      mockClassifyResponse({
        category: "personal",
        categoryData: { category: "personal", isReply: false, sentiment: "neutral", requiresReply: false },
        spamScore: 0.0,
        summary: "A personal email.",
        labels: [],
      });

      await classifier.classify(githubOtpEmail);

      const callArgs = mockSend.mock.calls[0]![0] as { body: Uint8Array };
      const body = JSON.parse(new TextDecoder().decode(callArgs.body)) as {
        messages: Array<{ role: string; content: string }>;
        system: string;
      };

      expect(body.messages[0]?.content).toContain("noreply@github.com");
      expect(body.messages[0]?.content).toContain("Your GitHub launch code");
      expect(body.messages[0]?.content).toContain("483921");
      expect(body.system).toBeTruthy();
    });

    it("uses CLASSIFICATION_MODEL_ID", async () => {
      mockClassifyResponse({
        category: "personal",
        categoryData: { category: "personal", isReply: false, sentiment: "neutral", requiresReply: false },
        spamScore: 0.0,
        summary: "A personal email.",
        labels: [],
      });

      await classifier.classify(githubOtpEmail);

      const callArgs = mockSend.mock.calls[0]![0] as { modelId: string };
      expect(callArgs.modelId).toBe(CLASSIFICATION_MODEL_ID);
    });

    it("truncates long bodies to avoid token overflow", async () => {
      mockClassifyResponse({
        category: "newsletter",
        categoryData: { category: "newsletter", publication: "Test", topics: [] },
        spamScore: 0.1,
        summary: "Newsletter.",
        labels: [],
      });

      await classifier.classify({ ...githubOtpEmail, textBody: "x".repeat(10_000) });

      const callArgs = mockSend.mock.calls[0]![0] as { body: Uint8Array };
      const body = JSON.parse(new TextDecoder().decode(callArgs.body)) as {
        messages: Array<{ content: string }>;
      };
      expect(body.messages[0]?.content.length).toBeLessThan(6000);
      expect(body.messages[0]?.content).toContain("[... truncated]");
    });
  });

  // -------------------------------------------------------------------------
  // embed
  // -------------------------------------------------------------------------

  describe("embed", () => {
    it("returns an embedding vector from Titan", async () => {
      const embedding = Array.from({ length: 1024 }, (_, i) => i / 1024);
      mockEmbedResponse(embedding);

      const result = await classifier.embed("Hello world email content");

      expect(result).toHaveLength(1024);
    });

    it("uses EMBEDDING_MODEL_ID", async () => {
      mockEmbedResponse(new Array(1024).fill(0.1));

      await classifier.embed("test");

      const callArgs = mockSend.mock.calls[0]![0] as { modelId: string };
      expect(callArgs.modelId).toBe(EMBEDDING_MODEL_ID);
    });

    it("truncates text to 8000 characters before embedding", async () => {
      mockEmbedResponse(new Array(1024).fill(0.1));

      await classifier.embed("x".repeat(10_000));

      const callArgs = mockSend.mock.calls[0]![0] as { body: Uint8Array };
      const body = JSON.parse(new TextDecoder().decode(callArgs.body)) as { inputText: string };
      expect(body.inputText.length).toBe(8000);
    });
  });
});
