import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SESEvent } from "aws-lambda";
import { EmailProcessor } from "./processor.js";
import type { EmailStore } from "./store.js";
import type { MimeParser } from "./mime.js";
import type { ClassificationOutput } from "@ses-adapter/classifier";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockClassify = vi.fn();
vi.mock("@ses-adapter/classifier", () => ({
  EmailClassifier: vi.fn().mockImplementation(() => ({
    classify: mockClassify,
  })),
}));

function makeStore(): EmailStore {
  return {
    saveEmail: vi.fn().mockResolvedValue(undefined),
    getEmailByMessageId: vi.fn().mockResolvedValue(null),
  };
}

function makeMimeParser(): MimeParser {
  return {
    parse: vi.fn().mockResolvedValue({
      from: { address: "sender@example.com", name: "Sender" },
      to: [{ address: "user@example.com", name: "User" }],
      cc: [],
      replyTo: undefined,
      subject: "Test email",
      textBody: "Hello world",
      htmlBody: "<p>Hello world</p>",
      attachments: [],
      headers: { "authentication-results": "spf=pass dkim=pass" },
      sentAt: "2024-01-15T09:00:00Z",
    }),
  };
}

function makeSesEvent(overrides: Partial<{
  messageId: string;
  source: string;
  destination: string[];
  bucketName: string;
  objectKey: string;
}>): SESEvent {
  const {
    messageId = "msg-123",
    source = "sender@example.com",
    destination = ["user@example.com"],
    bucketName = "test-bucket",
    objectKey = "emails/msg-123",
  } = overrides;

  return {
    Records: [{
      eventSource: "aws:ses",
      eventVersion: "1.0",
      ses: {
        mail: {
          timestamp: "2024-01-15T10:00:00Z",
          source,
          messageId,
          destination,
          headersTruncated: false,
          headers: [],
          commonHeaders: { to: destination, from: [source], subject: "Test" },
        },
        receipt: {
          timestamp: "2024-01-15T10:00:00Z",
          processingTimeMillis: 100,
          recipients: destination,
          spamVerdict: { status: "PASS" },
          virusVerdict: { status: "PASS" },
          spfVerdict: { status: "PASS" },
          dkimVerdict: { status: "PASS" },
          dmarcVerdict: { status: "PASS" },
          dmarcPolicy: "reject",
          action: {
            type: "S3",
            topicArn: undefined,
            bucketName,
            objectKeyPrefix: "emails/",
            objectKey,
            encoding: "Base64",
          },
        },
      },
    }],
  };
}

const validClassification: ClassificationOutput = {
  category: "personal",
  categoryData: {
    category: "personal",
    isReply: false,
    sentiment: "neutral",
    requiresReply: false,
  },
  spamScore: 0.05,
  isValid: true,
  summary: "A test personal email.",
  priority: "normal",
  validationResult: {
    isValid: true,
    spamScore: 0.05,
    failedChecks: [],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EmailProcessor", () => {
  let store: EmailStore;
  let mimeParser: MimeParser;
  let processor: EmailProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
    mimeParser = makeMimeParser();
    processor = new EmailProcessor({ store, mimeParser });
    mockClassify.mockResolvedValue(validClassification);
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe("successful processing", () => {
    it("saves a classified email to the store", async () => {
      const event = makeSesEvent({ messageId: "msg-abc" });
      await processor.process(event);

      expect(store.saveEmail).toHaveBeenCalledOnce();
      const saved = vi.mocked(store.saveEmail).mock.calls[0]![0];
      expect(saved.messageId).toBe("msg-abc");
      expect(saved.category).toBe("personal");
      expect(saved.isValid).toBe(true);
    });

    it("parses MIME content from S3 before classifying", async () => {
      const event = makeSesEvent({});
      await processor.process(event);

      expect(mimeParser.parse).toHaveBeenCalledOnce();
      expect(mockClassify).toHaveBeenCalledOnce();
    });

    it("preserves from/to/subject from parsed MIME", async () => {
      const event = makeSesEvent({});
      await processor.process(event);

      const saved = vi.mocked(store.saveEmail).mock.calls[0]![0];
      expect(saved.from.address).toBe("sender@example.com");
      expect(saved.subject).toBe("Test email");
    });

    it("populates category data from classifier output", async () => {
      mockClassify.mockResolvedValueOnce({
        ...validClassification,
        category: "invoice",
        categoryData: {
          category: "invoice",
          invoiceType: "receipt",
          vendor: "Stripe",
          amount: 99.0,
          currency: "USD",
          invoiceNumber: "INV-001",
          dueDate: null,
          lineItems: [],
          downloadUrl: null,
        },
      });

      const event = makeSesEvent({});
      await processor.process(event);

      const saved = vi.mocked(store.saveEmail).mock.calls[0]![0];
      expect(saved.category).toBe("invoice");
      expect(saved.categoryData).toMatchObject({ vendor: "Stripe", amount: 99 });
    });

    it("sets isRead=false and isArchived=false on new emails", async () => {
      const event = makeSesEvent({});
      await processor.process(event);

      const saved = vi.mocked(store.saveEmail).mock.calls[0]![0];
      expect(saved.isRead).toBe(false);
      expect(saved.isArchived).toBe(false);
      expect(saved.isTrashed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Spam / invalid emails
  // -------------------------------------------------------------------------

  describe("spam handling", () => {
    it("saves spam emails with isValid=false (for audit) but marks them", async () => {
      mockClassify.mockResolvedValueOnce({
        ...validClassification,
        category: "spam",
        isValid: false,
        spamScore: 0.97,
        categoryData: {
          category: "spam",
          spamType: "phishing",
          confidence: 0.97,
          indicators: ["Domain impersonation"],
        },
      });

      const event = makeSesEvent({});
      await processor.process(event);

      const saved = vi.mocked(store.saveEmail).mock.calls[0]![0];
      expect(saved.isValid).toBe(false);
      expect(saved.isTrashed).toBe(true);
    });

    it("drops emails when SES spamVerdict is FAIL and spamScore > 0.95", async () => {
      const event: SESEvent = {
        Records: [{
          ...makeSesEvent({}).Records[0]!,
          ses: {
            ...makeSesEvent({}).Records[0]!.ses,
            receipt: {
              ...makeSesEvent({}).Records[0]!.ses.receipt,
              spamVerdict: { status: "FAIL" },
            },
          },
        }],
      };

      mockClassify.mockResolvedValueOnce({
        ...validClassification,
        isValid: false,
        spamScore: 0.98,
      });

      await processor.process(event);

      // Still saved (for audit), but marked invalid and trashed
      const saved = vi.mocked(store.saveEmail).mock.calls[0]![0];
      expect(saved.isValid).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Deduplication
  // -------------------------------------------------------------------------

  describe("deduplication", () => {
    it("skips processing if email with same messageId already exists", async () => {
      vi.mocked(store.getEmailByMessageId).mockResolvedValueOnce({
        id: "existing-id",
        messageId: "msg-123",
      } as never);

      const event = makeSesEvent({ messageId: "msg-123" });
      await processor.process(event);

      expect(mockClassify).not.toHaveBeenCalled();
      expect(store.saveEmail).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Multi-record SES events
  // -------------------------------------------------------------------------

  describe("batch processing", () => {
    it("processes all records in a multi-record SES event", async () => {
      const event: SESEvent = {
        Records: [
          makeSesEvent({ messageId: "msg-1" }).Records[0]!,
          makeSesEvent({ messageId: "msg-2" }).Records[0]!,
          makeSesEvent({ messageId: "msg-3" }).Records[0]!,
        ],
      };

      await processor.process(event);

      expect(mockClassify).toHaveBeenCalledTimes(3);
      expect(store.saveEmail).toHaveBeenCalledTimes(3);
    });

    it("continues processing remaining records if one fails", async () => {
      mockClassify
        .mockRejectedValueOnce(new Error("Claude API error"))
        .mockResolvedValueOnce(validClassification);

      const event: SESEvent = {
        Records: [
          makeSesEvent({ messageId: "msg-fail" }).Records[0]!,
          makeSesEvent({ messageId: "msg-ok" }).Records[0]!,
        ],
      };

      await processor.process(event);

      // Second email should still be saved
      expect(store.saveEmail).toHaveBeenCalledOnce();
      const saved = vi.mocked(store.saveEmail).mock.calls[0]![0];
      expect(saved.messageId).toBe("msg-ok");
    });
  });

  // -------------------------------------------------------------------------
  // Thread grouping
  // -------------------------------------------------------------------------

  describe("thread grouping", () => {
    it("assigns a threadId based on normalized subject", async () => {
      const event = makeSesEvent({});
      await processor.process(event);

      const saved = vi.mocked(store.saveEmail).mock.calls[0]![0];
      expect(saved.threadId).toBeTruthy();
      expect(typeof saved.threadId).toBe("string");
    });

    it("groups Re: and Fwd: replies under the same threadId as original", async () => {
      vi.mocked(mimeParser.parse)
        .mockResolvedValueOnce({
          from: { address: "a@example.com", name: "A" },
          to: [{ address: "b@example.com", name: "B" }],
          cc: [],
          subject: "Project update",
          textBody: "Original message",
          htmlBody: null,
          attachments: [],
          headers: {},
          sentAt: "2024-01-15T09:00:00Z",
        })
        .mockResolvedValueOnce({
          from: { address: "b@example.com", name: "B" },
          to: [{ address: "a@example.com", name: "A" }],
          cc: [],
          subject: "Re: Project update",
          textBody: "Reply",
          htmlBody: null,
          attachments: [],
          headers: {},
          sentAt: "2024-01-15T10:00:00Z",
        });

      const event1 = makeSesEvent({ messageId: "msg-original" });
      const event2 = makeSesEvent({ messageId: "msg-reply" });

      await processor.process(event1);
      await processor.process(event2);

      const saved1 = vi.mocked(store.saveEmail).mock.calls[0]![0];
      const saved2 = vi.mocked(store.saveEmail).mock.calls[1]![0];
      expect(saved1.threadId).toBe(saved2.threadId);
    });
  });
});
