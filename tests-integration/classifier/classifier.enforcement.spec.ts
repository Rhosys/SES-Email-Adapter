/**
 * Classifier enforcement integration tests.
 *
 * These tests invoke the REAL Bedrock model and assert correct classification
 * of emails that require user action — ensuring they route to workflow:alert
 * instead of workflow:notice.
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
    signalId: "sgn-integration-test",
    accountId: "acc-integration-test",
    ...overrides,
  };
}

describe("Classifier enforcement — action-required emails → alert", () => {
  let classifier: SignalClassifier;

  beforeAll(() => {
    const client = new BedrockRuntimeClient({ region: "eu-central-1" });
    classifier = new SignalClassifier(client, createConsoleLogger());
  });

  it("copyright takedown with removal deadline → workflow:alert, requiresAction:true", async () => {
    const result = await classifier.classify(makeInput({
      from: "site@acmehosting.example",
      to: ["user@acmehosting.example"],
      subject: "Copyright complaint",
      body: "Hello user,\n\nWe received a copyright complaint for a file on your server.\n\nYou can view complaints at https://acmehosting.example/complaints\n\nTo prevent your account from being frozen, please remove the reported content within the next 24 hours.\n\nIf your account is already frozen:\n- Use the Delete button to have us remove the files for you.\n- Use the Unlock button and remove the files yourself.\n\nPlease refer to our Terms of Service for more information.\n\nBest regards,\nAcme Hosting Staff",
      headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
    }));

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.workflow).toBe("alert");
    const wd = output.workflowData as unknown as Record<string, unknown>;
    expect(wd.requiresAction).toBe(true);
  }, 30_000);

  it("account frozen requiring unlock → workflow:alert, requiresAction:true", async () => {
    const result = await classifier.classify(makeInput({
      from: "site@acmehosting.example",
      to: ["user@acmehosting.example"],
      subject: "Account frozen",
      body: "Hi user,\n\nYour server is now temporarily frozen because of an unresolved copyright complaint.\n\n- Use the Delete button to have us remove the files for you.\n- Use the Unlock button and remove the files yourself.\n\nIf the unlock button is disabled due to overuse, you can create a support ticket and let us know you are ready to remove the content.\n\nPlease refer to our Terms of Service for more information.\n\nKind regards,\nAcme Hosting Staff",
      headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
    }));

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.workflow).toBe("alert");
    const wd = output.workflowData as unknown as Record<string, unknown>;
    expect(wd.requiresAction).toBe(true);
  }, 30_000);
});
