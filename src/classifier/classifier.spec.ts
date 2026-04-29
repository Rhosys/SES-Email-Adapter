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
        spamScore: 0.0,
        summary: "GitHub authentication code 483921, expires in 15 minutes.",
        labels: [],
      });

      const result = await classifier.classify(githubOtpEmail);

      expect(result.workflow).toBe("auth");
      expect(result.workflowData).toMatchObject({
        workflow: "auth",
        authType: "otp",
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
        workflow: "invoice",
        workflowData: {
          workflow: "invoice",
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

      expect(result.workflow).toBe("invoice");
      expect(result.workflowData).toMatchObject({ vendor: "Acme Corp", amount: 149.0 });
      expect(result.labels).toContain("billing");
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
        spamScore: 0.05,
        summary: "Recruiter outreach from TechCorp for Senior Software Engineer, $180k-$220k.",
        labels: ["recruiting"],
      });

      const result = await classifier.classify(recruiterEmail);

      expect(result.workflow).toBe("job");
      expect(result.workflowData).toMatchObject({ jobType: "recruiter_outreach", company: "TechCorp" });
    });
  });

  // -------------------------------------------------------------------------
  // classify — spam
  // -------------------------------------------------------------------------

  describe("spam detection", () => {
    it("flags phishing email with high spam score (auth workflow, high spamScore)", async () => {
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
        spamScore: 0.97,
        summary: "Phishing email impersonating PayPal login.",
        labels: ["phishing"],
      });

      const result = await classifier.classify(phishingEmail);

      expect(result.spamScore).toBeGreaterThan(0.9);
      expect(result.workflow).toBe("auth");
    });
  });

  // -------------------------------------------------------------------------
  // classify — order (shipping update)
  // -------------------------------------------------------------------------

  describe("shopping emails", () => {
    it("extracts tracking number and retailer from a shipping update", async () => {
      mockClassifyResponse({
        workflow: "order",
        workflowData: {
          workflow: "order",
          orderType: "shipping",
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

      expect(result.workflow).toBe("order");
      expect(result.workflowData).toMatchObject({
        orderType: "shipping",
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
        workflow: "personal",
        workflowData: { workflow: "personal", isReply: false, sentiment: "neutral", requiresReply: true },
        spamScore: 0.0,
        summary: "A personal email.",
        labels: ["action-needed", "important"],
      });

      const result = await classifier.classify(githubOtpEmail);

      expect(result.labels).toEqual(["action-needed", "important"]);
    });

    it("returns empty labels array when classifier suggests none", async () => {
      mockClassifyResponse({
        workflow: "newsletter",
        workflowData: { workflow: "newsletter", publication: "Test", topics: [] },
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
        workflow: "personal",
        workflowData: { workflow: "personal", isReply: false, sentiment: "neutral", requiresReply: false },
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
        workflow: "personal",
        workflowData: { workflow: "personal", isReply: false, sentiment: "neutral", requiresReply: false },
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
        workflow: "newsletter",
        workflowData: { workflow: "newsletter", publication: "Test", topics: [] },
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

  // -------------------------------------------------------------------------
  // classify — content formatting (HTML stripping, header filtering, truncation)
  // -------------------------------------------------------------------------

  describe("content formatting", () => {
    it("uses stripped HTML body when textBody is absent", async () => {
      mockClassifyResponse({
        workflow: "personal",
        workflowData: { workflow: "personal", isReply: false, sentiment: "neutral", requiresReply: false },
        spamScore: 0.0,
        summary: "Email.",
        labels: [],
      });

      await classifier.classify({
        from: "noreply@service.com",
        to: ["user@example.com"],
        subject: "HTML only",
        htmlBody: "<p><b>Important</b> content with <a href='#'>links</a> and <script>evil()</script> inline.</p>",
        receivedAt: "2024-01-15T10:00:00Z",
        headers: {},
      });

      const callArgs = mockSend.mock.calls[0]![0] as { body: Uint8Array };
      const payload = JSON.parse(new TextDecoder().decode(callArgs.body)) as { messages: Array<{ content: string }> };
      const content = payload.messages[0]!.content;
      expect(content).toContain("Important content with links");
      expect(content).not.toContain("<b>");
      expect(content).not.toContain("<script>");
      expect(content).not.toContain("evil()");
    });

    it("includes only RELEVANT_HEADERS in the Bedrock message — irrelevant headers are stripped", async () => {
      mockClassifyResponse({
        workflow: "personal",
        workflowData: { workflow: "personal", isReply: false, sentiment: "neutral", requiresReply: false },
        spamScore: 0.0,
        summary: "Email.",
        labels: [],
      });

      await classifier.classify({
        from: "noreply@service.com",
        to: ["user@example.com"],
        subject: "Header test",
        textBody: "body",
        receivedAt: "2024-01-15T10:00:00Z",
        headers: {
          "dkim-signature": "v=1; keep_me",      // relevant
          "authentication-results": "spf=pass",  // relevant
          "x-custom-crm-id": "abc123",           // not relevant
          "user-agent": "Mozilla/5.0",           // not relevant
        },
      });

      const callArgs = mockSend.mock.calls[0]![0] as { body: Uint8Array };
      const payload = JSON.parse(new TextDecoder().decode(callArgs.body)) as { messages: Array<{ content: string }> };
      const content = payload.messages[0]!.content;
      expect(content).toContain("dkim-signature");
      expect(content).toContain("authentication-results");
      expect(content).not.toContain("x-custom-crm-id");
      expect(content).not.toContain("user-agent");
    });

    it("truncates body longer than 4000 characters and appends truncation marker", async () => {
      mockClassifyResponse({
        workflow: "newsletter",
        workflowData: { workflow: "newsletter", publication: "Test", topics: [] },
        spamScore: 0.1,
        summary: "Newsletter.",
        labels: [],
      });

      await classifier.classify({
        from: "newsletter@service.com",
        to: ["user@example.com"],
        subject: "Long body",
        textBody: "x".repeat(4001),
        receivedAt: "2024-01-15T10:00:00Z",
        headers: {},
      });

      const callArgs = mockSend.mock.calls[0]![0] as { body: Uint8Array };
      const payload = JSON.parse(new TextDecoder().decode(callArgs.body)) as { messages: Array<{ content: string }> };
      expect(payload.messages[0]!.content).toContain("[... truncated]");
    });

    it("does not truncate body of exactly 4000 characters", async () => {
      mockClassifyResponse({
        workflow: "newsletter",
        workflowData: { workflow: "newsletter", publication: "Test", topics: [] },
        spamScore: 0.0,
        summary: "Newsletter.",
        labels: [],
      });

      await classifier.classify({
        from: "newsletter@service.com",
        to: ["user@example.com"],
        subject: "Exact length body",
        textBody: "y".repeat(4000),
        receivedAt: "2024-01-15T10:00:00Z",
        headers: {},
      });

      const callArgs = mockSend.mock.calls[0]![0] as { body: Uint8Array };
      const payload = JSON.parse(new TextDecoder().decode(callArgs.body)) as { messages: Array<{ content: string }> };
      expect(payload.messages[0]!.content).not.toContain("[... truncated]");
    });

    it("throws when Bedrock returns non-JSON text content", async () => {
      const malformed = new TextEncoder().encode(
        JSON.stringify({ content: [{ type: "text", text: "not valid json {{{{" }] }),
      );
      mockSend.mockResolvedValueOnce({ body: malformed });

      await expect(classifier.classify(githubOtpEmail)).rejects.toThrow();
    });

    it("preserves emoji and unicode characters in the Bedrock message content", async () => {
      mockClassifyResponse({
        workflow: "personal",
        workflowData: { workflow: "personal", isReply: false, sentiment: "positive", requiresReply: false },
        spamScore: 0.0,
        summary: "Personal email.",
        labels: [],
      });

      await classifier.classify({
        from: "friend@example.com",
        to: ["user@example.com"],
        subject: "Hello 👋 from Tokyo 🗼",
        textBody: "希望你一切都好！😊",
        receivedAt: "2024-01-15T10:00:00Z",
        headers: {},
      });

      const callArgs = mockSend.mock.calls[0]![0] as { body: Uint8Array };
      const payload = JSON.parse(new TextDecoder().decode(callArgs.body)) as { messages: Array<{ content: string }> };
      const content = payload.messages[0]!.content;
      expect(content).toContain("Hello 👋 from Tokyo 🗼");
      expect(content).toContain("希望你一切都好！😊");
    });
  });

  // -------------------------------------------------------------------------
  // classify — additional workflow coverage
  // -------------------------------------------------------------------------

  describe("financial emails", () => {
    it("extracts institution, amount, and isSuspicious from a fraud alert", async () => {
      mockClassifyResponse({
        workflow: "financial",
        workflowData: {
          workflow: "financial",
          financialType: "fraud_alert",
          institution: "Chase Bank",
          amount: 2499.99,
          currency: "USD",
          accountLastFour: "4242",
          transactionDate: "2024-01-15",
          isSuspicious: true,
        },
        spamScore: 0.0,
        summary: "Fraud alert from Chase Bank for $2,499.99.",
        labels: ["urgent", "action-needed"],
      });

      const result = await classifier.classify({
        from: "alerts@chase.com",
        to: ["user@example.com"],
        subject: "Unusual activity on your Chase account",
        textBody: "We noticed a $2,499.99 charge at an unknown merchant. If this wasn't you, call us.",
        receivedAt: "2024-01-15T08:00:00Z",
        headers: { "authentication-results": "spf=pass dkim=pass" },
      });

      expect(result.workflow).toBe("financial");
      expect(result.workflowData).toMatchObject({ institution: "Chase Bank", amount: 2499.99, isSuspicious: true });
      expect(result.labels).toContain("urgent");
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
        spamScore: 0.0,
        summary: "Delta Airlines flight JFK → LHR departing March 15. Confirmation: DELTA123.",
        labels: [],
      });

      const result = await classifier.classify({
        from: "confirmation@delta.com",
        to: ["user@example.com"],
        subject: "Your flight confirmation DELTA123",
        textBody: "Flight JFK → LHR on March 15. Confirmation: DELTA123.",
        receivedAt: "2024-01-15T12:00:00Z",
        headers: { "authentication-results": "spf=pass dkim=pass" },
      });

      expect(result.workflow).toBe("travel");
      expect(result.workflowData).toMatchObject({
        travelType: "flight",
        provider: "Delta Airlines",
        confirmationNumber: "DELTA123",
        departureDate: "2024-03-15",
      });
    });
  });

  describe("scheduling emails", () => {
    it("extracts title, startTime, and requiresResponse from a meeting invite", async () => {
      mockClassifyResponse({
        workflow: "scheduling",
        workflowData: {
          workflow: "scheduling",
          eventType: "meeting_invite",
          title: "Q1 Planning Session",
          startTime: "2024-02-01T14:00:00Z",
          endTime: "2024-02-01T15:00:00Z",
          location: "Zoom",
          organizer: "boss@company.com",
          attendees: ["user@example.com"],
          requiresResponse: true,
        },
        spamScore: 0.0,
        summary: "Meeting invite for Q1 Planning Session on Feb 1 at 2pm.",
        labels: ["action-needed"],
      });

      const result = await classifier.classify({
        from: "boss@company.com",
        to: ["user@example.com"],
        subject: "Invite: Q1 Planning Session @ Feb 1 2pm",
        textBody: "You're invited to Q1 Planning Session on Feb 1 at 2pm on Zoom. Please RSVP.",
        receivedAt: "2024-01-15T09:00:00Z",
        headers: {},
      });

      expect(result.workflow).toBe("scheduling");
      expect(result.workflowData).toMatchObject({
        title: "Q1 Planning Session",
        startTime: "2024-02-01T14:00:00Z",
        requiresResponse: true,
      });
    });
  });

  describe("security emails", () => {
    it("extracts alertType and requiresAction from a suspicious login alert", async () => {
      mockClassifyResponse({
        workflow: "security",
        workflowData: {
          workflow: "security",
          alertType: "suspicious_login",
          service: "GitHub",
          ipAddress: "203.0.113.42",
          location: "Moscow, Russia",
          deviceName: null,
          requiresAction: true,
          actionUrl: "https://github.com/settings/security",
        },
        spamScore: 0.0,
        summary: "GitHub detected a suspicious login from Moscow, Russia. Action required.",
        labels: ["action-needed", "urgent"],
      });

      const result = await classifier.classify({
        from: "security@github.com",
        to: ["user@example.com"],
        subject: "Suspicious sign-in attempt on your GitHub account",
        textBody: "We detected a login from 203.0.113.42 in Moscow, Russia. Was this you?",
        receivedAt: "2024-01-15T03:00:00Z",
        headers: { "authentication-results": "spf=pass dkim=pass" },
      });

      expect(result.workflow).toBe("security");
      expect(result.workflowData).toMatchObject({ alertType: "suspicious_login", requiresAction: true });
      expect(result.spamScore).toBeLessThan(0.3); // legitimate alert from github.com
    });
  });

  describe("test workflow", () => {
    it("classifies unambiguous test content as the test workflow", async () => {
      mockClassifyResponse({
        workflow: "test",
        workflowData: { workflow: "test", triggeredBy: "user" },
        spamScore: 0.0,
        summary: "User sent a test email to verify inbox delivery.",
        labels: [],
      });

      const result = await classifier.classify({
        from: "me@mydomain.com",
        to: ["me@mydomain.com"],
        subject: "test",
        textBody: "testing 123",
        receivedAt: "2024-01-15T10:00:00Z",
        headers: {},
      });

      expect(result.workflow).toBe("test");
      expect(result.workflowData).toMatchObject({ triggeredBy: "user" });
      expect(result.spamScore).toBe(0.0);
    });
  });
});
