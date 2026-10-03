/**
 * Classifier label accuracy integration tests.
 *
 * These tests invoke the REAL Bedrock model and assert that user-defined labels
 * are applied (or not applied) correctly — especially when label names are
 * ambiguous and could be over-applied by the LLM.
 *
 * Run: npm run test:integration
 *
 * Requires: AWS credentials with Bedrock InvokeModel permission in eu-central-1.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { SignalClassifier } from "../../src/classifier/classifier.js";
import type { ClassificationInput } from "../../src/classifier/classifier.js";
import { createConsoleLogger } from "../helpers/logger.js";

function makeInput(overrides: Partial<ClassificationInput>): ClassificationInput {
  return {
    from: "noreply@example.com",
    to: ["user@test.com"],
    subject: "",
    body: "",
    receivedAt: "2025-01-15T10:00:00Z",
    headers: {},
    allowedLabels: [],
    labelInstructions: {},
    signalId: "sgn-integration-test",
    accountId: "acc-integration-test",
    ...overrides,
  };
}

describe("Classifier label accuracy", () => {
  let classifier: SignalClassifier;

  beforeAll(() => {
    const client = new BedrockRuntimeClient({ region: "eu-central-1" });
    classifier = new SignalClassifier(client, createConsoleLogger());
  });

  it("does NOT apply 'Test' label to a genuine event ticket confirmation", async () => {
    const result = await classifier.classify(makeInput({
      from: "events@chnug.ch",
      to: ["chung@vortex.link"],
      subject: "Your Order is Confirmed!  🎉",
      body: "Congratulations! Your order for CHNUG #4 on August 26, 2026 at 5:00 PM was successful. Please find your order details below.\n\nEvent Details\nEvent Name: CHNUG #4\nDate & Time: August 26, 2026 at 5:00 PM\n\nOrder Summary\nOrder Number: O-UGWRW9Q\nTotal Amount: CHF 0.00\n\nView Order Summary & Tickets: https://events.chnug.ch/checkout/5/o_YV28UCAMSvfah/summary\n\nIf you have any questions or need assistance, please contact events@chnug.ch.\n\nBest regards,\nCHNUG",
      headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      allowedLabels: ["Test", "Events", "Work", "Personal"],
      labelInstructions: {},
    }));

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.workflow).toBe("events");
    expect(output.labels).not.toContain("Test");
  }, 30_000);

  it("does NOT apply 'Test' label to event confirmation when instruction is provided", async () => {
    const result = await classifier.classify(makeInput({
      from: "events@chnug.ch",
      to: ["chung@vortex.link"],
      subject: "Your Order is Confirmed!  🎉",
      body: "Congratulations! Your order for CHNUG #4 on August 26, 2026 at 5:00 PM was successful. Please find your order details below.\n\nEvent Details\nEvent Name: CHNUG #4\nDate & Time: August 26, 2026 at 5:00 PM\n\nOrder Summary\nOrder Number: O-UGWRW9Q\nTotal Amount: CHF 0.00",
      headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      allowedLabels: ["Test", "Events", "Work", "Personal"],
      labelInstructions: {
        "Test": "Apply ONLY to emails that are explicitly testing or debugging email delivery — e.g. subject contains 'test email' or the body is a trivial test message. Never apply to real transactional emails like tickets, orders, or confirmations.",
      },
    }));

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.workflow).toBe("events");
    expect(output.labels).not.toContain("Test");
  }, 30_000);

  it("applies instructed label correctly when condition IS met", async () => {
    const result = await classifier.classify(makeInput({
      from: "warren@mydomain.com",
      to: ["warren@mydomain.com"],
      subject: "Test email - checking delivery",
      body: "This is a test email to verify that the domain is configured correctly.",
      headers: { "authentication-results": "spf=pass dkim=pass" },
      allowedLabels: ["Test", "Events", "Work", "Personal"],
      labelInstructions: {
        "Test": "Apply ONLY to emails that are explicitly testing or debugging email delivery — e.g. subject contains 'test email' or the body is a trivial test message.",
      },
    }));

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.labels).toContain("Test");
  }, 30_000);
});
