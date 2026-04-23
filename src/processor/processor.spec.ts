import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SQSEvent } from "aws-lambda";
import { SignalProcessor } from "./processor.js";
import type { ProcessorStore, ArcMatcher, RuleEvaluator } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { Arc, Rule, Signal } from "../types/index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-001";

function makeStore(): ProcessorStore {
  return {
    getSignalByMessageId: vi.fn().mockResolvedValue(null),
    saveSignal: vi.fn().mockResolvedValue(undefined),
    getArc: vi.fn().mockResolvedValue(null),
    saveArc: vi.fn().mockResolvedValue(undefined),
    listRules: vi.fn().mockResolvedValue([]),
  };
}

function makeMimeParser(): MimeParser {
  return {
    parse: vi.fn().mockResolvedValue({
      from: { address: "sender@example.com", name: "Sender" },
      to: [{ address: "user@example.com" }],
      cc: [],
      subject: "Test email",
      textBody: "Hello world",
      htmlBody: "<p>Hello world</p>",
      attachments: [],
      headers: { "authentication-results": "spf=pass dkim=pass" },
      sentAt: "2024-01-15T09:00:00Z",
    }),
  };
}

function makeClassifier(): Pick<SignalClassifier, "classify" | "embed"> {
  return {
    classify: vi.fn().mockResolvedValue(validClassification),
    embed: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
  };
}

function makeArcMatcher(): ArcMatcher {
  return {
    findMatch: vi.fn().mockResolvedValue(null),
    upsertEmbedding: vi.fn().mockResolvedValue(undefined),
  };
}

function makeRuleEvaluator(): RuleEvaluator {
  return {
    evaluate: vi.fn().mockReturnValue(false),
  };
}

function makeSqsEvent(messages: Array<{
  accountId?: string;
  s3Bucket?: string;
  s3Key?: string;
  sesMessageId?: string;
  timestamp?: string;
  destination?: string[];
}>): SQSEvent {
  return {
    Records: messages.map((msg, i) => ({
      messageId: `sqs-${i}`,
      receiptHandle: "handle",
      body: JSON.stringify({
        accountId: msg.accountId ?? TEST_ACCOUNT_ID,
        s3Bucket: msg.s3Bucket ?? "test-bucket",
        s3Key: msg.s3Key ?? `emails/${msg.sesMessageId ?? "msg-123"}`,
        sesMessageId: msg.sesMessageId ?? "msg-123",
        timestamp: msg.timestamp ?? "2024-01-15T10:00:00Z",
        destination: msg.destination ?? ["user@example.com"],
      }),
      attributes: {
        ApproximateReceiveCount: "1",
        SentTimestamp: "1234567890",
        SenderId: "sender",
        ApproximateFirstReceiveTimestamp: "1234567890",
      },
      messageAttributes: {},
      md5OfBody: "",
      eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:us-east-1:123:queue",
      awsRegion: "us-east-1",
    })),
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
  summary: "A test personal email.",
  labels: [],
  classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
};

function makeArc(overrides: Partial<Arc> = {}): Arc {
  return {
    id: "arc-existing",
    accountId: TEST_ACCOUNT_ID,
    category: "personal",
    labels: [],
    status: "active",
    summary: "Existing arc summary.",
    lastSignalAt: "2024-01-10T00:00:00Z",
    createdAt: "2024-01-10T00:00:00Z",
    updatedAt: "2024-01-10T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SignalProcessor", () => {
  let store: ProcessorStore;
  let mimeParser: MimeParser;
  let classifier: Pick<SignalClassifier, "classify" | "embed">;
  let arcMatcher: ArcMatcher;
  let ruleEvaluator: RuleEvaluator;
  let processor: SignalProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
    mimeParser = makeMimeParser();
    classifier = makeClassifier();
    arcMatcher = makeArcMatcher();
    ruleEvaluator = makeRuleEvaluator();
    processor = new SignalProcessor({ store, mimeParser, classifier, arcMatcher, ruleEvaluator });
  });

  // -------------------------------------------------------------------------
  // Happy path — new Arc
  // -------------------------------------------------------------------------

  describe("new signal with no matching Arc", () => {
    it("saves a Signal after classification", async () => {
      const event = makeSqsEvent([{ sesMessageId: "msg-abc" }]);
      await processor.process(event);

      expect(store.saveSignal).toHaveBeenCalledOnce();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.messageId).toBe("msg-abc");
      expect(saved.category).toBe("personal");
      expect(saved.accountId).toBe(TEST_ACCOUNT_ID);
    });

    it("creates a new Arc when arcMatcher returns null", async () => {
      await processor.process(makeSqsEvent([{}]));

      expect(store.saveArc).toHaveBeenCalledOnce();
      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.id).toBeTruthy();
      expect(arc.status).toBe("active");
      expect(arc.accountId).toBe(TEST_ACCOUNT_ID);
    });

    it("links Signal to the newly created Arc", async () => {
      await processor.process(makeSqsEvent([{}]));

      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      const signal = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.arcId).toBe(arc.id);
    });

    it("embeds the signal content before arc matching", async () => {
      await processor.process(makeSqsEvent([{}]));

      expect(classifier.embed).toHaveBeenCalledOnce();
      expect(arcMatcher.findMatch).toHaveBeenCalledOnce();
    });

    it("stores the embedding after saving", async () => {
      await processor.process(makeSqsEvent([{}]));

      expect(arcMatcher.upsertEmbedding).toHaveBeenCalledOnce();
    });

    it("sets Arc category and summary from classification", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        category: "invoice",
        summary: "Receipt from Stripe for $99.",
        labels: ["billing"],
        categoryData: {
          category: "invoice",
          invoiceType: "receipt",
          vendor: "Stripe",
          amount: 99,
          currency: "USD",
        },
      });

      await processor.process(makeSqsEvent([{}]));

      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.category).toBe("invoice");
      expect(arc.summary).toBe("Receipt from Stripe for $99.");
      expect(arc.labels).toContain("billing");
    });

    it("preserves from/to/subject from parsed MIME on the Signal", async () => {
      await processor.process(makeSqsEvent([{}]));

      const signal = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.from.address).toBe("sender@example.com");
      expect(signal.subject).toBe("Test email");
    });

    it("sets recipientAddress from the SQS destination field", async () => {
      await processor.process(makeSqsEvent([{ destination: ["inbox@customer.com"] }]));

      const signal = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.recipientAddress).toBe("inbox@customer.com");
    });
  });

  // -------------------------------------------------------------------------
  // Matching Arc
  // -------------------------------------------------------------------------

  describe("signal that matches an existing Arc", () => {
    it("links Signal to the existing Arc instead of creating a new one", async () => {
      const existing = makeArc({ id: "arc-existing" });
      vi.mocked(arcMatcher.findMatch).mockResolvedValueOnce(existing);

      await processor.process(makeSqsEvent([{}]));

      const signal = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.arcId).toBe("arc-existing");
    });

    it("updates Arc summary and lastSignalAt from new classification", async () => {
      const existing = makeArc({ id: "arc-existing", summary: "Old summary." });
      vi.mocked(arcMatcher.findMatch).mockResolvedValueOnce(existing);
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        summary: "Updated summary from new signal.",
      });

      await processor.process(makeSqsEvent([{}]));

      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.id).toBe("arc-existing");
      expect(arc.summary).toBe("Updated summary from new signal.");
    });
  });

  // -------------------------------------------------------------------------
  // Rule evaluation
  // -------------------------------------------------------------------------

  describe("rule evaluation", () => {
    it("applies assign_label action when rule matches", async () => {
      const rule: Rule = {
        id: "rule-1",
        accountId: TEST_ACCOUNT_ID,
        name: "Label billing",
        condition: '{"==": [{"var": "arc.category"}, "invoice"]}',
        actions: [{ type: "assign_label", value: "billing" }],
        position: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listRules).mockResolvedValueOnce([rule]);
      vi.mocked(ruleEvaluator.evaluate).mockReturnValueOnce(true);

      await processor.process(makeSqsEvent([{}]));

      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.labels).toContain("billing");
    });

    it("archives Arc when archive action matches", async () => {
      const rule: Rule = {
        id: "rule-2",
        accountId: TEST_ACCOUNT_ID,
        name: "Archive newsletters",
        condition: '{"==": [{"var": "arc.category"}, "newsletter"]}',
        actions: [{ type: "archive" }],
        position: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listRules).mockResolvedValueOnce([rule]);
      vi.mocked(ruleEvaluator.evaluate).mockReturnValueOnce(true);

      await processor.process(makeSqsEvent([{}]));

      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.status).toBe("archived");
    });

    it("does not apply rule when condition evaluates to false", async () => {
      const rule: Rule = {
        id: "rule-3",
        accountId: TEST_ACCOUNT_ID,
        name: "Never matches",
        condition: '{"==": [1, 2]}',
        actions: [{ type: "archive" }],
        position: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listRules).mockResolvedValueOnce([rule]);
      vi.mocked(ruleEvaluator.evaluate).mockReturnValueOnce(false);

      await processor.process(makeSqsEvent([{}]));

      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.status).toBe("active");
    });
  });

  // -------------------------------------------------------------------------
  // Deduplication
  // -------------------------------------------------------------------------

  describe("deduplication", () => {
    it("skips processing if Signal with same messageId already exists", async () => {
      vi.mocked(store.getSignalByMessageId).mockResolvedValueOnce({
        id: "existing-signal",
        messageId: "msg-123",
      } as never);

      await processor.process(makeSqsEvent([{ sesMessageId: "msg-123" }]));

      expect(classifier.classify).not.toHaveBeenCalled();
      expect(store.saveSignal).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Batch processing
  // -------------------------------------------------------------------------

  describe("batch processing", () => {
    it("processes all SQS records", async () => {
      const event = makeSqsEvent([
        { sesMessageId: "msg-1" },
        { sesMessageId: "msg-2" },
        { sesMessageId: "msg-3" },
      ]);

      await processor.process(event);

      expect(classifier.classify).toHaveBeenCalledTimes(3);
      expect(store.saveSignal).toHaveBeenCalledTimes(3);
    });

    it("continues processing remaining records when one fails", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("Bedrock error"))
        .mockResolvedValueOnce(validClassification);

      const event = makeSqsEvent([
        { sesMessageId: "msg-fail" },
        { sesMessageId: "msg-ok" },
      ]);

      await processor.process(event);

      expect(store.saveSignal).toHaveBeenCalledOnce();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.messageId).toBe("msg-ok");
    });
  });
});
