import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildUserMessage } from "../../src/classifier/prompt-builder.js";
import type { ClassificationInput } from "../../src/classifier/classifier.js";
import { CLASSIFIER_WORKFLOW_REGISTRY, EnumValue } from "../../src/types/workflow-registry.js";

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt(CLASSIFIER_WORKFLOW_REGISTRY);

  it("includes every workflow name from registry", () => {
    for (const workflow of CLASSIFIER_WORKFLOW_REGISTRY) {
      expect(prompt).toContain(`### ${workflow.name}`);
    }
  });

  it("includes all fields for each workflow", () => {
    for (const workflow of CLASSIFIER_WORKFLOW_REGISTRY) {
      for (const field of workflow.fields) {
        expect(prompt).toContain(`| ${field.name} |`);
      }
    }
  });

  it("includes enum values with descriptions for enum fields", () => {
    for (const workflow of CLASSIFIER_WORKFLOW_REGISTRY) {
      for (const field of workflow.fields) {
        if (field.enumValues) {
          for (const ev of field.enumValues) {
            expect(prompt).toContain(ev.toPromptFragment());
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// buildUserMessage
// ---------------------------------------------------------------------------

describe("buildUserMessage", () => {
  const baseInput: ClassificationInput = {
    from: "sender@example.com",
    to: ["recipient@example.com"],
    subject: "Test Subject",
    body: "Hello, this is the email body.",
    receivedAt: "2025-01-15T10:00:00Z",
    headers: {},
    allowedLabels: ["billing", "urgent"],
  };

  it("wraps content in <email_content> delimiters", () => {
    const message = buildUserMessage(baseInput);
    expect(message).toContain("<email_content>");
    expect(message).toContain("</email_content>");
  });

  it("truncates body at 4000 characters", () => {
    const longBody = "x".repeat(5000);
    const message = buildUserMessage({ ...baseInput, body: longBody });

    expect(message).toContain("[... truncated]");
    expect(message).not.toContain("x".repeat(4001));
  });

  it("does not truncate body at or under 4000 characters", () => {
    const exactBody = "y".repeat(4000);
    const message = buildUserMessage({ ...baseInput, body: exactBody });

    expect(message).not.toContain("[... truncated]");
    expect(message).toContain(exactBody);
  });

  it("includes allowed labels array", () => {
    const message = buildUserMessage(baseInput);
    expect(message).toContain('Available labels: ["billing","urgent"]');
  });

  it("includes all provided headers (caller is responsible for pre-filtering)", () => {
    const input: ClassificationInput = {
      ...baseInput,
      headers: {
        "authentication-results": "spf=pass dkim=pass",
        "received-spf": "pass",
      },
    };

    const message = buildUserMessage(input);
    expect(message).toContain("authentication-results: spf=pass dkim=pass");
    expect(message).toContain("received-spf: pass");
  });

  it("excludes headers section when headers record is empty", () => {
    const input: ClassificationInput = {
      ...baseInput,
      headers: {},
    };

    const message = buildUserMessage(input);
    expect(message).not.toContain("Headers:");
  });
});
