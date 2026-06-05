import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildUserMessage, type ClassificationInput } from "../../src/classifier/prompt-builder.js";
import { WORKFLOW_REGISTRY } from "../../src/classifier/workflow-registry.js";

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt(WORKFLOW_REGISTRY);

  it("includes every workflow name from registry", () => {
    for (const workflow of WORKFLOW_REGISTRY) {
      expect(prompt).toContain(`### ${workflow.name}`);
    }
  });

  it("includes all fields for each workflow", () => {
    for (const workflow of WORKFLOW_REGISTRY) {
      for (const field of workflow.fields) {
        expect(prompt).toContain(`| ${field.name} |`);
      }
    }
  });

  it("includes enum values for enum fields", () => {
    for (const workflow of WORKFLOW_REGISTRY) {
      for (const field of workflow.fields) {
        if (field.enumValues) {
          for (const value of field.enumValues) {
            expect(prompt).toContain(`"${value}"`);
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

  it("filters headers to relevant set only", () => {
    const input: ClassificationInput = {
      ...baseInput,
      headers: {
        "authentication-results": "spf=pass dkim=pass",
        "x-custom-header": "should be excluded",
        "list-unsubscribe": "<mailto:unsub@example.com>",
        "x-spam-status": "No",
      },
    };

    const message = buildUserMessage(input);
    expect(message).toContain("authentication-results: spf=pass dkim=pass");
    expect(message).toContain("list-unsubscribe: <mailto:unsub@example.com>");
    expect(message).toContain("x-spam-status: No");
    expect(message).not.toContain("x-custom-header");
    expect(message).not.toContain("should be excluded");
  });

  it("excludes headers section when no relevant headers present", () => {
    const input: ClassificationInput = {
      ...baseInput,
      headers: {
        "x-custom-header": "irrelevant",
        "content-type": "text/html",
      },
    };

    const message = buildUserMessage(input);
    expect(message).not.toContain("Headers:");
  });
});
