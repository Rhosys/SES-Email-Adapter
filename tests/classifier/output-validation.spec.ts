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
});
