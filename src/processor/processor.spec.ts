import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SQSEvent } from "aws-lambda";
import { SignalProcessor, deriveGroupingKey, dispositionFor } from "./processor.js";
import { baseUrgency, priorityCalculator } from "./priority.js";
import type { ProcessorDatabase, ArcMatcher, RuleEvaluator, Notifier, Forwarder, ForwardOptions } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { Arc, Rule, Signal, EmailAddressConfig, AccountFilteringConfig } from "../types/index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-001";

const DEFAULT_CTX = { retentionDays: 0, filtering: null, emailConfig: null };

function makeStore(): ProcessorDatabase {
  return {
    getSignalByMessageId: vi.fn().mockResolvedValue(null),
    saveSignal: vi.fn().mockResolvedValue(undefined),
    getArc: vi.fn().mockResolvedValue(null),
    findArcByGroupingKey: vi.fn().mockResolvedValue(null),
    saveArc: vi.fn().mockResolvedValue(undefined),
    listRules: vi.fn().mockResolvedValue([]),
    getProcessorAccountContext: vi.fn().mockResolvedValue(DEFAULT_CTX),
    saveEmailAddressConfig: vi.fn().mockResolvedValue(undefined),
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
  s3Key?: string;
  sesMessageId?: string;
  timestamp?: string;
  destination?: string[];
  dkimVerdict?: "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED";
  dmarcVerdict?: "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED";
}>): SQSEvent {
  return {
    Records: messages.map((msg, i) => {
      const sesMessageId = msg.sesMessageId ?? "msg-123";
      const notification = {
        accountId: msg.accountId ?? TEST_ACCOUNT_ID,
        mail: {
          messageId: sesMessageId,
          timestamp: msg.timestamp ?? "2024-01-15T10:00:00Z",
          destination: msg.destination ?? ["user@example.com"],
        },
        receipt: {
          dkimVerdict: { status: msg.dkimVerdict ?? "PASS" },
          dmarcVerdict: { status: msg.dmarcVerdict ?? "PASS" },
          action: {
            bucketName: "test-bucket",
            objectKey: msg.s3Key ?? `emails/${sesMessageId}`,
          },
        },
      };
      return {
        messageId: `sqs-${i}`,
        receiptHandle: "handle",
        body: JSON.stringify({ Message: JSON.stringify(notification) }),
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
      };
    }),
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

    it("skips disabled actions", async () => {
      const rule: Rule = {
        id: "rule-disabled",
        accountId: TEST_ACCOUNT_ID,
        name: "Disabled label rule",
        condition: "true",
        actions: [{ type: "assign_label", value: "important", disabled: true }],
        position: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listRules).mockResolvedValueOnce([rule]);
      vi.mocked(ruleEvaluator.evaluate).mockReturnValueOnce(true);

      await processor.process(makeSqsEvent([{}]));

      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.labels).not.toContain("important");
    });

    it("collects forward addresses from matching rules but does not call forwarder when none configured", async () => {
      const rule: Rule = {
        id: "rule-fwd",
        accountId: TEST_ACCOUNT_ID,
        name: "Forward personal",
        condition: '{"==": [{"var": "arc.workflow"}, "personal"]}',
        actions: [{ type: "forward", value: "backup@personal.com" }],
        position: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listRules).mockResolvedValueOnce([rule]);
      vi.mocked(ruleEvaluator.evaluate).mockReturnValueOnce(true);

      // No error — processor without forwarder silently skips forward actions
      await processor.process(makeSqsEvent([{}]));

      expect(store.saveSignal).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Forwarding
  // -------------------------------------------------------------------------

  describe("forwarding", () => {
    let forwarder: Forwarder;

    beforeEach(() => {
      forwarder = { forward: vi.fn().mockResolvedValue(undefined) };
      processor = new SignalProcessor({ store, mimeParser, classifier, arcMatcher, ruleEvaluator, forwarder });
    });

    it("calls forwarder with s3Key and target address when forward rule matches", async () => {
      const rule: Rule = {
        id: "rule-fwd",
        accountId: TEST_ACCOUNT_ID,
        name: "Forward to backup",
        condition: '{"==": [{"var": "arc.workflow"}, "personal"]}',
        actions: [{ type: "forward", value: "backup@personal.com" }],
        position: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listRules).mockResolvedValueOnce([rule]);
      vi.mocked(ruleEvaluator.evaluate).mockReturnValueOnce(true);

      await processor.process(makeSqsEvent([{ s3Key: "emails/msg-123" }]));

      expect(forwarder.forward).toHaveBeenCalledOnce();
      expect(forwarder.forward).toHaveBeenCalledWith("emails/msg-123", "backup@personal.com", TEST_ACCOUNT_ID, {
        senderDomain: "example.com",
        dkimPass: true,
        dmarcPass: true,
      });
    });

    it("forwards to multiple addresses when multiple forward actions match", async () => {
      const rule: Rule = {
        id: "rule-multi",
        accountId: TEST_ACCOUNT_ID,
        name: "Forward to two addresses",
        condition: "true",
        actions: [
          { type: "forward", value: "first@example.com" },
          { type: "forward", value: "second@example.com" },
        ],
        position: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listRules).mockResolvedValueOnce([rule]);
      vi.mocked(ruleEvaluator.evaluate).mockReturnValueOnce(true);

      await processor.process(makeSqsEvent([{}]));

      const expectedOpts: ForwardOptions = { senderDomain: "example.com", dkimPass: true, dmarcPass: true };
      expect(forwarder.forward).toHaveBeenCalledTimes(2);
      expect(forwarder.forward).toHaveBeenCalledWith(expect.any(String), "first@example.com", TEST_ACCOUNT_ID, expectedOpts);
      expect(forwarder.forward).toHaveBeenCalledWith(expect.any(String), "second@example.com", TEST_ACCOUNT_ID, expectedOpts);
    });

    it("does not forward when rule does not match", async () => {
      const rule: Rule = {
        id: "rule-no-match",
        accountId: TEST_ACCOUNT_ID,
        name: "Forward invoices",
        condition: '{"==": [{"var": "arc.workflow"}, "invoice"]}',
        actions: [{ type: "forward", value: "accountant@firm.com" }],
        position: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listRules).mockResolvedValueOnce([rule]);
      vi.mocked(ruleEvaluator.evaluate).mockReturnValueOnce(false);

      await processor.process(makeSqsEvent([{}]));

      expect(forwarder.forward).not.toHaveBeenCalled();
    });

    it("forwards after arc and signal are saved", async () => {
      const callOrder: string[] = [];
      vi.mocked(store.saveSignal).mockImplementation(async () => { callOrder.push("saveSignal"); });
      vi.mocked(forwarder.forward).mockImplementation(async () => { callOrder.push("forward"); });

      const rule: Rule = {
        id: "rule-fwd",
        accountId: TEST_ACCOUNT_ID,
        name: "Forward all",
        condition: "true",
        actions: [{ type: "forward", value: "copy@example.com" }],
        position: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listRules).mockResolvedValueOnce([rule]);
      vi.mocked(ruleEvaluator.evaluate).mockReturnValueOnce(true);

      await processor.process(makeSqsEvent([{}]));

      expect(callOrder.indexOf("saveSignal")).toBeLessThan(callOrder.indexOf("forward"));
    });

    it("continues processing when forwarder throws", async () => {
      vi.mocked(forwarder.forward).mockRejectedValueOnce(new Error("SES throttle"));
      const rule: Rule = {
        id: "rule-fwd",
        accountId: TEST_ACCOUNT_ID,
        name: "Forward all",
        condition: "true",
        actions: [{ type: "forward", value: "copy@example.com" }],
        position: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listRules).mockResolvedValueOnce([rule]);
      vi.mocked(ruleEvaluator.evaluate).mockReturnValueOnce(true);

      await processor.process(makeSqsEvent([{}]));

      // Signal was still saved despite forward failure
      expect(store.saveSignal).toHaveBeenCalledOnce();
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
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeEmailAddressConfig({ approvedSenders: ["example.com"] }) },
      );

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveSignal).toHaveBeenCalledOnce();
      expect(store.saveArc).toHaveBeenCalledOnce();
      expect(store.saveEmailAddressConfig).not.toHaveBeenCalled(); // no auto-approve needed
    });

    it("quarantines signal from unknown sender by default (notify user for review)", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeEmailAddressConfig({ approvedSenders: ["trusted.com"] }) }, // sender is example.com, not trusted.com
      );

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveArc).not.toHaveBeenCalled();
      expect(store.saveSignal).toHaveBeenCalledOnce();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantined");
      expect(saved.blockReason).toBe("new_sender");
      expect(saved.arcId).toBeUndefined();
    });

    it("silently blocks signal when blockDisposition.new_sender is 'block'", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
        retentionDays: 0,
        emailConfig: makeEmailAddressConfig({ approvedSenders: ["trusted.com"] }),
        filtering: { defaultFilterMode: "notify_new", newAddressHandling: "auto_allow", blockDisposition: { new_sender: "block" } },
      });

      await processor.process(makeSqsEvent([{}]));

      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("blocked");
      expect(notifier.notifyBlocked).not.toHaveBeenCalled();
    });

    it("calls notifyBlocked when a signal is quarantined", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeEmailAddressConfig({ approvedSenders: ["other.com"] }) },
      );

      await processor.process(makeSqsEvent([{}]));

      expect(notifier.notifyBlocked).toHaveBeenCalledOnce();
      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it("does NOT call notifyBlocked when a signal is silently blocked", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
        retentionDays: 0,
        emailConfig: makeEmailAddressConfig({ approvedSenders: ["other.com"] }),
        filtering: { defaultFilterMode: "notify_new", newAddressHandling: "auto_allow", blockDisposition: { new_sender: "block" } },
      });

      await processor.process(makeSqsEvent([{}]));

      expect(notifier.notifyBlocked).not.toHaveBeenCalled();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("blocked");
    });

    it("does not fail when notifyBlocked throws", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeEmailAddressConfig({ approvedSenders: [] }) },
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

      await processor.process(makeSqsEvent([{}]));

      // Filtering logic was bypassed — signal is active despite restrictive default config
      expect(store.saveArc).toHaveBeenCalledOnce();
      expect(store.saveSignal).toHaveBeenCalledOnce();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("active");
    });

    it("strict mode quarantines a known sender with high spam score (default disposition)", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeEmailAddressConfig({ filterMode: "strict", approvedSenders: ["example.com"] }) },
      );
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        spamScore: 0.8,
      });

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveArc).not.toHaveBeenCalled();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantined");
      expect(saved.blockReason).toBe("spam");
    });

    it("allow_all mode auto-approves new sender without blocking", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeEmailAddressConfig({ filterMode: "allow_all", approvedSenders: [] }) },
      );

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveArc).toHaveBeenCalledOnce();
      const savedConfig = vi.mocked(store.saveEmailAddressConfig).mock.calls[0]![0] as EmailAddressConfig;
      expect(savedConfig.approvedSenders).toContain("example.com");
    });

    it("saves blocked signal with classification data for user review", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeEmailAddressConfig({ approvedSenders: [] }) },
      );

      await processor.process(makeSqsEvent([{}]));

      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.workflow).toBe(validClassification.workflow);
      expect(saved.summary).toBe(validClassification.summary);
      expect(saved.spamScore).toBe(validClassification.spamScore);
    });

    it("quarantines new address when newAddressHandling is block_until_approved (default disposition)", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
        retentionDays: 0,
        filtering: { newAddressHandling: "block_until_approved", defaultFilterMode: "notify_new" },
        emailConfig: null,
      });

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveArc).not.toHaveBeenCalled();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantined");
      expect(saved.blockReason).toBe("new_sender");
    });
  });

  // -------------------------------------------------------------------------
  // Global reputation tracking
  // -------------------------------------------------------------------------

  describe("global reputation tracking", () => {
    it("updates reputation with wasBlocked=true for blocked signals", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeEmailAddressConfig({ approvedSenders: [] }) },
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

  describe("baseUrgency", () => {
    it("auth is always critical", () => {
      expect(baseUrgency("auth", { workflow: "auth", authType: "otp", service: "GitHub" })).toBe("critical");
    });

    it("financial is critical only when isSuspicious", () => {
      expect(baseUrgency("financial", { workflow: "financial", financialType: "fraud_alert", institution: "Chase", isSuspicious: true })).toBe("critical");
      expect(baseUrgency("financial", { workflow: "financial", financialType: "statement", institution: "Chase" })).toBe("normal");
    });

    it("notice is always silent", () => {
      expect(baseUrgency("notice", { workflow: "notice", noticeType: "privacy_policy", provider: "Google" })).toBe("silent");
    });

    it("newsletter is low (opted-in, not urgent)", () => {
      expect(baseUrgency("newsletter", { workflow: "newsletter", publication: "TLDR", topics: [] })).toBe("low");
    });
  });

  describe("priorityCalculator", () => {
    it("returns base urgency when arc has no sent messages", () => {
      const arc = makeArc({ sentMessageIds: undefined });
      const signal = { workflow: "personal", workflowData: { workflow: "personal", isReply: false, sentiment: "neutral", requiresReply: false } } as Parameters<typeof priorityCalculator>[1];
      expect(priorityCalculator(arc, signal)).toBe("normal");
    });

    it("promotes to at least high when arc has sent messages", () => {
      const arc = makeArc({ sentMessageIds: ["<msg-001@example.com>"] });
      const signal = { workflow: "newsletter", workflowData: { workflow: "newsletter", publication: "TLDR", topics: [] } } as Parameters<typeof priorityCalculator>[1];
      expect(priorityCalculator(arc, signal)).toBe("high");
    });

    it("does not demote critical when arc has sent messages", () => {
      const arc = makeArc({ sentMessageIds: ["<msg-001@example.com>"] });
      const signal = { workflow: "auth", workflowData: { workflow: "auth", authType: "otp", service: "GitHub" } } as Parameters<typeof priorityCalculator>[1];
      expect(priorityCalculator(arc, signal)).toBe("critical");
    });
  });

  // -------------------------------------------------------------------------
  // dispositionFor unit tests
  // -------------------------------------------------------------------------

  describe("dispositionFor", () => {
    it("defaults to quarantine when no config provided", () => {
      expect(dispositionFor("new_sender", null)).toBe("quarantine");
      expect(dispositionFor("spam", undefined)).toBe("quarantine");
      expect(dispositionFor("onboarding", null)).toBe("quarantine");
    });

    it("returns quarantine when blockDisposition is absent from config", () => {
      const config: AccountFilteringConfig = { defaultFilterMode: "notify_new", newAddressHandling: "auto_allow" };
      expect(dispositionFor("new_sender", config)).toBe("quarantine");
    });

    it("returns block when explicitly configured for a reason", () => {
      const config: AccountFilteringConfig = {
        defaultFilterMode: "notify_new",
        newAddressHandling: "auto_allow",
        blockDisposition: { new_sender: "block", spam: "block" },
      };
      expect(dispositionFor("new_sender", config)).toBe("block");
      expect(dispositionFor("spam", config)).toBe("block");
    });

    it("falls back to quarantine for reasons not in blockDisposition", () => {
      const config: AccountFilteringConfig = {
        defaultFilterMode: "notify_new",
        newAddressHandling: "auto_allow",
        blockDisposition: { spam: "block" },
      };
      expect(dispositionFor("new_sender", config)).toBe("quarantine");
      expect(dispositionFor("onboarding", config)).toBe("quarantine");
    });
  });

  // -------------------------------------------------------------------------
  // Onboarding filtering
  // -------------------------------------------------------------------------

  describe("onboarding filtering", () => {
    const onboardingClassification: ClassificationOutput = {
      workflow: "onboarding",
      workflowData: { workflow: "onboarding", service: "Acme App", onboardingType: "welcome" },
      spamScore: 0.02,
      summary: "Welcome to Acme App.",
      labels: [],
      classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
    };

    it("allows onboarding emails when no onboarding blocking is configured", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(onboardingClassification);

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveArc).toHaveBeenCalledOnce();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("active");
    });

    it("quarantines onboarding emails when global blockOnboardingEmails is true (default disposition)", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(onboardingClassification);
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
        retentionDays: 0,
        filtering: { defaultFilterMode: "notify_new", newAddressHandling: "auto_allow", blockOnboardingEmails: true },
        emailConfig: null,
      });

      const notifier = makeNotifier();
      const proc = new SignalProcessor({ store, mimeParser, classifier, arcMatcher, ruleEvaluator, notifier });
      await proc.process(makeSqsEvent([{}]));

      expect(store.saveArc).not.toHaveBeenCalled();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantined");
      expect(saved.blockReason).toBe("onboarding");
      expect(notifier.notifyBlocked).toHaveBeenCalledOnce();
    });

    it("silently blocks onboarding emails when global blockDisposition.onboarding is 'block'", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(onboardingClassification);
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
        retentionDays: 0,
        filtering: { defaultFilterMode: "notify_new", newAddressHandling: "auto_allow", blockOnboardingEmails: true, blockDisposition: { onboarding: "block" } },
        emailConfig: null,
      });

      const notifier = makeNotifier();
      const proc = new SignalProcessor({ store, mimeParser, classifier, arcMatcher, ruleEvaluator, notifier });
      await proc.process(makeSqsEvent([{}]));

      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("blocked");
      expect(notifier.notifyBlocked).not.toHaveBeenCalled();
    });

    it("quarantines onboarding when per-address onboardingEmailHandling is 'quarantine'", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(onboardingClassification);
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeEmailAddressConfig({ onboardingEmailHandling: "quarantine" }) },
      );

      const notifier = makeNotifier();
      const proc = new SignalProcessor({ store, mimeParser, classifier, arcMatcher, ruleEvaluator, notifier });
      await proc.process(makeSqsEvent([{}]));

      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantined");
      expect(saved.blockReason).toBe("onboarding");
      expect(notifier.notifyBlocked).toHaveBeenCalledOnce();
    });

    it("silently blocks onboarding when per-address onboardingEmailHandling is 'block'", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(onboardingClassification);
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeEmailAddressConfig({ onboardingEmailHandling: "block" }) },
      );

      const notifier = makeNotifier();
      const proc = new SignalProcessor({ store, mimeParser, classifier, arcMatcher, ruleEvaluator, notifier });
      await proc.process(makeSqsEvent([{}]));

      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("blocked");
      expect(notifier.notifyBlocked).not.toHaveBeenCalled();
    });

    it("allows onboarding when per-address onboardingEmailHandling is 'allow', even if global blocks", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(onboardingClassification);
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
        retentionDays: 0,
        emailConfig: makeEmailAddressConfig({ onboardingEmailHandling: "allow" }),
        filtering: { defaultFilterMode: "notify_new", newAddressHandling: "auto_allow", blockOnboardingEmails: true },
      });

      await processor.process(makeSqsEvent([{}]));

      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("active");
    });
  });
});
