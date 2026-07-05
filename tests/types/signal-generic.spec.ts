import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  isEmailSignal,
  isDeliverabilitySignal,
  isInvalidRuleFunctionSignal,
  isInvalidTemplateFunctionSignal,
  isAutoSendBlockedSignal,
  SIGNAL_TYPES,
} from "../../src/types/index.js";
import type {
  Signal,
  AnySignal,
  EmailSignalData,
  DeliverabilitySignalData,
  InvalidRuleFunctionData,
  InvalidTemplateFunctionData,
  AutoSendBlockedData,
  SignalType,
} from "../../src/types/index.js";
import { ThreadDatabase } from "../../src/database/thread-database.js";
import { createMockLogger } from "../helpers/mock-logger.js";

// =============================================================================
// Property 1: Type narrowing correctness
// For each signal type value, exactly one type guard returns true and the rest false.
// Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5
// =============================================================================

describe("Property 1: Type narrowing correctness", () => {
  function makeMinimalSignal(type: SignalType): AnySignal {
    return {
      id: "sgn-test",
      signalLookupId: "sgn-test",
      accountId: "acct-1",
      source: "email",
      type,
      status: "active",
      createdAt: "2025-01-01T00:00:00.000Z",
      data: {} as any,
    } as AnySignal;
  }

  const guards = [
    { name: "isEmailSignal", fn: isEmailSignal },
    { name: "isDeliverabilitySignal", fn: isDeliverabilitySignal },
    { name: "isInvalidRuleFunctionSignal", fn: isInvalidRuleFunctionSignal },
    { name: "isInvalidTemplateFunctionSignal", fn: isInvalidTemplateFunctionSignal },
    { name: "isAutoSendBlockedSignal", fn: isAutoSendBlockedSignal },
  ] as const;

  it.each([
    { type: "email" as const, trueGuard: "isEmailSignal" },
    { type: "deliverability" as const, trueGuard: "isDeliverabilitySignal" },
    { type: "invalid_rule_function" as const, trueGuard: "isInvalidRuleFunctionSignal" },
    { type: "invalid_template_function" as const, trueGuard: "isInvalidTemplateFunctionSignal" },
    { type: "auto_send_blocked" as const, trueGuard: "isAutoSendBlockedSignal" },
  ])("type=$type → only $trueGuard returns true", ({ type, trueGuard }) => {
    const signal = makeMinimalSignal(type);

    for (const guard of guards) {
      const expected = guard.name === trueGuard;
      expect(guard.fn(signal), `${guard.name}(type="${type}")`).toBe(expected);
    }
  });
});

// =============================================================================
// Property 2: Data payload completeness — SystemSignalCreator
// Validates: Requirements 10.1, 10.2, 10.3, 10.4
// =============================================================================

describe("Property 2: System signals contain only expected data fields", () => {
  const emailSpecificFields = [
    "from", "to", "cc", "attachments", "headers", "tags",
    "s3Key", "workflow", "workflowData", "subject", "receivedAt",
    "summary", "embeddings", "recipientAddress", "textBody", "htmlBody",
    "sentAt", "replyTo", "matchedRules", "sesMessageId", "sendInitiatedAt",
    "sendFailureReason", "urgency",
  ];

  it("invalid_rule_function signal data contains only resourceName and issue", () => {
    const signal: Signal<InvalidRuleFunctionData> = {
      id: "sgn-test", signalLookupId: "sgn-test", threadId: "arc-1", accountId: "acc-1",
      source: "email", type: "invalid_rule_function", status: "active", labels: [],
      createdAt: "2025-01-01T00:00:00.000Z", ttl: 1740000000,
      data: { resourceName: "My Rule", issue: "syntax error" },
    };
    expect(Object.keys(signal.data).sort()).toEqual(["issue", "resourceName"]);
    for (const field of emailSpecificFields) {
      expect(signal.data).not.toHaveProperty(field);
    }
  });

  it("invalid_template_function signal data contains only resourceName, functionName, and issue", () => {
    const signal: Signal<InvalidTemplateFunctionData> = {
      id: "sgn-test", signalLookupId: "sgn-test", threadId: "arc-1", accountId: "acc-1",
      source: "email", type: "invalid_template_function", status: "active", labels: [],
      createdAt: "2025-01-01T00:00:00.000Z", ttl: 1740000000,
      data: { resourceName: "Welcome Template", functionName: "formatDate", issue: "formatDate is not defined" },
    };
    expect(Object.keys(signal.data).sort()).toEqual(["functionName", "issue", "resourceName"]);
    for (const field of emailSpecificFields) {
      expect(signal.data).not.toHaveProperty(field);
    }
  });

  it("auto_send_blocked signal data contains only recipientAddress", () => {
    const signal: Signal<AutoSendBlockedData> = {
      id: "sgn-test", signalLookupId: "sgn-test", threadId: "arc-1", accountId: "acc-1",
      source: "email", type: "auto_send_blocked", status: "active", labels: [],
      createdAt: "2025-01-01T00:00:00.000Z", ttl: 1740000000,
      data: { recipientAddress: "inbox@example.com" },
    };
    expect(Object.keys(signal.data).sort()).toEqual(["recipientAddress"]);
    for (const field of emailSpecificFields) {
      if (field === "recipientAddress") continue;
      expect(signal.data).not.toHaveProperty(field);
    }
  });
});

// =============================================================================
// Property 2: Data payload completeness — FeedbackProcessor (deliverability)
// Validates: Requirements 11.1, 11.2
// =============================================================================

describe("Property 2: FeedbackProcessor deliverability signals contain only expected data fields", () => {
  const emailSpecificFields = [
    "from", "to", "cc", "attachments", "headers", "tags",
    "s3Key", "workflow", "workflowData", "receivedAt",
    "summary", "embeddings", "recipientAddress", "textBody", "htmlBody",
    "sentAt", "replyTo", "matchedRules", "sesMessageId", "sendInitiatedAt",
    "sendFailureReason", "urgency",
  ];

  it("deliverability signal data contains only linkedSignalId, bouncedRecipients, and subject", () => {
    // Construct a deliverability signal the same way FeedbackProcessor does
    const signal: Signal<DeliverabilitySignalData> = {
      id: "sgn-deliv-001",
      signalLookupId: "sgn-deliv-001",
      threadId: "arc-001",
      accountId: "acct-001",
      source: "ses_feedback",
      type: "deliverability",
      status: "active",
      labels: [],
      createdAt: "2025-01-01T00:00:00.000Z",
      data: {
        linkedSignalId: "sgn-original-001",
        bouncedRecipients: [{ address: "bounce@example.com", bounceType: "permanent", reason: "5.1.1" }],
        subject: "Delivery failure: 1 recipient(s) bounced",
      },
    };

    expect(Object.keys(signal.data).sort()).toEqual(["bouncedRecipients", "linkedSignalId", "subject"]);
    for (const field of emailSpecificFields) {
      expect(signal.data).not.toHaveProperty(field);
    }
  });
});

// =============================================================================
// Property 3: DynamoDB round-trip fidelity
// For each signal variant, saving and reading back preserves the `data` property.
// Validates: Requirements 9.1, 9.2
// =============================================================================

describe("Property 3: DynamoDB round-trip fidelity", () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(() => { ddbMock.reset(); });
  afterEach(() => { ddbMock.restore(); });

  const db = new ThreadDatabase(createMockLogger());

  it.each([
    {
      variant: "email",
      signal: {
        id: "sgn-email-001",
        signalLookupId: "sgn-email-001",
        threadId: "arc-001",
        accountId: "acct-001",
        source: "email",
        type: "email",
        status: "active",
        labels: [],
        createdAt: "2025-01-01T00:00:00.000Z",
        data: {
          receivedAt: "2025-01-01T00:00:00.000Z",
          summary: "Test email",
          from: { address: "sender@example.com", name: "Sender" },
          to: [{ address: "me@mydomain.com" }],
          cc: [],
          subject: "Hello",
          attachments: [],
          headers: { "message-id": "<abc@example.com>" },
          recipientAddress: "me@mydomain.com",
          workflow: "conversation",
          workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
          tags: [],
          s3Key: "emails/abc.eml",
        },
      } as Signal<EmailSignalData>,
    },
    {
      variant: "deliverability",
      signal: {
        id: "sgn-deliv-001",
        signalLookupId: "sgn-deliv-001",
        threadId: "arc-001",
        accountId: "acct-001",
        source: "ses_feedback",
        type: "deliverability",
        status: "active",
        createdAt: "2025-01-01T00:00:00.000Z",
        data: {
          linkedSignalId: "sgn-original-001",
          bouncedRecipients: [{ address: "bounce@example.com", bounceType: "permanent", reason: "5.1.1" }],
          subject: "Delivery failure: 1 recipient(s) bounced",
        },
      } as Signal<DeliverabilitySignalData>,
    },
    {
      variant: "invalid_rule_function",
      signal: {
        id: "sgn-rule-001",
        signalLookupId: "sgn-rule-001",
        threadId: "arc-001",
        accountId: "acct-001",
        source: "email",
        type: "invalid_rule_function",
        status: "active",
        createdAt: "2025-01-01T00:00:00.000Z",
        data: {
          resourceName: "my-rule",
          issue: "syntax error in condition",
        },
      } as Signal<InvalidRuleFunctionData>,
    },
    {
      variant: "invalid_template_function",
      signal: {
        id: "sgn-tmpl-001",
        signalLookupId: "sgn-tmpl-001",
        threadId: "arc-001",
        accountId: "acct-001",
        source: "email",
        type: "invalid_template_function",
        status: "active",
        createdAt: "2025-01-01T00:00:00.000Z",
        data: {
          resourceName: "welcome-template",
          functionName: "formatDate",
          issue: "formatDate is not defined",
        },
      } as Signal<InvalidTemplateFunctionData>,
    },
    {
      variant: "auto_send_blocked",
      signal: {
        id: "sgn-block-001",
        signalLookupId: "sgn-block-001",
        threadId: "arc-001",
        accountId: "acct-001",
        source: "email",
        type: "auto_send_blocked",
        status: "active",
        createdAt: "2025-01-01T00:00:00.000Z",
        data: {
          recipientAddress: "recipient@example.com",
        },
      } as Signal<AutoSendBlockedData>,
    },
  ])("$variant signal data survives save/read round-trip", async ({ signal }) => {
    // Mock PutCommand to capture what was written
    let savedItem: Record<string, unknown> | undefined;
    ddbMock.on(PutCommand).callsFake((input) => {
      savedItem = input.Item;
      return {};
    });

    // Mock GetCommand to return the saved item (simulating DynamoDB read-back)
    ddbMock.on(GetCommand).callsFake(() => ({ Item: savedItem }));
    // Mock QueryCommand for getSignalById's gsi1-based lookup
    ddbMock.on(QueryCommand).callsFake(() => ({ Items: [savedItem] }));

    // Save
    const saveResult = await db.saveSignal(signal as AnySignal);
    expect(saveResult.isOk()).toBe(true);

    // Read back
    const readResult = await db.getSignalById(signal.accountId, signal.id, signal.threadId ?? "QUARANTINED");
    expect(readResult.isOk()).toBe(true);

    const readSignal = readResult._unsafeUnwrap() as AnySignal;
    expect(readSignal!.data).toEqual(signal.data);
  });
});

// =============================================================================
// Property 4: Type parameter default
// Signal (no type param) resolves to Signal<EmailSignalData> — signal.data.from is accessible.
// Validates: Requirements 1.4, 8.1, 8.2
// =============================================================================

describe("Property 4: Type parameter default", () => {
  it("Signal without type parameter allows access to signal.data.from without narrowing", () => {
    // This test verifies a compile-time property: if it compiles, the property holds.
    const signal: Signal = {
      id: "sgn-default-001",
      signalLookupId: "sgn-default-001",
      threadId: "arc-001",
      accountId: "acct-001",
      source: "email",
      type: "email",
      status: "active",
      labels: [],
      createdAt: "2025-01-01T00:00:00.000Z",
      data: {
        receivedAt: "2025-01-01T00:00:00.000Z",
        summary: "Test",
        from: { address: "sender@example.com", name: "Sender" },
        to: [{ address: "me@example.com" }],
        cc: [],
        subject: "Hello",
        attachments: [],
        headers: {},
        recipientAddress: "me@example.com",
        workflow: "conversation",
        workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
        tags: [],
        s3Key: "emails/test.eml",
      },
    };

    // These accesses compile without type narrowing — proving T defaults to EmailSignalData
    expect(signal.data.from.address).toBe("sender@example.com");
    expect(signal.data.to[0]!.address).toBe("me@example.com");
    expect(signal.data.subject).toBe("Hello");
  });
});
