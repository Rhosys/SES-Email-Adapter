import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SQSEvent } from "aws-lambda";
import { SignalProcessor, deriveGroupingKey, derivePushPriority } from "./processor.js";
import type { ProcessorDatabase, ArcMatcher, RuleEvaluator, Notifier } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { Arc, Rule, Signal, EmailAddressConfig } from "../types/index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-001";

function makeStore(): ProcessorDatabase {
  return {
    getSignalByMessageId: vi.fn().mockResolvedValue(null),
    saveSignal: vi.fn().mockResolvedValue(undefined),
    getArc: vi.fn().mockResolvedValue(null),
    findArcByGroupingKey: vi.fn().mockResolvedValue(null),
    saveArc: vi.fn().mockResolvedValue(undefined),
    listRules: vi.fn().mockResolvedValue([]),
    getEmailAddressConfig: vi.fn().mockResolvedValue(null),
    saveEmailAddressConfig: vi.fn().mockResolvedValue(undefined),
    getAccountFilteringConfig: vi.fn().mockResolvedValue(null),
    getAccountRetentionDays: vi.fn().mockResolvedValue(0),
    updateGlobalReputation: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEmailAddressConfig(overrides: Partial<EmailAddressConfig> = {}): EmailAddressConfig {
  return {
    id: "cfg-001",
    accountId: TEST_ACCOUNT_ID,
    address: "user@example.com",
    filterMode: "notify_new",
    approvedSenders: ["example.com"],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
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

function makeNotifier(): Notifier {
  return {
    notify: vi.fn().mockResolvedValue(undefined),
    notifyBlocked: vi.fn().mockResolvedValue(undefined),
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
  workflow: "personal",
  workflowData: {
    workflow: "personal",
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
    workflow: "personal",
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
  let store: ProcessorDatabase;
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
      expect(saved.id).toBe("SES#msg-abc");
      expect(saved.source).toBe("email");
      expect(saved.workflow).toBe("personal");
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

    it("embeds the signal content and runs arc matching", async () => {
      await processor.process(makeSqsEvent([{}]));

      expect(classifier.embed).toHaveBeenCalledOnce();
      // personal workflow has no grouping key — falls back to vector search
      expect(arcMatcher.findMatch).toHaveBeenCalledOnce();
    });

    it("stores the embedding after saving", async () => {
      await processor.process(makeSqsEvent([{}]));

      expect(arcMatcher.upsertEmbedding).toHaveBeenCalledOnce();
    });

    it("sets Arc workflow and summary from classification", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        workflow: "invoice",
        summary: "Receipt from Stripe for $99.",
        labels: ["billing"],
        workflowData: {
          workflow: "invoice",
          invoiceType: "receipt",
          vendor: "Stripe",
          amount: 99,
          currency: "USD",
        },
      });

      await processor.process(makeSqsEvent([{}]));

      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.workflow).toBe("invoice");
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
        condition: '{"==": [{"var": "arc.workflow"}, "invoice"]}',
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
        condition: '{"==": [{"var": "arc.workflow"}, "newsletter"]}',
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
        id: "SES#msg-123",
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
      expect(saved.id).toBe("SES#msg-ok");
      expect(saved.source).toBe("email");
    });
  });

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  describe("notifications", () => {
    let notifier: Notifier;

    beforeEach(() => {
      notifier = makeNotifier();
      processor = new SignalProcessor({ store, mimeParser, classifier, arcMatcher, ruleEvaluator, notifier });
    });

    it("calls notifier after saving a new Signal", async () => {
      await processor.process(makeSqsEvent([{}]));

      expect(notifier.notify).toHaveBeenCalledOnce();
    });

    it("passes accountId, arc, and signal to notifier", async () => {
      await processor.process(makeSqsEvent([{}]));

      const [accountId, arc, signal] = vi.mocked(notifier.notify).mock.calls[0]!;
      expect(accountId).toBe(TEST_ACCOUNT_ID);
      expect(arc.accountId).toBe(TEST_ACCOUNT_ID);
      expect(signal.accountId).toBe(TEST_ACCOUNT_ID);
    });

    it("does not call notifier for spam signals", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        workflow: "spam",
        spamScore: 0.97,
        workflowData: { workflow: "spam", spamType: "phishing", confidence: 0.97, indicators: [] },
      });

      await processor.process(makeSqsEvent([{}]));

      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it("does not call notifier when spamScore >= 0.9 even if workflow is not spam", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        spamScore: 0.95,
      });

      await processor.process(makeSqsEvent([{}]));

      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it("does not fail processing when notifier throws", async () => {
      vi.mocked(notifier.notify).mockRejectedValueOnce(new Error("SES error"));

      await processor.process(makeSqsEvent([{}]));

      // Signal was still saved despite notification failure
      expect(store.saveSignal).toHaveBeenCalledOnce();
    });

    it("does not call notifier when no notifier is configured", async () => {
      // Processor without notifier
      const processorWithoutNotifier = new SignalProcessor({
        store, mimeParser, classifier, arcMatcher, ruleEvaluator,
      });

      await processorWithoutNotifier.process(makeSqsEvent([{}]));

      expect(notifier.notify).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Sender filtering
  // -------------------------------------------------------------------------

  describe("sender filtering", () => {
    let notifier: Notifier;

    beforeEach(() => {
      notifier = makeNotifier();
      processor = new SignalProcessor({ store, mimeParser, classifier, arcMatcher, ruleEvaluator, notifier });
    });

    it("allows signal on brand new address and auto-creates email config with sender approved", async () => {
      // null config = brand new address (default from makeStore)
      await processor.process(makeSqsEvent([{}]));

      expect(store.saveSignal).toHaveBeenCalledOnce();
      expect(store.saveArc).toHaveBeenCalledOnce();
      expect(store.saveEmailAddressConfig).toHaveBeenCalledOnce();

      const savedConfig = vi.mocked(store.saveEmailAddressConfig).mock.calls[0]![0] as EmailAddressConfig;
      expect(savedConfig.filterMode).toBe("notify_new");
      expect(savedConfig.approvedSenders).toContain("example.com"); // sender domain from mimeParser mock
    });

    it("allows signal from a known sender (eTLD+1 in approved list)", async () => {
      vi.mocked(store.getEmailAddressConfig).mockResolvedValueOnce(
        makeEmailAddressConfig({ approvedSenders: ["example.com"] }),
      );

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveSignal).toHaveBeenCalledOnce();
      expect(store.saveArc).toHaveBeenCalledOnce();
      expect(store.saveEmailAddressConfig).not.toHaveBeenCalled(); // no auto-approve needed
    });

    it("blocks signal from unknown sender", async () => {
      vi.mocked(store.getEmailAddressConfig).mockResolvedValueOnce(
        makeEmailAddressConfig({ approvedSenders: ["trusted.com"] }), // sender is example.com, not trusted.com
      );

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveArc).not.toHaveBeenCalled();
      expect(store.saveSignal).toHaveBeenCalledOnce();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("blocked");
      expect(saved.blockReason).toBe("new_sender");
      expect(saved.arcId).toBeUndefined();
    });

    it("calls notifyBlocked when a signal is blocked", async () => {
      vi.mocked(store.getEmailAddressConfig).mockResolvedValueOnce(
        makeEmailAddressConfig({ approvedSenders: ["other.com"] }),
      );

      await processor.process(makeSqsEvent([{}]));

      expect(notifier.notifyBlocked).toHaveBeenCalledOnce();
      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it("does not fail when notifyBlocked throws", async () => {
      vi.mocked(store.getEmailAddressConfig).mockResolvedValueOnce(
        makeEmailAddressConfig({ approvedSenders: [] }),
      );
      vi.mocked(notifier.notifyBlocked).mockRejectedValueOnce(new Error("SES error"));

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveSignal).toHaveBeenCalledOnce();
    });

    it("bypasses filtering when signal matches an existing Arc", async () => {
      const existingArc: Arc = {
        id: "existing-arc",
        accountId: TEST_ACCOUNT_ID,
        workflow: "personal",
        labels: [],
        status: "active",
        summary: "Existing conversation",
        lastSignalAt: "2024-01-14T10:00:00Z",
        createdAt: "2024-01-14T10:00:00Z",
        updatedAt: "2024-01-14T10:00:00Z",
      };
      vi.mocked(arcMatcher.findMatch).mockResolvedValueOnce(existingArc);
      // Config with no approved senders — would block if filtering ran
      vi.mocked(store.getEmailAddressConfig).mockResolvedValueOnce(
        makeEmailAddressConfig({ approvedSenders: [] }),
      );

      await processor.process(makeSqsEvent([{}]));

      // Filtering store was NOT consulted — arc match bypasses it
      expect(store.getEmailAddressConfig).not.toHaveBeenCalled();
      expect(store.saveArc).toHaveBeenCalledOnce();
      expect(store.saveSignal).toHaveBeenCalledOnce();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("active");
    });

    it("strict mode blocks a known sender with high spam score", async () => {
      vi.mocked(store.getEmailAddressConfig).mockResolvedValueOnce(
        makeEmailAddressConfig({ filterMode: "strict", approvedSenders: ["example.com"] }),
      );
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        spamScore: 0.8,
      });

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveArc).not.toHaveBeenCalled();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("blocked");
      expect(saved.blockReason).toBe("spam");
    });

    it("allow_all mode auto-approves new sender without blocking", async () => {
      vi.mocked(store.getEmailAddressConfig).mockResolvedValueOnce(
        makeEmailAddressConfig({ filterMode: "allow_all", approvedSenders: [] }),
      );

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveArc).toHaveBeenCalledOnce();
      const savedConfig = vi.mocked(store.saveEmailAddressConfig).mock.calls[0]![0] as EmailAddressConfig;
      expect(savedConfig.approvedSenders).toContain("example.com");
    });

    it("saves blocked signal with classification data for user review", async () => {
      vi.mocked(store.getEmailAddressConfig).mockResolvedValueOnce(
        makeEmailAddressConfig({ approvedSenders: [] }),
      );

      await processor.process(makeSqsEvent([{}]));

      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.workflow).toBe(validClassification.workflow);
      expect(saved.summary).toBe(validClassification.summary);
      expect(saved.spamScore).toBe(validClassification.spamScore);
    });

    it("blocks new address when newAddressHandling is block_until_approved", async () => {
      vi.mocked(store.getAccountFilteringConfig).mockResolvedValueOnce({
        newAddressHandling: "block_until_approved",
        defaultFilterMode: "notify_new",
      });

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveArc).not.toHaveBeenCalled();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("blocked");
      expect(saved.blockReason).toBe("new_sender");
    });
  });

  // -------------------------------------------------------------------------
  // Global reputation tracking
  // -------------------------------------------------------------------------

  describe("global reputation tracking", () => {
    it("updates reputation with wasBlocked=true for blocked signals", async () => {
      vi.mocked(store.getEmailAddressConfig).mockResolvedValueOnce(
        makeEmailAddressConfig({ approvedSenders: [] }),
      );

      await processor.process(makeSqsEvent([{}]));

      expect(store.updateGlobalReputation).toHaveBeenCalledWith(
        "example.com",
        expect.objectContaining({ wasBlocked: true }),
      );
    });

    it("updates reputation with wasBlocked=false for active signals", async () => {
      await processor.process(makeSqsEvent([{}]));

      expect(store.updateGlobalReputation).toHaveBeenCalledWith(
        "example.com",
        expect.objectContaining({ wasBlocked: false }),
      );
    });

    it("marks wasSpam=true when classification workflow is spam", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        workflow: "spam",
        spamScore: 0.97,
        workflowData: { workflow: "spam", spamType: "phishing", confidence: 0.97, indicators: [] },
      });

      await processor.process(makeSqsEvent([{}]));

      expect(store.updateGlobalReputation).toHaveBeenCalledWith(
        "example.com",
        expect.objectContaining({ wasSpam: true }),
      );
    });

    it("does not fail processing when updateGlobalReputation throws", async () => {
      vi.mocked(store.updateGlobalReputation).mockRejectedValueOnce(new Error("DynamoDB error"));

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveSignal).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Arc grouping key
  // -------------------------------------------------------------------------

  describe("arc grouping key", () => {
    it("uses deterministic key lookup for auth signals instead of vector search", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        workflow: "auth",
        workflowData: { workflow: "auth", authType: "otp", code: "123456", service: "GitHub" },
      });

      await processor.process(makeSqsEvent([{}]));

      expect(store.findArcByGroupingKey).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        "user@example.com:auth:example.com",
      );
      expect(arcMatcher.findMatch).not.toHaveBeenCalled();
    });

    it("stores groupingKey on a newly created arc", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        workflow: "auth",
        workflowData: { workflow: "auth", authType: "otp", code: "123456", service: "GitHub" },
      });

      await processor.process(makeSqsEvent([{}]));

      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.groupingKey).toBe("user@example.com:auth:example.com");
    });

    it("reuses existing arc found by grouping key", async () => {
      const existing = makeArc({ id: "auth-arc", groupingKey: "user@example.com:auth:example.com" });
      vi.mocked(store.findArcByGroupingKey).mockResolvedValueOnce(existing);
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        workflow: "auth",
        workflowData: { workflow: "auth", authType: "otp", code: "999999", service: "GitHub" },
      });

      await processor.process(makeSqsEvent([{}]));

      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.id).toBe("auth-arc");
    });

    it("scopes vector search by recipientAddress for workflows without a grouping key", async () => {
      await processor.process(makeSqsEvent([{ destination: ["inbox@work.com"] }]));

      expect(arcMatcher.findMatch).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        "inbox@work.com",
        expect.any(Array),
      );
    });

    it("uses order number as grouping key when present", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        workflow: "order",
        workflowData: { workflow: "order", orderType: "shipping", retailer: "Amazon", orderNumber: "112-999" },
      });

      await processor.process(makeSqsEvent([{}]));

      expect(store.findArcByGroupingKey).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        "user@example.com:order:112-999",
      );
    });

    it("falls back to vector search for order without order number", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        workflow: "order",
        workflowData: { workflow: "order", orderType: "shipping", retailer: "Amazon" },
      });

      await processor.process(makeSqsEvent([{}]));

      expect(store.findArcByGroupingKey).not.toHaveBeenCalled();
      expect(arcMatcher.findMatch).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Pure function unit tests
  // -------------------------------------------------------------------------

  describe("deriveGroupingKey", () => {
    it("returns recipientAddress:workflow:senderETLD1 for auth", () => {
      expect(deriveGroupingKey("auth", { workflow: "auth", authType: "otp", service: "GitHub" }, "me@example.com", "github.com"))
        .toBe("me@example.com:auth:github.com");
    });

    it("returns null for personal (vector search workflow)", () => {
      expect(deriveGroupingKey("personal", { workflow: "personal", isReply: false, sentiment: "neutral", requiresReply: false }, "me@example.com", "friend.com"))
        .toBeNull();
    });
  });

  describe("derivePushPriority", () => {
    it("auth is always interrupt", () => {
      expect(derivePushPriority("auth", { workflow: "auth", authType: "otp", service: "GitHub" })).toBe("interrupt");
    });

    it("financial is interrupt only when isSuspicious", () => {
      expect(derivePushPriority("financial", { workflow: "financial", financialType: "fraud_alert", institution: "Chase", isSuspicious: true, requiresAction: false })).toBe("interrupt");
      expect(derivePushPriority("financial", { workflow: "financial", financialType: "statement", institution: "Chase", requiresAction: false })).toBe("ambient");
    });

    it("notice is always silent", () => {
      expect(derivePushPriority("notice", { workflow: "notice", noticeType: "privacy_policy", provider: "Google" })).toBe("silent");
    });

    it("newsletter is always silent", () => {
      expect(derivePushPriority("newsletter", { workflow: "newsletter", publication: "TLDR", topics: [] })).toBe("silent");
    });
  });
});
