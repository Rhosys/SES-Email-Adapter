import { describe, it, expect, vi, beforeEach } from "vitest";
import { SignalClassifier } from "../../src/classifier/classifier.js";
import type { ClassificationInput } from "../../src/classifier/classifier.js";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { createMockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const basicInput: ClassificationInput = {
  from: "sender@example.com",
  to: ["user@example.com"],
  subject: "Test email",
  body: "Hello, this is a test email.",
  receivedAt: "2024-01-15T10:00:00Z",
  headers: { "authentication-results": "spf=pass dkim=pass" },
  allowedLabels: [],
  labelInstructions: {},
  signalId: "sig_abc123",
  accountId: "acc_xyz789",
};

const classificationPayload = {
  workflow: "conversation",
  workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
  tags: [],
  summary: "A test email.",
  labels: [],
};

// ---------------------------------------------------------------------------
// Bedrock mock
// ---------------------------------------------------------------------------

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  InvokeModelCommand: vi.fn().mockImplementation((params: unknown) => params),
}));

function mockBedrockResponse(classificationOutput: object, trace?: object) {
  const responseBody: Record<string, unknown> = {
    choices: [{ message: { content: JSON.stringify(classificationOutput) } }],
  };
  if (trace) {
    responseBody["amazon-bedrock-trace"] = trace;
  }
  const body = new TextEncoder().encode(JSON.stringify(responseBody));
  mockSend.mockResolvedValueOnce({ body });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SignalClassifier — guardrail trace handling", () => {
  let classifier: SignalClassifier;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
    classifier = new SignalClassifier(new BedrockRuntimeClient({}), logger);
  });

  it("logs TRACK with detection metadata when guardrail detects prompt attack", async () => {
    mockBedrockResponse(classificationPayload, {
      guardrail: {
        inputAssessment: {
          "0": {
            contentPolicy: {
              filters: [
                { type: "PROMPT_ATTACK", confidence: "HIGH", action: "NONE" },
              ],
            },
          },
        },
      },
    });

    const result = await classifier.classify(basicInput);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().workflow).toBe("conversation");

    const trackCalls = logger.calls.filter((c) => c.method === "track");
    expect(trackCalls).toHaveLength(1);
    expect(trackCalls[0]!.message).toBe("classifier.guardrail_detection");
    expect(trackCalls[0]!.context).toMatchObject({
      signalId: "sig_abc123",
      accountId: "acc_xyz789",
      detectionType: "PROMPT_ATTACK",
      category: "PROMPT_ATTACK",
      confidence: "HIGH",
    });
  });

  it("logs TRACK with CONTENT_FILTER type for non-prompt-attack detections", async () => {
    mockBedrockResponse(classificationPayload, {
      guardrail: {
        inputAssessment: {
          "0": {
            contentPolicy: {
              filters: [
                { type: "HATE", confidence: "MEDIUM", action: "NONE" },
              ],
            },
          },
        },
      },
    });

    const result = await classifier.classify(basicInput);

    expect(result.isOk()).toBe(true);

    const trackCalls = logger.calls.filter((c) => c.method === "track");
    expect(trackCalls).toHaveLength(1);
    expect(trackCalls[0]!.context).toMatchObject({
      detectionType: "CONTENT_FILTER",
      category: "HATE",
      confidence: "MEDIUM",
    });
  });

  it("does not log TRACK when no guardrail trace is present in the response", async () => {
    mockBedrockResponse(classificationPayload);

    const result = await classifier.classify(basicInput);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().workflow).toBe("conversation");

    const trackCalls = logger.calls.filter((c) => c.method === "track");
    expect(trackCalls).toHaveLength(0);
  });

  it("does not log TRACK when guardrail filters report confidence NONE", async () => {
    mockBedrockResponse(classificationPayload, {
      guardrail: {
        inputAssessment: {
          "0": {
            contentPolicy: {
              filters: [
                { type: "HATE", confidence: "NONE", action: "NONE" },
                { type: "VIOLENCE", confidence: "NONE", action: "NONE" },
              ],
            },
          },
        },
      },
    });

    const result = await classifier.classify(basicInput);

    expect(result.isOk()).toBe(true);

    const trackCalls = logger.calls.filter((c) => c.method === "track");
    expect(trackCalls).toHaveLength(0);
  });

  it("still returns classification output when guardrail detects content", async () => {
    mockBedrockResponse(classificationPayload, {
      guardrail: {
        inputAssessment: {
          "0": {
            contentPolicy: {
              filters: [
                { type: "SEXUAL", confidence: "LOW", action: "NONE" },
              ],
            },
          },
        },
      },
    });

    const result = await classifier.classify(basicInput);

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.workflow).toBe("conversation");
    expect(output.summary).toBe("A test email.");
    expect(output.tags).toEqual([]);
  });

  it("logs multiple TRACK entries when multiple filters detect content", async () => {
    mockBedrockResponse(classificationPayload, {
      guardrail: {
        inputAssessment: {
          "0": {
            contentPolicy: {
              filters: [
                { type: "PROMPT_ATTACK", confidence: "HIGH", action: "NONE" },
                { type: "INSULTS", confidence: "LOW", action: "NONE" },
              ],
            },
          },
        },
      },
    });

    const result = await classifier.classify(basicInput);

    expect(result.isOk()).toBe(true);

    const trackCalls = logger.calls.filter((c) => c.method === "track");
    expect(trackCalls).toHaveLength(2);
    expect(trackCalls[0]!.context).toMatchObject({ detectionType: "PROMPT_ATTACK", category: "PROMPT_ATTACK" });
    expect(trackCalls[1]!.context).toMatchObject({ detectionType: "CONTENT_FILTER", category: "INSULTS" });
  });
});
