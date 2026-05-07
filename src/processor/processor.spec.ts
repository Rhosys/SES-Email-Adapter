import { randomUUID } from "crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SQSEvent } from "aws-lambda";
import { SignalProcessor, deriveGroupingKey, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import { baseUrgency } from "./priority.js";
import type { ProcessorDatabase, ArcMatcher, RuleEvaluator, Notifier, Forwarder, ForwardOptions, TestReplier } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { Arc, Rule, Signal, Alias, AccountFilteringConfig } from "../types/index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-001";

// Default context: sender example.com is pre-approved so most tests exercise the happy path without triggering the filter-mode fallback.
// Tests that specifically test sender filtering use explicit mockResolvedValueOnce overrides.
const DEFAULT_EMAIL_CONFIG: Alias = {
  id: "cfg-default", accountId: "acct-test-001", address: "user@example.com",
  filterMode: "quarantine_visible",
  createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
};

// Default AliasSender: marks example.com as an allowed sender for the default alias.
const DEFAULT_SENDER_ENTRY: import("../types/index.js").AliasSender = {
  accountId: "acct-test-001", aliasAddress: "user@example.com", domain: "example.com", mode: "allow", addedAt: "2024-01-01T00:00:00Z",
};
const DEFAULT_CTX = { retentionDays: 0, filtering: null, emailConfig: DEFAULT_EMAIL_CONFIG, registeredDomains: [], userEmails: [] };

function makeStore(): ProcessorDatabase {
  return {
    getSignalByMessageId: vi.fn().mockResolvedValue(null),
    saveSignal: vi.fn().mockResolvedValue(undefined),
    getArc: vi.fn().mockResolvedValue(null),
    findArcByGroupingKey: vi.fn().mockResolvedValue(null),
    saveArc: vi.fn().mockResolvedValue(undefined),
    listEnabledRules: vi.fn().mockResolvedValue(SYSTEM_RULES),
    getProcessorAccountContext: vi.fn().mockResolvedValue(DEFAULT_CTX),
    saveAlias: vi.fn().mockImplementation((a: Alias) => Promise.resolve(a)),
    getSender: vi.fn().mockResolvedValue(DEFAULT_SENDER_ENTRY),
    saveSender: vi.fn().mockResolvedValue(undefined),
    getTemplate: vi.fn().mockResolvedValue(null),
    updateGlobalReputation: vi.fn().mockResolvedValue(undefined),
    getDomainByName: vi.fn().mockResolvedValue(null),
  };
}

function makeTestReplier(): TestReplier {
  return {
    pong: vi.fn().mockResolvedValue({ messageId: "pong-msg-001" }),
  };
}

function makeAlias(overrides: Partial<Alias> = {}): Alias {
  return {
    id: "cfg-001",
    accountId: TEST_ACCOUNT_ID,
    address: "user@example.com",
    filterMode: "quarantine_visible",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

// Helper to make an AliasSender entry (approved sender for a given alias+domain).
function makeSenderEntry(domain: string, aliasAddress = "user@example.com"): import("../types/index.js").AliasSender {
  return { accountId: TEST_ACCOUNT_ID, aliasAddress, domain, mode: "allow", addedAt: "2024-01-01T00:00:00Z" };
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
    classify: vi.fn().mockImplementation(() => Promise.resolve({ ...validClassification })),
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
  return new JsonLogicRuleEvaluator();
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
  workflow: "conversation",
  workflowData: {
    workflow: "conversation",
    isReply: false,
    sentiment: "neutral",
    requiresReply: false,
  },
  spamScore: 0.05,
  summary: "A test personal email.",
  labels: [],
  classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
};

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: randomUUID(),
    accountId: TEST_ACCOUNT_ID,
    name: "Test rule",
    condition: "true",
    actions: [],
    status: "enabled",
    priorityOrder: 100,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeArc(overrides: Partial<Arc> = {}): Arc {
  return {
    id: "arc-existing",
    accountId: TEST_ACCOUNT_ID,
    workflow: "conversation",
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
      expect(saved.workflow).toBe("conversation");
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
        workflow: "payments",
        summary: "Receipt from Stripe for $99.",
        labels: ["billing"],
        workflowData: {
          workflow: "payments",
          paymentType: "receipt",
          vendor: "Stripe",
          amount: 99,
          currency: "USD",
        },
      });

      await processor.process(makeSqsEvent([{}]));

      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.workflow).toBe("payments");
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
        condition: "true",
        actions: [{ type: "assign_label", value: "billing" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([rule]);

      await processor.process(makeSqsEvent([{}]));

      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.labels).toContain("billing");
    });

    it("archives Arc when archive action matches", async () => {
      const rule: Rule = {
        id: "rule-2",
        accountId: TEST_ACCOUNT_ID,
        name: "Archive newsletters",
        condition: "true",
        actions: [{ type: "archive" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([rule]);

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
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([rule]);

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
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([rule]);

      await processor.process(makeSqsEvent([{}]));

      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.labels).not.toContain("important");
    });

    it("collects forward addresses from matching rules but does not call forwarder when none configured", async () => {
      const rule: Rule = {
        id: "rule-fwd",
        accountId: TEST_ACCOUNT_ID,
        name: "Forward all",
        condition: "true",
        actions: [{ type: "forward", value: "backup@personal.com" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([rule]);

      // No error — processor without forwarder silently skips forward actions
      await processor.process(makeSqsEvent([{}]));

      expect(store.saveSignal).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // matchedRules
  // -------------------------------------------------------------------------

  describe("matchedRules", () => {
    it("writes matched rule with labelsAdded to signal", async () => {
      const rule: Rule = {
        id: "rule-label",
        accountId: TEST_ACCOUNT_ID,
        name: "Tag billing",
        condition: "true",
        actions: [{ type: "assign_label", value: "billing" }],
        status: "enabled",
        priorityOrder: 100,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([rule]);

      await processor.process(makeSqsEvent([{}]));

      const signal = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.matchedRules).toHaveLength(1);
      expect(signal.matchedRules![0]!.ruleId).toBe("rule-label");
      expect(signal.matchedRules![0]!.labelsAdded).toContain("billing");
      expect(signal.matchedRules![0]!.statusChange).toBeUndefined();
    });

    it("writes statusChange on the matching rule for a quarantined signal", async () => {
      const rule: Rule = {
        id: "rule-quarantine",
        accountId: TEST_ACCOUNT_ID,
        name: "Quarantine unknown",
        condition: "true",
        actions: [{ type: "quarantine" }],
        status: "enabled",
        priorityOrder: 100,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([rule]);
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
        ...DEFAULT_CTX,
        emailConfig: { ...DEFAULT_EMAIL_CONFIG, filterMode: "allow_all" },
      });

      await processor.process(makeSqsEvent([{}]));

      const signal = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.status).toBe("quarantine_visible");
      expect(signal.matchedRules).toHaveLength(1);
      expect(signal.matchedRules![0]!.statusChange).toBe("quarantine_visible");
    });

    it("does not include rules that did not match", async () => {
      const matching: Rule = { ...makeRule({ id: "r-match", name: "Matches", condition: "true", actions: [{ type: "archive" }] }) };
      const nonMatching: Rule = { ...makeRule({ id: "r-skip", name: "Never", condition: '{"==": [1, 2]}', actions: [{ type: "block" }] }) };
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([matching, nonMatching]);

      await processor.process(makeSqsEvent([{}]));

      const signal = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.matchedRules?.map((r) => r.ruleId)).toEqual(["r-match"]);
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
        condition: "true",
        actions: [{ type: "forward", value: "backup@personal.com" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([rule]);

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
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([rule]);

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
        condition: '{"==": [1, 2]}',
        actions: [{ type: "forward", value: "accountant@firm.com" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([rule]);

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
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([rule]);

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
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([rule]);

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

    it("does not call notifier when spamScore >= 0.9", async () => {
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

    it("allows signal on brand new address and auto-creates aliases with sender approved", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: null },
      );
      // No existing sender entry for a brand-new address
      vi.mocked(store.getSender).mockResolvedValueOnce(null);
      await processor.process(makeSqsEvent([{}]));

      expect(store.saveSignal).toHaveBeenCalledOnce();
      expect(store.saveArc).toHaveBeenCalledOnce();
      expect(store.saveAlias).toHaveBeenCalledOnce();

      const savedConfig = vi.mocked(store.saveAlias).mock.calls[0]![0] as Alias;
      expect(savedConfig.filterMode).toBe("quarantine_visible");
      expect(store.saveSender).toHaveBeenCalledWith(TEST_ACCOUNT_ID, expect.any(String), "example.com", "allow");
    });

    it("allows signal from a known sender (eTLD+1 in approved list)", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeAlias() },
      );
      // getSender returns an approved entry for example.com (default mock already does this)

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveSignal).toHaveBeenCalledOnce();
      expect(store.saveArc).toHaveBeenCalledOnce();
      expect(store.saveAlias).not.toHaveBeenCalled(); // no auto-approve needed
    });

    it("unknown sender → SR-02 fires → quarantine_hidden (not surfaced in review queue)", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeAlias() },
      );
      vi.mocked(store.getSender).mockResolvedValueOnce(null);

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveArc).not.toHaveBeenCalled();
      expect(store.saveSignal).toHaveBeenCalledOnce();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantine_hidden");
      expect(saved.arcId).toBeUndefined();
    });

    it("does NOT call notifyBlocked when SR-02 quarantines an untrusted sender (quarantine_hidden)", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeAlias() },
      );
      vi.mocked(store.getSender).mockResolvedValueOnce(null);

      await processor.process(makeSqsEvent([{}]));

      expect(notifier.notifyBlocked).not.toHaveBeenCalled();
    });

    it("calls notifyBlocked when a signal is quarantine_visible (e.g. high-spam from approved sender)", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeAlias() },
      );
      // DEFAULT_SENDER_ENTRY is approved → SR-02 does not fire; high spam → SR-03 fires (quarantine_visible)
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        spamScore: 0.95,
      });

      await processor.process(makeSqsEvent([{}]));

      expect(notifier.notifyBlocked).toHaveBeenCalledOnce();
      expect(notifier.notify).not.toHaveBeenCalled();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantine_visible");
    });

    it("filter mode fallback: quarantine_visible produces quarantine_visible + notifies when SR-02 is disabled", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeAlias({ filterMode: "quarantine_visible" }) },
      );
      vi.mocked(store.getSender).mockResolvedValueOnce(null);
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([]); // no rules → fallback applies

      await processor.process(makeSqsEvent([{}]));

      expect(notifier.notifyBlocked).toHaveBeenCalledOnce();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantine_visible");
    });

    it("filter mode fallback: quarantine_hidden produces quarantine_hidden + does not notify when SR-02 is disabled", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeAlias({ filterMode: "quarantine_hidden" }) },
      );
      vi.mocked(store.getSender).mockResolvedValueOnce(null);
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([]); // no rules → fallback applies

      await processor.process(makeSqsEvent([{}]));

      expect(notifier.notifyBlocked).not.toHaveBeenCalled();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantine_hidden");
    });

    it("does NOT call notifyBlocked when a signal is silently blocked by a block rule", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeAlias() },
      );
      vi.mocked(store.getSender).mockResolvedValueOnce(null);
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([
        makeRule({ condition: JSON.stringify({ "in": ["system:sender:untrusted", { var: "arc.labels" }] }), actions: [{ type: "block" }] }),
      ]);

      await processor.process(makeSqsEvent([{}]));

      expect(notifier.notifyBlocked).not.toHaveBeenCalled();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("blocked");
    });

    it("does not fail when notifyBlocked throws (quarantine_visible via SR-03)", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeAlias() },
      );
      // Approved sender + high spam → SR-03 fires → quarantine_visible → notifyBlocked called
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        spamScore: 0.95,
      });
      vi.mocked(notifier.notifyBlocked).mockRejectedValueOnce(new Error("SES error"));

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveSignal).toHaveBeenCalledOnce();
    });

    it("bypasses filtering when signal matches an existing Arc", async () => {
      const existingArc: Arc = {
        id: "existing-arc",
        accountId: TEST_ACCOUNT_ID,
        workflow: "conversation",
        labels: [],
        status: "active",
        summary: "Existing conversation",
        lastSignalAt: "2024-01-14T10:00:00Z",
        createdAt: "2024-01-14T10:00:00Z",
        updatedAt: "2024-01-14T10:00:00Z",
      };
      vi.mocked(arcMatcher.findMatch).mockResolvedValueOnce(existingArc);

      await processor.process(makeSqsEvent([{}]));

      // Filtering fallback bypassed on matched arc — signal is active despite untrusted sender
      expect(store.saveArc).toHaveBeenCalledOnce();
      expect(store.saveSignal).toHaveBeenCalledOnce();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("active");
    });

    it("quarantines a known sender with high spam score (SR-03 fires regardless of filter mode)", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeAlias({ filterMode: "quarantine_visible" }) },
      );
      // Sender is known/approved but spam score is too high — SR-03 quarantines independently of filter mode
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        spamScore: 0.95,
      });

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveArc).not.toHaveBeenCalled();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantine_visible");
    });

    it("allow_all mode auto-approves new sender without blocking", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeAlias({ filterMode: "allow_all" }) },
      );
      vi.mocked(store.getSender).mockResolvedValueOnce(null); // sender not yet in list

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveArc).toHaveBeenCalledOnce();
      expect(store.saveSender).toHaveBeenCalledWith(TEST_ACCOUNT_ID, expect.any(String), "example.com", "allow");
    });

    it("saves blocked signal with classification data for user review", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeAlias() },
      );
      vi.mocked(store.getSender).mockResolvedValueOnce(null);

      await processor.process(makeSqsEvent([{}]));

      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.workflow).toBe(validClassification.workflow);
      expect(saved.summary).toBe(validClassification.summary);
      expect(saved.spamScore).toBe(validClassification.spamScore);
    });

    it("quarantines new address when newAddressHandling is block_until_approved (default disposition)", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
        retentionDays: 0,
        filtering: { newAddressHandling: "block_until_approved", defaultFilterMode: "quarantine_visible" },
        emailConfig: null,
        registeredDomains: [],
        userEmails: [],
      });

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveArc).not.toHaveBeenCalled();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      // emailConfig is null → effectiveSenderEntry = null → system:sender:untrusted applied → SR-02 fires → quarantine_hidden
      expect(saved.status).toBe("quarantine_hidden");
    });
  });

  // -------------------------------------------------------------------------
  // Global reputation tracking
  // -------------------------------------------------------------------------

  describe("global reputation tracking", () => {
    it("updates reputation with wasBlocked=true for blocked signals", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce(
        { ...DEFAULT_CTX, emailConfig: makeAlias() },
      );
      vi.mocked(store.getSender).mockResolvedValueOnce(null);

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

    it("marks wasSpam=true when spamScore >= 0.9", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        spamScore: 0.97,
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
        workflow: "package",
        workflowData: { workflow: "package", packageType: "shipping", retailer: "Amazon", orderNumber: "112-999" },
      });

      await processor.process(makeSqsEvent([{}]));

      expect(store.findArcByGroupingKey).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        "user@example.com:package:112-999",
      );
    });

    it("falls back to vector search for package without order number", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        workflow: "package",
        workflowData: { workflow: "package", packageType: "shipping", retailer: "Amazon" },
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

    it("returns null for conversation (vector search)", () => {
      expect(deriveGroupingKey("conversation", { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false }, "me@example.com", "friend.com"))
        .toBeNull();
    });

    it("uses senderETLD1 grouping for test workflow", () => {
      expect(deriveGroupingKey("test", { workflow: "test", triggeredBy: "user" }, "me@example.com", "mydomain.com"))
        .toBe("me@example.com:test:mydomain.com");
    });

    it("uses senderETLD1 grouping for status workflow (threads all notices from same sender)", () => {
      expect(deriveGroupingKey("status", { workflow: "status", statusType: "privacy_policy", provider: "Google" }, "me@example.com", "google.com"))
        .toBe("me@example.com:status:google.com");
    });

    it("uses senderETLD1 grouping for payments workflow", () => {
      expect(deriveGroupingKey("payments", { workflow: "payments", paymentType: "receipt", vendor: "Stripe" }, "me@example.com", "stripe.com"))
        .toBe("me@example.com:payments:stripe.com");
    });

    it("uses senderETLD1 grouping for content workflow", () => {
      expect(deriveGroupingKey("content", { workflow: "content", contentType: "newsletter", publisher: "TLDR" }, "me@example.com", "tldr.tech"))
        .toBe("me@example.com:content:tldr.tech");
    });

    it("uses senderETLD1 grouping for alert workflow", () => {
      expect(deriveGroupingKey("alert", { workflow: "alert", alertType: "suspicious_login", service: "GitHub", requiresAction: true }, "me@example.com", "github.com"))
        .toBe("me@example.com:alert:github.com");
    });

    it("uses orderNumber as key for package workflow when present", () => {
      expect(deriveGroupingKey("package", { workflow: "package", packageType: "shipping", retailer: "Amazon", orderNumber: "112-999" }, "me@example.com", "amazon.com"))
        .toBe("me@example.com:package:112-999");
    });

    it("returns null for package without orderNumber (falls back to vector search)", () => {
      expect(deriveGroupingKey("package", { workflow: "package", packageType: "shipping", retailer: "Amazon" }, "me@example.com", "amazon.com"))
        .toBeNull();
    });

    it("uses ticketId as key for support workflow when present", () => {
      expect(deriveGroupingKey("support", { workflow: "support", eventType: "ticket_updated", service: "Zendesk", ticketId: "ZD-4567" }, "me@example.com", "zendesk.com"))
        .toBe("me@example.com:support:ZD-4567");
    });

    it("returns null for support without ticketId (falls back to vector search)", () => {
      expect(deriveGroupingKey("support", { workflow: "support", eventType: "ticket_opened", service: "Zendesk" }, "me@example.com", "zendesk.com"))
        .toBeNull();
    });

    it("returns null for travel (vector search workflow)", () => {
      expect(deriveGroupingKey("travel", { workflow: "travel", travelType: "flight", provider: "Delta" }, "me@example.com", "delta.com"))
        .toBeNull();
    });
  });

  describe("baseUrgency", () => {
    it("auth is always critical", () => {
      expect(baseUrgency("auth", { workflow: "auth", authType: "otp", service: "GitHub" })).toBe("critical");
    });

    it("alert is critical when requiresAction=true", () => {
      expect(baseUrgency("alert", { workflow: "alert", alertType: "suspicious_login", service: "GitHub", requiresAction: true })).toBe("critical");
      expect(baseUrgency("alert", { workflow: "alert", alertType: "fraud_alert", service: "Chase", requiresAction: true })).toBe("critical");
      expect(baseUrgency("alert", { workflow: "alert", alertType: "ci_failure", service: "GitHub Actions", requiresAction: true })).toBe("critical");
    });

    it("alert is high when requiresAction=false", () => {
      expect(baseUrgency("alert", { workflow: "alert", alertType: "new_device", service: "GitHub", requiresAction: false })).toBe("high");
      expect(baseUrgency("alert", { workflow: "alert", alertType: "domain_expiry", service: "Cloudflare", requiresAction: false })).toBe("high");
    });

    it("payments is critical on payment_failed", () => {
      expect(baseUrgency("payments", { workflow: "payments", paymentType: "payment_failed", vendor: "Stripe" })).toBe("critical");
    });

    it("payments is normal for all other payment types", () => {
      expect(baseUrgency("payments", { workflow: "payments", paymentType: "invoice", vendor: "Stripe" })).toBe("normal");
      expect(baseUrgency("payments", { workflow: "payments", paymentType: "receipt", vendor: "AWS" })).toBe("normal");
      expect(baseUrgency("payments", { workflow: "payments", paymentType: "subscription_renewal", vendor: "GitHub" })).toBe("normal");
    });

    it("test is always high (user is actively waiting for inbox confirmation)", () => {
      expect(baseUrgency("test", { workflow: "test", triggeredBy: "user" })).toBe("high");
    });

    it("support falls through to normal (urgency handled by system rules SR-20–SR-24)", () => {
      expect(baseUrgency("support", { workflow: "support", eventType: "ticket_updated", service: "Zendesk", priority: "urgent" })).toBe("normal");
      expect(baseUrgency("support", { workflow: "support", eventType: "awaiting_response", service: "Zendesk" })).toBe("normal");
      expect(baseUrgency("support", { workflow: "support", eventType: "ticket_opened", service: "Zendesk" })).toBe("normal");
    });

    it("content is always low", () => {
      expect(baseUrgency("content", { workflow: "content", contentType: "newsletter", publisher: "TLDR" })).toBe("low");
      expect(baseUrgency("content", { workflow: "content", contentType: "promotion", publisher: "Nike" })).toBe("low");
    });

    it("status is always silent", () => {
      expect(baseUrgency("status", { workflow: "status", statusType: "privacy_policy", provider: "Google" })).toBe("silent");
      expect(baseUrgency("status", { workflow: "status", statusType: "service_notice", provider: "Stripe" })).toBe("silent");
    });

    it("onboarding is always silent", () => {
      expect(baseUrgency("onboarding", { workflow: "onboarding", onboardingType: "welcome", service: "Acme" })).toBe("silent");
    });

    it("travel is normal (no special urgency boost)", () => {
      expect(baseUrgency("travel", { workflow: "travel", travelType: "flight", provider: "Delta" })).toBe("normal");
    });

    it("conversation falls through to normal (urgency handled by system rules SR-15–SR-16)", () => {
      expect(baseUrgency("conversation", { workflow: "conversation", isReply: false, sentiment: "urgent", requiresReply: true })).toBe("normal");
      expect(baseUrgency("conversation", { workflow: "conversation", isReply: false, sentiment: "positive", requiresReply: false })).toBe("normal");
      expect(baseUrgency("conversation", { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false })).toBe("normal");
    });

    it("crm falls through to normal (urgency handled by system rules SR-17–SR-19)", () => {
      expect(baseUrgency("crm", { workflow: "crm", crmType: "contract", urgency: "low", requiresReply: false })).toBe("normal");
      expect(baseUrgency("crm", { workflow: "crm", crmType: "sales_outreach", urgency: "high", requiresReply: true })).toBe("normal");
      expect(baseUrgency("crm", { workflow: "crm", crmType: "follow_up", urgency: "medium", requiresReply: false })).toBe("normal");
    });
  });

  // -------------------------------------------------------------------------
  // Workflow-specific urgency rules (SR-15–SR-24)
  // -------------------------------------------------------------------------

  describe("workflow urgency system rules", () => {
    async function processWithWorkflow(classification: Partial<ClassificationOutput>): Promise<Arc> {
      const full: ClassificationOutput = {
        workflow: "conversation",
        workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
        spamScore: 0.05, summary: "test", labels: [],
        classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
        ...classification,
      };
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(full);
      await processor.process(makeSqsEvent([{ sesMessageId: randomUUID() }]));
      return vi.mocked(store.saveArc).mock.calls.at(-1)![0] as Arc;
    }

    it("SR-15: conversation + requiresReply + urgent sentiment → high urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "conversation", workflowData: { workflow: "conversation", isReply: false, sentiment: "urgent", requiresReply: true } });
      expect(arc.urgency).toBe("high");
    });

    it("SR-15: conversation + requiresReply + negative sentiment → high urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "conversation", workflowData: { workflow: "conversation", isReply: false, sentiment: "negative", requiresReply: true } });
      expect(arc.urgency).toBe("high");
    });

    it("SR-16: conversation with no prior replies → low urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "conversation", workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false } });
      expect(arc.urgency).toBe("low");
    });

    it("SR-16: conversation with prior replies (system:replied) → not low (falls back to arc urgency)", async () => {
      vi.mocked(arcMatcher.findMatch).mockResolvedValueOnce(makeArc({
        workflow: "conversation", labels: [], urgency: "normal",
        sentMessageIds: ["<prior-msg@example.com>"],
      }));
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        workflow: "conversation", workflowData: { workflow: "conversation", isReply: true, sentiment: "neutral", requiresReply: false },
        spamScore: 0.05, summary: "test", labels: [], classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
      });
      await processor.process(makeSqsEvent([{ sesMessageId: randomUUID() }]));
      const signal = vi.mocked(store.saveSignal).mock.calls.at(-1)![0] as Signal;
      expect(signal.urgency).toBe("normal");
    });

    it("SR-17: crm + contract → high urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "crm", workflowData: { workflow: "crm", crmType: "contract", urgency: "low", requiresReply: false } });
      expect(arc.urgency).toBe("high");
    });

    it("SR-17: crm + proposal → high urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "crm", workflowData: { workflow: "crm", crmType: "proposal", urgency: "low", requiresReply: false } });
      expect(arc.urgency).toBe("high");
    });

    it("SR-18: crm + urgency:high → high urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "crm", workflowData: { workflow: "crm", crmType: "sales_outreach", urgency: "high", requiresReply: true } });
      expect(arc.urgency).toBe("high");
    });

    it("SR-19: crm + urgency:low → low urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "crm", workflowData: { workflow: "crm", crmType: "sales_outreach", urgency: "low", requiresReply: false } });
      expect(arc.urgency).toBe("low");
    });

    it("crm + urgency:medium → normal urgency (label fallback)", async () => {
      const arc = await processWithWorkflow({ workflow: "crm", workflowData: { workflow: "crm", crmType: "follow_up", urgency: "medium", requiresReply: false } });
      expect(arc.urgency).toBe("normal");
    });

    it("SR-20: support + priority:urgent → critical urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "ticket_updated", service: "Zendesk", priority: "urgent" } });
      expect(arc.urgency).toBe("critical");
    });

    it("SR-21: support + priority:high → high urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "ticket_updated", service: "Zendesk", priority: "high" } });
      expect(arc.urgency).toBe("high");
    });

    it("SR-22: support + awaiting_response → high urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "awaiting_response", service: "Zendesk" } });
      expect(arc.urgency).toBe("high");
    });

    it("SR-23: support + priority:low → low urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "ticket_updated", service: "Zendesk", priority: "low" } });
      expect(arc.urgency).toBe("low");
    });

    it("SR-24: support + ticket_opened → low urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "ticket_opened", service: "Zendesk" } });
      expect(arc.urgency).toBe("low");
    });

    it("SR-24: support + ticket_resolved → low urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "ticket_resolved", service: "Zendesk" } });
      expect(arc.urgency).toBe("low");
    });

    it("SR-20 wins over SR-24: support + priority:urgent + ticket_opened → critical (first-rule-wins)", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "ticket_opened", service: "Zendesk", priority: "urgent" } });
      expect(arc.urgency).toBe("critical");
    });

  });

  // -------------------------------------------------------------------------
  // Onboarding workflow
  // -------------------------------------------------------------------------

  describe("onboarding workflow", () => {
    const onboardingClassification: ClassificationOutput = {
      workflow: "onboarding",
      workflowData: { workflow: "onboarding", onboardingType: "welcome", service: "Acme App" },
      spamScore: 0.02,
      summary: "Welcome to Acme App.",
      labels: [],
      classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
    };

    it("processes onboarding emails as active when no blocking rule is configured", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(onboardingClassification);
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([]); // no system rules — SR-01 (block onboarding) is disabled

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveArc).toHaveBeenCalledOnce();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("active");
      expect(saved.workflow).toBe("onboarding");
    });

    it("blocks onboarding emails when a block rule targeting system:workflow:onboarding is active", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(onboardingClassification);
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([
        makeRule({ condition: JSON.stringify({ "in": ["system:workflow:onboarding", { var: "arc.labels" }] }), actions: [{ type: "block" }] }),
      ]);

      const notifier = makeNotifier();
      const proc = new SignalProcessor({ store, mimeParser, classifier, arcMatcher, ruleEvaluator, notifier });
      await proc.process(makeSqsEvent([{}]));

      expect(store.saveArc).not.toHaveBeenCalled();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("blocked");
      expect(notifier.notifyBlocked).not.toHaveBeenCalled();
    });

    it("quarantines onboarding emails when a quarantine rule is active", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(onboardingClassification);
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([
        makeRule({ condition: JSON.stringify({ "in": ["system:workflow:onboarding", { var: "arc.labels" }] }), actions: [{ type: "quarantine" }] }),
      ]);

      const notifier = makeNotifier();
      const proc = new SignalProcessor({ store, mimeParser, classifier, arcMatcher, ruleEvaluator, notifier });
      await proc.process(makeSqsEvent([{}]));

      expect(store.saveArc).not.toHaveBeenCalled();
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      // Plain `quarantine` action → quarantine_visible (shown in review queue)
      expect(saved.status).toBe("quarantine_visible");
      expect(notifier.notifyBlocked).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Test email detection
  // -------------------------------------------------------------------------

  describe("test email detection", () => {
    it("overrides workflow to 'test' when from-domain matches a registered account domain", async () => {
      // Default mime parser mock returns from: { address: "sender@example.com" }
      // getETLD1("sender@example.com") = "example.com"
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
        ...DEFAULT_CTX,
        registeredDomains: ["example.com"],
      });

      await processor.process(makeSqsEvent([{}]));

      const signal = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.workflow).toBe("test");
      expect(signal.workflowData).toMatchObject({ workflow: "test", triggeredBy: "user" });
    });

    it("overrides workflow to 'test' when from-address exactly matches a userEmail (case-insensitive)", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
        ...DEFAULT_CTX,
        userEmails: ["SENDER@example.com"], // uppercase — must still match
      });

      await processor.process(makeSqsEvent([{}]));

      const signal = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.workflow).toBe("test");
    });

    it("does not override workflow when from-domain is not in registeredDomains and address not in userEmails", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
        ...DEFAULT_CTX,
        registeredDomains: ["otherdomain.com"],
        userEmails: ["different@email.com"],
      });

      await processor.process(makeSqsEvent([{}]));

      const signal = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.workflow).toBe("conversation"); // unchanged from validClassification mock
    });
  });

  // -------------------------------------------------------------------------
  // Notice workflow arc behavior
  // -------------------------------------------------------------------------

  const noticeClassification: ClassificationOutput = {
    workflow: "status",
    workflowData: { workflow: "status", statusType: "privacy_policy", provider: "Google" },
    spamScore: 0.0,
    summary: "Privacy policy update from Google.",
    labels: [],
    classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
  };

  describe("notice workflow arc behavior", () => {
    let notifier: Notifier;

    beforeEach(() => {
      notifier = makeNotifier();
      processor = new SignalProcessor({ store, mimeParser, classifier, arcMatcher, ruleEvaluator, notifier });
    });

    it("blocks status emails silently — no arc created, signal saved as blocked", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(noticeClassification);

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveArc).not.toHaveBeenCalled();
      const signal = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.status).toBe("blocked");
      expect(signal.workflow).toBe("status");
    });

    it("does not call notifier for a blocked status email", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(noticeClassification);

      await processor.process(makeSqsEvent([{}]));

      expect(notifier.notify).not.toHaveBeenCalled();
      expect(notifier.notifyBlocked).not.toHaveBeenCalled();
    });

    it("blocks status emails from untrusted senders (SR-05 rule fires, fallback does not apply)", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(noticeClassification);
      // Untrusted sender: no approved sender entry — filter-mode fallback would quarantine, but SR-05 fires first
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
        ...DEFAULT_CTX,
        emailConfig: makeAlias(),
      });
      vi.mocked(store.getSender).mockResolvedValueOnce(null);

      await processor.process(makeSqsEvent([{}]));

      const signal = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.status).toBe("blocked"); // SR-05 sets status → fallback skipped (hasStatusOutcome = true)
      expect(store.saveArc).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Pong auto-reply (test workflow)
  // -------------------------------------------------------------------------

  const testClassification: ClassificationOutput = {
    workflow: "test",
    workflowData: { workflow: "test", triggeredBy: "user" },
    spamScore: 0.0,
    summary: "Test email from account owner.",
    labels: [],
    classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
  };

  describe("pong auto-reply", () => {
    let testReplier: TestReplier;

    beforeEach(() => {
      testReplier = makeTestReplier();
      processor = new SignalProcessor({ store, mimeParser, classifier, arcMatcher, ruleEvaluator, testReplier });
    });

    it("sends a pong when workflow is 'test' and testReplier is configured", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(testClassification);

      await processor.process(makeSqsEvent([{}]));

      expect(testReplier.pong).toHaveBeenCalledOnce();
    });

    it("passes original sender as 'to', subject, and body to pong", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(testClassification);

      await processor.process(makeSqsEvent([{}]));

      const opts = vi.mocked(testReplier.pong).mock.calls[0]![0];
      // Default mime parser mock: from.address = "sender@example.com", subject = "Test email"
      expect(opts.to).toBe("sender@example.com");
      expect(opts.subject).toBe("Test email");
      expect(opts.body).toBe("Hello world");
    });

    it("uses recipientAddress as 'from' when domain has senderSetupComplete=true", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(testClassification);
      vi.mocked(store.getDomainByName).mockResolvedValueOnce({ senderSetupComplete: true });

      await processor.process(makeSqsEvent([{}]));

      const opts = vi.mocked(testReplier.pong).mock.calls[0]![0];
      // recipientAddress = destination[0] = "user@example.com" from the SQS event default
      expect(opts.from).toBe("user@example.com");
    });

    it("falls back to NOTIFICATION_FROM when senderSetupComplete=false", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(testClassification);
      vi.mocked(store.getDomainByName).mockResolvedValueOnce({ senderSetupComplete: false });
      process.env["NOTIFICATION_FROM"] = "noreply@system.example.com";

      await processor.process(makeSqsEvent([{}]));

      const opts = vi.mocked(testReplier.pong).mock.calls[0]![0];
      expect(opts.from).toBe("noreply@system.example.com");

      delete process.env["NOTIFICATION_FROM"];
    });

    it("falls back to NOTIFICATION_FROM when domain record is not found", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(testClassification);
      // getDomainByName already returns null by default from makeStore()
      process.env["NOTIFICATION_FROM"] = "noreply@system.example.com";

      await processor.process(makeSqsEvent([{}]));

      const opts = vi.mocked(testReplier.pong).mock.calls[0]![0];
      expect(opts.from).toBe("noreply@system.example.com");

      delete process.env["NOTIFICATION_FROM"];
    });

    it("passes sesMessageId as inReplyTo for email threading", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(testClassification);

      await processor.process(makeSqsEvent([{ sesMessageId: "original-ses-123" }]));

      const opts = vi.mocked(testReplier.pong).mock.calls[0]![0];
      expect(opts.inReplyTo).toBe("original-ses-123");
    });

    it("adds the pong messageId to arc.sentMessageIds before saving", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(testClassification);
      vi.mocked(testReplier.pong).mockResolvedValueOnce({ messageId: "pong-out-001" });

      await processor.process(makeSqsEvent([{}]));

      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.sentMessageIds).toContain("pong-out-001");
    });

    it("does not set sentMessageIds when pong throws", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(testClassification);
      vi.mocked(testReplier.pong).mockRejectedValueOnce(new Error("SES timeout"));

      await processor.process(makeSqsEvent([{}]));

      // Processing still completes and arc is saved without sentMessageIds
      expect(store.saveArc).toHaveBeenCalledOnce();
      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.sentMessageIds).toBeUndefined();
    });

    it("does not call pong for non-test workflows", async () => {
      // classifier returns personal by default (no mockResolvedValueOnce override)
      await processor.process(makeSqsEvent([{}]));

      expect(testReplier.pong).not.toHaveBeenCalled();
    });

    it("does not call pong when testReplier is not configured", async () => {
      const processorWithoutReplier = new SignalProcessor({ store, mimeParser, classifier, arcMatcher, ruleEvaluator });
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(testClassification);

      // Should not throw — testReplier is optional
      await expect(processorWithoutReplier.process(makeSqsEvent([{}]))).resolves.toBeUndefined();
    });

    it("looks up domain by the domain part of the recipient address", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(testClassification);

      await processor.process(makeSqsEvent([{ destination: ["me@custom-domain.com"] }]));

      expect(store.getDomainByName).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "custom-domain.com");
    });
  });

  // -------------------------------------------------------------------------
  // Scheduling signal synthesis
  // -------------------------------------------------------------------------

  const schedulingClassification: ClassificationOutput = {
    workflow: "scheduling",
    workflowData: {
      workflow: "scheduling",
      eventType: "meeting_invite",
      title: "Team Standup",
      startTime: "2024-02-01T09:00:00Z",
      endTime: "2024-02-01T09:30:00Z",
      location: "Zoom",
      organizer: "boss@company.com",
      attendees: [],
      requiresResponse: true,
    },
    spamScore: 0.0,
    summary: "Meeting invite for Team Standup on Feb 1.",
    labels: [],
    classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
  };

  describe("scheduling signal synthesis", () => {
    it("saves a synthetic calendar signal in addition to the email signal", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(schedulingClassification);

      await processor.process(makeSqsEvent([{}]));

      expect(store.saveSignal).toHaveBeenCalledTimes(2);
      const emailSig = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      const calSig = vi.mocked(store.saveSignal).mock.calls[1]![0] as Signal;
      expect(emailSig.id).toMatch(/^SES#/);
      expect(calSig.id).toMatch(/^SYS#/);
    });

    it("calendar signal has source=system, the title as subject, empty attachments, and empty s3Key", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(schedulingClassification);

      await processor.process(makeSqsEvent([{}]));

      const calSig = vi.mocked(store.saveSignal).mock.calls[1]![0] as Signal;
      expect(calSig.source).toBe("system");
      expect(calSig.subject).toBe("Team Standup");
      expect(calSig.attachments).toEqual([]);
      expect(calSig.s3Key).toBe("");
      expect(calSig.spamScore).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Spam threshold — per-address and account-level overrides
  // -------------------------------------------------------------------------

  describe("spam threshold override", () => {
    it("quarantines signal when per-address spamScoreThreshold is lower than default and score exceeds it", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
        ...DEFAULT_CTX,
        emailConfig: makeAlias({
          filterMode: "quarantine_visible",
          spamScoreThreshold: 0.5,
        }),
      });
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        spamScore: 0.7, // above per-address threshold (0.5), below default (0.9)
      });

      await processor.process(makeSqsEvent([{}]));

      // DEFAULT_SENDER_ENTRY is approved → SR-02 does not fire; SR-03 fires → quarantine_visible
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantine_visible");
    });

    it("uses account-level spamScoreThreshold when no per-address override is set", async () => {
      vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
        ...DEFAULT_CTX,
        emailConfig: makeAlias({ filterMode: "quarantine_visible" }),
        filtering: { defaultFilterMode: "quarantine_visible", newAddressHandling: "auto_allow", spamScoreThreshold: 0.6 },
      });
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...validClassification,
        spamScore: 0.7, // above account threshold (0.6), below default (0.9)
      });

      await processor.process(makeSqsEvent([{}]));

      // DEFAULT_SENDER_ENTRY is approved → SR-02 does not fire; SR-03 fires → quarantine_visible
      const saved = vi.mocked(store.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantine_visible");
    });
  });

  // -------------------------------------------------------------------------
  // Forward options reflect SES DKIM and DMARC verdicts
  // -------------------------------------------------------------------------

  describe("forward options from SES verdicts", () => {
    function makeForwardRule(): Rule {
      return {
        id: "fwd-rule",
        accountId: TEST_ACCOUNT_ID,
        name: "Forward all",
        condition: "true",
        actions: [{ type: "forward", value: "backup@personal.com" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
    }

    it("passes dkimPass=true and dmarcPass=true when both SES verdicts are PASS", async () => {
      const forwarder: Forwarder = { forward: vi.fn().mockResolvedValue(undefined) };
      const proc = new SignalProcessor({ store, mimeParser, classifier, arcMatcher, ruleEvaluator, forwarder });
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([makeForwardRule()]);

      await proc.process(makeSqsEvent([{ dkimVerdict: "PASS", dmarcVerdict: "PASS" }]));

      expect(forwarder.forward).toHaveBeenCalledWith(
        expect.any(String),
        "backup@personal.com",
        TEST_ACCOUNT_ID,
        expect.objectContaining({ dkimPass: true, dmarcPass: true }),
      );
    });

    it("passes dkimPass=false and dmarcPass=false when SES verdicts are FAIL and GRAY", async () => {
      const forwarder: Forwarder = { forward: vi.fn().mockResolvedValue(undefined) };
      const proc = new SignalProcessor({ store, mimeParser, classifier, arcMatcher, ruleEvaluator, forwarder });
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([makeForwardRule()]);

      await proc.process(makeSqsEvent([{ dkimVerdict: "FAIL", dmarcVerdict: "GRAY" }]));

      expect(forwarder.forward).toHaveBeenCalledWith(
        expect.any(String),
        "backup@personal.com",
        TEST_ACCOUNT_ID,
        expect.objectContaining({ dkimPass: false, dmarcPass: false }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Rule actions: assign_workflow and delete
  // -------------------------------------------------------------------------

  describe("rule actions — assign_workflow and delete", () => {
    it("assign_workflow action changes the arc workflow to the specified value", async () => {
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([{
        id: "rw-rule",
        accountId: TEST_ACCOUNT_ID,
        name: "Reclassify as content",
        condition: "true",
        actions: [{ type: "assign_workflow", value: "content" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      }]);

      await processor.process(makeSqsEvent([{}]));

      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.workflow).toBe("content");
    });

    it("delete action sets arc.status=deleted and records arc.deletedAt", async () => {
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([{
        id: "del-rule",
        accountId: TEST_ACCOUNT_ID,
        name: "Auto-delete promotions",
        condition: "true",
        actions: [{ type: "delete" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      }]);

      await processor.process(makeSqsEvent([{}]));

      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.status).toBe("deleted");
      expect(arc.deletedAt).toBeDefined();
    });

    it("multiple actions in one rule are all applied in order", async () => {
      vi.mocked(store.listEnabledRules).mockResolvedValueOnce([{
        id: "multi-rule",
        accountId: TEST_ACCOUNT_ID,
        name: "Label and archive",
        condition: "true",
        actions: [
          { type: "assign_label", value: "archived-auto" },
          { type: "archive" },
        ],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      }]);

      await processor.process(makeSqsEvent([{}]));

      const arc = vi.mocked(store.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.labels).toContain("archived-auto");
      expect(arc.status).toBe("archived");
    });
  });
});
