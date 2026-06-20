import { describe, it, expect, vi, beforeEach } from "vitest";
import { SignalClassifier, CLASSIFICATION_MODEL_ID } from "../../src/classifier/classifier.js";
import type { ClassificationInput } from "../../src/classifier/classifier.js";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { createMockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const githubOtpEmail: ClassificationInput = {
  from: "noreply@github.com",
  to: ["user@example.com"],
  subject: "Your GitHub launch code",
  body: "Your authentication code is 483921. This code will expire in 15 minutes.",
  receivedAt: "2024-01-15T10:30:00Z",
  headers: {
    "authentication-results": "spf=pass dkim=pass dmarc=pass",
    "dkim-signature": "v=1; a=rsa-sha256; d=github.com",
  },
  allowedLabels: [],
};

const stripeInvoiceEmail: ClassificationInput = {
  from: "receipts+abc123@stripe.com",
  to: ["user@example.com"],
  subject: "Your receipt from Acme Corp",
  body: `Invoice #INV-2024-001\nAmount due: $149.00 USD\nDue date: February 1, 2024`,
  receivedAt: "2024-01-15T09:00:00Z",
  headers: { "authentication-results": "spf=pass dkim=pass" },
  allowedLabels: ["billing"],
};

const recruiterEmail: ClassificationInput = {
  from: "sarah.recruiter@techcorp.com",
  to: ["user@example.com"],
  subject: "Exciting Senior Software Engineer opportunity at TechCorp",
  body: `Hi,\n\nSenior Software Engineer role at TechCorp. $180k-$220k in San Francisco.\n\nBest, Sarah`,
  receivedAt: "2024-01-15T14:00:00Z",
  headers: { "authentication-results": "spf=pass dkim=pass" },
  allowedLabels: ["recruiting"],
};

const phishingEmail: ClassificationInput = {
  from: "security@paypa1.com",
  to: ["user@example.com"],
  subject: "⚠️ URGENT: Your account has been suspended",
  body: `Your PayPal account has been suspended. Click: http://paypal-restore.ru/login`,
  receivedAt: "2024-01-15T08:00:00Z",
  headers: { "authentication-results": "spf=fail dkim=fail" },
  allowedLabels: [],
};

const shippingEmail: ClassificationInput = {
  from: "tracking@amazon.com",
  to: ["user@example.com"],
  subject: "Your package is out for delivery today",
  body: `Order #112-3456789\nTracking: 1Z999AA10123456784\nDelivery: Today by 8pm`,
  receivedAt: "2024-01-15T07:00:00Z",
  headers: { "authentication-results": "spf=pass dkim=pass" },
  allowedLabels: [],
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
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(raw) } }] }),
  );
  mockSend.mockResolvedValueOnce({ body });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SignalClassifier", () => {
  let classifier: SignalClassifier;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
    classifier = new SignalClassifier(new BedrockRuntimeClient({}), logger);
  });

  // -------------------------------------------------------------------------
  // classify — auth / OTP
  // -------------------------------------------------------------------------

  describe("login emails", () => {
    it("classifies a GitHub OTP as login with code extracted", async () => {
      mockClassifyResponse({
        workflow: "auth",
        workflowData: {
          workflow: "auth",
          authType: "otp",
          code: "483921",
          expiresInMinutes: 15,
          service: "GitHub",
        },
        tags: [],
        summary: "GitHub authentication code 483921, expires in 15 minutes.",
        labels: [],
      });

      const result = await classifier.classify(githubOtpEmail);

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("auth");
      expect(output.workflowData).toMatchObject({
        workflow: "auth",
        authType: "otp",
        code: "483921",
        service: "GitHub",
      });
      expect(output.tags).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // classify — invoice
  // -------------------------------------------------------------------------

  describe("payments emails", () => {
    it("extracts amount, vendor, and invoice number from a Stripe receipt", async () => {
      mockClassifyResponse({
        workflow: "payments",
        workflowData: {
          workflow: "payments",
          paymentType: "receipt",
          vendor: "Acme Corp",
          amount: 149.0,
          currency: "USD",
          invoiceNumber: "INV-2024-001",
          dueDate: "2024-02-01",
        },
        tags: [],
        summary: "Receipt from Acme Corp for $149.00.",
        labels: ["billing"],
      });

      const result = await classifier.classify(stripeInvoiceEmail);

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("payments");
      expect(output.workflowData).toMatchObject({ vendor: "Acme Corp", amount: 149.0 });
      expect(output.labels).toContain("billing");
    });
  });

  // -------------------------------------------------------------------------
  // classify — job
  // -------------------------------------------------------------------------

  describe("job emails", () => {
    it("extracts company, role, and salary from recruiter outreach", async () => {
      mockClassifyResponse({
        workflow: "job",
        workflowData: {
          workflow: "job",
          jobType: "recruiter_outreach",
          company: "TechCorp",
          role: "Senior Software Engineer",
          location: "San Francisco",
          salary: "$180k-$220k",
        },
        tags: [],
        summary: "Recruiter outreach from TechCorp for Senior Software Engineer, $180k-$220k.",
        labels: ["recruiting"],
      });

      const result = await classifier.classify(recruiterEmail);

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("job");
      expect(output.workflowData).toMatchObject({ jobType: "recruiter_outreach", company: "TechCorp" });
    });
  });

  // -------------------------------------------------------------------------
  // classify — spam
  // -------------------------------------------------------------------------

  describe("spam detection", () => {
    it("flags phishing email with tags (auth workflow)", async () => {
      mockClassifyResponse({
        workflow: "auth",
        workflowData: {
          workflow: "auth",
          authType: "other",
          code: null,
          expiresInMinutes: null,
          service: "PayPal",
          actionUrl: "http://paypal-restore.ru/login",
        },
        tags: ["phishing"],
        summary: "Phishing email impersonating PayPal login.",
        labels: ["phishing"],
      });

      const result = await classifier.classify(phishingEmail);

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.tags).toContain("phishing");
      expect(output.workflow).toBe("auth");
    });
  });

  // -------------------------------------------------------------------------
  // classify — order (shipping update)
  // -------------------------------------------------------------------------

  describe("package emails", () => {
    it("extracts tracking number and retailer from a shipping update", async () => {
      mockClassifyResponse({
        workflow: "package",
        workflowData: {
          workflow: "package",
          packageType: "shipping",
          retailer: "Amazon",
          orderNumber: "112-3456789",
          trackingNumber: "1Z999AA10123456784",
          trackingUrl: "https://amazon.com/track/1Z999AA10123456784",
          estimatedDelivery: "2024-01-15",
        },
        tags: [],
        summary: "Amazon package out for delivery, tracking 1Z999AA10123456784.",
        labels: [],
      });

      const result = await classifier.classify(shippingEmail);

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("package");
      expect(output.workflowData).toMatchObject({
        packageType: "shipping",
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
        workflow: "conversation",
        workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: true },
        tags: [],
        summary: "A personal email.",
        labels: ["action-needed", "important"],
      });

      const result = await classifier.classify(githubOtpEmail);

      expect(result.isOk()).toBe(true);
      // allowedLabels is [] so all labels get filtered out
      expect(result._unsafeUnwrap().labels).toEqual([]);
    });

    it("returns empty labels array when classifier suggests none", async () => {
      mockClassifyResponse({
        workflow: "content",
        workflowData: { workflow: "content", publisher: "Test" },
        tags: [],
        summary: "Newsletter.",
        labels: [],
      });

      const result = await classifier.classify(githubOtpEmail);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().labels).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // classify — Bedrock call shape
  // -------------------------------------------------------------------------

  describe("Bedrock call shape", () => {
    it("includes from, subject, and body in the message content", async () => {
      mockClassifyResponse({
        workflow: "conversation",
        workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
        tags: [],
        summary: "A personal email.",
        labels: [],
      });

      await classifier.classify(githubOtpEmail);

      const callArgs = mockSend.mock.calls[0]![0] as { body: Uint8Array };
      const body = JSON.parse(new TextDecoder().decode(callArgs.body)) as {
        messages: Array<{ role: string; content: string }>;
      };

      expect(body.messages[1]?.content).toContain("noreply@github.com");
      expect(body.messages[1]?.content).toContain("Your GitHub launch code");
      expect(body.messages[1]?.content).toContain("483921");
      expect(body.messages[0]?.role).toBe("system");
    });

    it("uses CLASSIFICATION_MODEL_ID", async () => {
      mockClassifyResponse({
        workflow: "conversation",
        workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
        tags: [],
        summary: "A personal email.",
        labels: [],
      });

      await classifier.classify(githubOtpEmail);

      const callArgs = mockSend.mock.calls[0]![0] as { modelId: string };
      expect(callArgs.modelId).toBe(CLASSIFICATION_MODEL_ID);
    });

    it("truncates long bodies to avoid token overflow", async () => {
      mockClassifyResponse({
        workflow: "content",
        workflowData: { workflow: "content", publisher: "Test" },
        tags: [],
        summary: "Newsletter.",
        labels: [],
      });

      await classifier.classify({ ...githubOtpEmail, body: "x".repeat(10_000) });

      const callArgs = mockSend.mock.calls[0]![0] as { body: Uint8Array };
      const body = JSON.parse(new TextDecoder().decode(callArgs.body)) as {
        messages: Array<{ content: string }>;
      };
      expect(body.messages[1]?.content.length).toBeLessThan(6000);
      expect(body.messages[1]?.content).toContain("[... truncated]");
    });
  });

  // -------------------------------------------------------------------------
  // classify — content formatting (HTML stripping, header filtering, truncation)
  // -------------------------------------------------------------------------

  describe("content formatting", () => {
    it("passes body content through to the Bedrock message", async () => {
      mockClassifyResponse({
        workflow: "conversation",
        workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
        tags: [],
        summary: "Email.",
        labels: [],
      });

      await classifier.classify({
        from: "noreply@service.com",
        to: ["user@example.com"],
        subject: "HTML only",
        body: "Important content with links and inline.",
        receivedAt: "2024-01-15T10:00:00Z",
        headers: {},
        allowedLabels: [],
      });

      const callArgs = mockSend.mock.calls[0]![0] as { body: Uint8Array };
      const payload = JSON.parse(new TextDecoder().decode(callArgs.body)) as { messages: Array<{ content: string }> };
      const content = payload.messages[1]!.content;
      expect(content).toContain("Important content with links");
    });

    it("includes all provided headers in the Bedrock message (caller pre-filters)", async () => {
      mockClassifyResponse({
        workflow: "conversation",
        workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
        tags: [],
        summary: "Email.",
        labels: [],
      });

      await classifier.classify({
        from: "noreply@service.com",
        to: ["user@example.com"],
        subject: "Header test",
        body: "body",
        receivedAt: "2024-01-15T10:00:00Z",
        headers: {
          "authentication-results": "spf=pass",
          "received-spf": "pass",
        },
        allowedLabels: [],
      });

      const callArgs = mockSend.mock.calls[0]![0] as { body: Uint8Array };
      const payload = JSON.parse(new TextDecoder().decode(callArgs.body)) as { messages: Array<{ content: string }> };
      const content = payload.messages[1]!.content;
      expect(content).toContain("authentication-results");
      expect(content).toContain("received-spf");
    });

    it("truncates body longer than 4000 characters and appends truncation marker", async () => {
      mockClassifyResponse({
        workflow: "content",
        workflowData: { workflow: "content", publisher: "Test" },
        tags: [],
        summary: "Newsletter.",
        labels: [],
      });

      await classifier.classify({
        from: "newsletter@service.com",
        to: ["user@example.com"],
        subject: "Long body",
        body: "x".repeat(4001),
        receivedAt: "2024-01-15T10:00:00Z",
        headers: {},
        allowedLabels: [],
      });

      const callArgs = mockSend.mock.calls[0]![0] as { body: Uint8Array };
      const payload = JSON.parse(new TextDecoder().decode(callArgs.body)) as { messages: Array<{ content: string }> };
      expect(payload.messages[1]!.content).toContain("[... truncated]");
    });

    it("does not truncate body of exactly 4000 characters", async () => {
      mockClassifyResponse({
        workflow: "content",
        workflowData: { workflow: "content", publisher: "Test" },
        tags: [],
        summary: "Newsletter.",
        labels: [],
      });

      await classifier.classify({
        from: "newsletter@service.com",
        to: ["user@example.com"],
        subject: "Exact length body",
        body: "y".repeat(4000),
        receivedAt: "2024-01-15T10:00:00Z",
        headers: {},
        allowedLabels: [],
      });

      const callArgs = mockSend.mock.calls[0]![0] as { body: Uint8Array };
      const payload = JSON.parse(new TextDecoder().decode(callArgs.body)) as { messages: Array<{ content: string }> };
      expect(payload.messages[1]!.content).not.toContain("[... truncated]");
    });

    it("returns err when Bedrock returns non-JSON text content", async () => {
      const malformed = new TextEncoder().encode(
        JSON.stringify({ content: [{ type: "text", text: "not valid json {{{{" }] }),
      );
      mockSend.mockResolvedValueOnce({ body: malformed });

      const result = await classifier.classify(githubOtpEmail);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("classification_error");
    });

    it("preserves emoji and unicode characters in the Bedrock message content", async () => {
      mockClassifyResponse({
        workflow: "conversation",
        workflowData: { workflow: "conversation", isReply: false, sentiment: "positive", requiresReply: false },
        tags: [],
        summary: "Personal email.",
        labels: [],
      });

      await classifier.classify({
        from: "friend@example.com",
        to: ["user@example.com"],
        subject: "Hello 👋 from Tokyo 🗼",
        body: "希望你一切都好！😊",
        receivedAt: "2024-01-15T10:00:00Z",
        headers: {},
        allowedLabels: [],
      });

      const callArgs = mockSend.mock.calls[0]![0] as { body: Uint8Array };
      const payload = JSON.parse(new TextDecoder().decode(callArgs.body)) as { messages: Array<{ content: string }> };
      const content = payload.messages[1]!.content;
      expect(content).toContain("Hello 👋 from Tokyo 🗼");
      expect(content).toContain("希望你一切都好！😊");
    });
  });

  // -------------------------------------------------------------------------
  // classify — additional workflow coverage
  // -------------------------------------------------------------------------

  describe("alert emails — fraud", () => {
    it("extracts service, amount, and alertType from a fraud alert", async () => {
      mockClassifyResponse({
        workflow: "alert",
        workflowData: {
          workflow: "alert",
          alertType: "fraud_alert",
          service: "Chase Bank",
          severity: "critical",
          requiresAction: true,
          accountLastFour: "4242",
        },
        tags: [],
        summary: "Fraud alert from Chase Bank — unusual $2,499.99 charge.",
        labels: ["urgent", "action-needed"],
      });

      const result = await classifier.classify({
        from: "alerts@chase.com",
        to: ["user@example.com"],
        subject: "Unusual activity on your Chase account",
        body: "We noticed a $2,499.99 charge at an unknown merchant. If this wasn't you, call us.",
        receivedAt: "2024-01-15T08:00:00Z",
        headers: { "authentication-results": "spf=pass dkim=pass" },
        allowedLabels: ["urgent", "action-needed"],
      });

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("alert");
      expect(output.workflowData).toMatchObject({ alertType: "fraud_alert", requiresAction: true });
      expect(output.labels).toContain("urgent");
    });
  });

  describe("travel emails", () => {
    it("extracts provider, confirmation number, and departure date from a flight booking", async () => {
      mockClassifyResponse({
        workflow: "travel",
        workflowData: {
          workflow: "travel",
          travelType: "flight",
          provider: "Delta Airlines",
          confirmationNumber: "DELTA123",
          departureDate: "2024-03-15",
          returnDate: "2024-03-22",
          origin: "JFK",
          destination: "LHR",
          passengerName: "John Doe",
          totalAmount: 850.0,
          currency: "USD",
        },
        tags: [],
        summary: "Delta Airlines flight JFK → LHR departing March 15. Confirmation: DELTA123.",
        labels: [],
      });

      const result = await classifier.classify({
        from: "confirmation@delta.com",
        to: ["user@example.com"],
        subject: "Your flight confirmation DELTA123",
        body: "Flight JFK → LHR on March 15. Confirmation: DELTA123.",
        receivedAt: "2024-01-15T12:00:00Z",
        headers: { "authentication-results": "spf=pass dkim=pass" },
        allowedLabels: [],
      });

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("travel");
      expect(output.workflowData).toMatchObject({
        travelType: "flight",
        provider: "Delta Airlines",
        confirmationNumber: "DELTA123",
        departureDate: "2024-03-15",
      });
    });
  });

  describe("security emails", () => {
    it("extracts alertType and requiresAction from a suspicious login alert", async () => {
      mockClassifyResponse({
        workflow: "alert",
        workflowData: {
          workflow: "alert",
          alertType: "suspicious_login",
          service: "GitHub",
          ipAddress: "203.0.113.42",
          location: "Moscow, Russia",
          deviceName: null,
          requiresAction: true,
          actionUrl: "https://github.com/settings/security",
        },
        tags: [],
        summary: "GitHub detected a suspicious login from Moscow, Russia. Action required.",
        labels: ["action-needed", "urgent"],
      });

      const result = await classifier.classify({
        from: "security@github.com",
        to: ["user@example.com"],
        subject: "Suspicious sign-in attempt on your GitHub account",
        body: "We detected a login from 203.0.113.42 in Moscow, Russia. Was this you?",
        receivedAt: "2024-01-15T03:00:00Z",
        headers: { "authentication-results": "spf=pass dkim=pass" },
        allowedLabels: ["action-needed", "urgent"],
      });

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("alert");
      expect(output.workflowData).toMatchObject({ alertType: "suspicious_login", requiresAction: true });
      expect(output.tags).toEqual([]); // legitimate alert from github.com
    });
  });

  describe("test workflow", () => {
    it("classifies unambiguous test content as the test workflow", async () => {
      mockClassifyResponse({
        workflow: "test",
        workflowData: { workflow: "test", triggeredBy: "user" },
        tags: [],
        summary: "User sent a test email to verify inbox delivery.",
        labels: [],
      });

      const result = await classifier.classify({
        from: "me@mydomain.com",
        to: ["me@mydomain.com"],
        subject: "test",
        body: "testing 123",
        receivedAt: "2024-01-15T10:00:00Z",
        headers: {},
        allowedLabels: [],
      });

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("test");
      expect(output.workflowData).toMatchObject({ triggeredBy: "user" });
      expect(output.tags).toEqual([]);
    });
  });
});
