import { describe, it, expect, vi, beforeEach } from "vitest";
import { SignalClassifier } from "../../src/classifier/classifier.js";
import type { ClassificationInput } from "../../src/classifier/classifier.js";
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
    JSON.stringify({ content: [{ type: "text", text }] }),
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
    classifier = new SignalClassifier(undefined, mockLogger);
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
      spamScore: 0.1,
      summary: "Some email.",
      labels: [],
    });

    const result = await classifier.classify(baseInput);

    expect(result.isErr()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // SpamScore 1.5 → clamped to 1.0
  // -------------------------------------------------------------------------

  it("clamps spamScore 1.5 to 1.0", async () => {
    mockClassifyResponse({
      workflow: "content",
      workflowData: { workflow: "content", contentType: "newsletter", publisher: "Test" },
      spamScore: 1.5,
      summary: "A newsletter.",
      labels: [],
    });

    const result = await classifier.classify(baseInput);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().spamScore).toBe(1.0);
  });

  // -------------------------------------------------------------------------
  // SpamScore -0.2 → clamped to 0.0
  // -------------------------------------------------------------------------

  it("clamps spamScore -0.2 to 0.0", async () => {
    mockClassifyResponse({
      workflow: "content",
      workflowData: { workflow: "content", contentType: "newsletter", publisher: "Test" },
      spamScore: -0.2,
      summary: "A newsletter.",
      labels: [],
    });

    const result = await classifier.classify(baseInput);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().spamScore).toBe(0.0);
  });

  // -------------------------------------------------------------------------
  // Labels filtered to allowedLabels subset
  // -------------------------------------------------------------------------

  it("filters labels to the allowed subset", async () => {
    mockClassifyResponse({
      workflow: "payments",
      workflowData: { workflow: "payments", paymentType: "invoice", vendor: "Acme" },
      spamScore: 0.0,
      summary: "Invoice from Acme.",
      labels: ["billing", "invented"],
    });

    const result = await classifier.classify(baseInput);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().labels).toEqual(["billing"]);
  });
});
