import { describe, it, expect, vi, beforeEach } from "vitest";
import { SignalClassifier } from "../../src/classifier/classifier.js";
import type { ClassificationInput } from "../../src/classifier/classifier.js";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type { Logger } from "../../src/logger.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseInput: ClassificationInput = {
  from: "noreply@service.com",
  to: ["user@example.com"],
  subject: "Test email",
  body: "Some body content for classification.",
  receivedAt: "2024-01-15T10:00:00Z",
  headers: { "authentication-results": "spf=pass dkim=pass" },
  allowedLabels: ["billing", "urgent"],
  labelInstructions: {},
};

// ---------------------------------------------------------------------------
// Bedrock mock
// ---------------------------------------------------------------------------

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  InvokeModelCommand: vi.fn().mockImplementation((params: unknown) => params),
}));

function mockBedrockResponse(text: string) {
  const body = new TextEncoder().encode(
    JSON.stringify({ choices: [{ message: { content: text } }] }),
  );
  mockSend.mockResolvedValueOnce({ body });
}

function mockClassifyResponse(raw: object) {
  mockBedrockResponse(JSON.stringify(raw));
}

function mockTruncatedResponse(partialContent: string) {
  const body = new TextEncoder().encode(
    JSON.stringify({ choices: [{ message: { content: partialContent }, finish_reason: "length" }] }),
  );
  mockSend.mockResolvedValueOnce({ body });
}

const mockLogger: Logger = {
  startInvocation: vi.fn(),
  getInvocationId: vi.fn(() => "test-invocation"),
  trackPoint: vi.fn(),
  info: vi.fn(),
  track: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  critical: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests — Output Validation (Requirements 2.3, 5.1, 7.3)
// ---------------------------------------------------------------------------

describe("SignalClassifier — output validation", () => {
  let classifier: SignalClassifier;

  beforeEach(() => {
    vi.clearAllMocks();
    classifier = new SignalClassifier(new BedrockRuntimeClient({}), mockLogger);
  });

  // -------------------------------------------------------------------------
  // Invalid JSON → err()
  // -------------------------------------------------------------------------

  it("returns err() when LLM returns invalid JSON", async () => {
    mockBedrockResponse("not json at all");

    const result = await classifier.classify(baseInput);

    expect(result.isErr()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Truncated by max_tokens → ok(unspecified fallback), not a parse attempt
  // -------------------------------------------------------------------------

  it("falls back to workflow:unspecified without attempting to parse when finish_reason is length", async () => {
    mockTruncatedResponse('{"workflow": "content", "summary": "Some long summary that got cut off mid-str');

    const result = await classifier.classify(baseInput);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ workflow: "unspecified", workflowData: { workflow: "unspecified" }, tags: [], summary: "", labels: [], actions: [] });
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("truncated"),
      expect.objectContaining({ code: "classifier.output_truncated" }),
    );
  });

  // -------------------------------------------------------------------------
  // Unknown workflow → err()
  // -------------------------------------------------------------------------

  it("returns err() when LLM returns an unknown workflow", async () => {
    mockClassifyResponse({
      workflow: "unknown_workflow",
      workflowData: { workflow: "unknown_workflow" },
      tags: [],
      summary: "Some email.",
      labels: [],
    });

    const result = await classifier.classify(baseInput);

    expect(result.isErr()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Singular/plural workflow mismatch → normalized, not err()
  // -------------------------------------------------------------------------

  it("normalizes a singular workflow name to its plural registry form", async () => {
    mockClassifyResponse({
      workflow: "event",
      workflowData: { workflow: "events", eventType: "ticket_confirmation", eventName: "Concert" },
      tags: [],
      summary: "A concert ticket.",
      labels: [],
    });

    const result = await classifier.classify(baseInput);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().workflow).toBe("events");
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("normalizing"),
      expect.objectContaining({ code: "classifier.workflow_pluralization_mismatch" }),
    );
  });

  // -------------------------------------------------------------------------
  // Tag validation — unknown tags filtered out
  // -------------------------------------------------------------------------

  it("filters out unknown tags not in the allowed vocabulary", async () => {
    mockClassifyResponse({
      workflow: "content",
      workflowData: { workflow: "content", contentType: "newsletter", publisher: "Test" },
      tags: ["phishing", "totally-made-up-tag", "not-a-real-tag"],
      summary: "A newsletter.",
      labels: [],
    });

    const result = await classifier.classify(baseInput);

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.tags).toContain("phishing");
    expect(output.tags).not.toContain("totally-made-up-tag");
    expect(output.tags).not.toContain("not-a-real-tag");
  });

  // -------------------------------------------------------------------------
  // Tag validation — valid tags pass through
  // -------------------------------------------------------------------------

  it("passes through valid tags from the allowed vocabulary", async () => {
    mockClassifyResponse({
      workflow: "content",
      workflowData: { workflow: "content", contentType: "newsletter", publisher: "Test" },
      tags: ["phishing"],
      summary: "A suspicious newsletter.",
      labels: [],
    });

    const result = await classifier.classify(baseInput);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().tags).toEqual(["phishing"]);
  });

  // -------------------------------------------------------------------------
  // Labels filtered to allowedLabels subset
  // -------------------------------------------------------------------------

  it("filters labels to the allowed subset", async () => {
    mockClassifyResponse({
      workflow: "payments",
      workflowData: { workflow: "payments", paymentType: "invoice", vendor: "Acme" },
      tags: [],
      summary: "Invoice from Acme.",
      labels: ["billing", "invented"],
    });

    const result = await classifier.classify(baseInput);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().labels).toEqual(["billing"]);
  });

  // -------------------------------------------------------------------------
  // Actions — valid entries with url and text
  // -------------------------------------------------------------------------

  it("parses actions with valid url and text", async () => {
    mockClassifyResponse({
      workflow: "conversation",
      workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
      tags: [],
      summary: "Email with links.",
      labels: [],
      actions: [
        { url: "https://example.com/unsubscribe", text: "Unsubscribe" },
        { url: "https://dashboard.stripe.com/invoices/123", text: "View Invoice" },
      ],
    });

    const result = await classifier.classify(baseInput);

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.actions).toHaveLength(2);
    expect(output.actions[0]).toEqual({ url: "https://example.com/unsubscribe", text: "Unsubscribe" });
    expect(output.actions[1]).toEqual({ url: "https://dashboard.stripe.com/invoices/123", text: "View Invoice" });
  });

  // -------------------------------------------------------------------------
  // Actions — invalid URLs filtered out
  // -------------------------------------------------------------------------

  it("filters out actions with invalid URLs", async () => {
    mockClassifyResponse({
      workflow: "conversation",
      workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
      tags: [],
      summary: "Email.",
      labels: [],
      actions: [
        { url: "https://valid.com/path", text: "Valid" },
        { url: "not-a-url", text: "Invalid" },
        { url: "ftp://wrong-protocol.com", text: "Wrong protocol" },
        { url: "", text: "Empty" },
      ],
    });

    const result = await classifier.classify(baseInput);

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.actions).toHaveLength(1);
    expect(output.actions[0]).toEqual({ url: "https://valid.com/path", text: "Valid" });
  });

  // -------------------------------------------------------------------------
  // Actions — text equal to url normalized to null
  // -------------------------------------------------------------------------

  it("normalizes text to null when it equals the url", async () => {
    mockClassifyResponse({
      workflow: "conversation",
      workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
      tags: [],
      summary: "Email.",
      labels: [],
      actions: [
        { url: "https://example.com/action", text: "https://example.com/action" },
      ],
    });

    const result = await classifier.classify(baseInput);

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.actions).toHaveLength(1);
    expect(output.actions[0]).toEqual({ url: "https://example.com/action", text: null });
  });

  // -------------------------------------------------------------------------
  // Actions — defaults to empty array when missing from LLM response
  // -------------------------------------------------------------------------

  it("returns empty actions array when LLM omits actions field", async () => {
    mockClassifyResponse({
      workflow: "conversation",
      workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
      tags: [],
      summary: "Email.",
      labels: [],
      // no actions field
    });

    const result = await classifier.classify(baseInput);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().actions).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Actions — entries without url skipped
  // -------------------------------------------------------------------------

  it("skips action entries that lack a url field", async () => {
    mockClassifyResponse({
      workflow: "conversation",
      workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
      tags: [],
      summary: "Email.",
      labels: [],
      actions: [
        { text: "No URL here" },
        { url: "https://valid.com", text: "Has URL" },
        null,
        42,
      ],
    });

    const result = await classifier.classify(baseInput);

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.actions).toHaveLength(1);
    expect(output.actions[0]).toEqual({ url: "https://valid.com", text: "Has URL" });
  });
});
