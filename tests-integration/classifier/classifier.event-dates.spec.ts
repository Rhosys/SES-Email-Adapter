/**
 * Classifier event date-range integration tests.
 *
 * These tests invoke the REAL Bedrock model (qwen3-32b) and assert that a multi-day event stated
 * as a date range is split into separate start (eventDate) and end (eventEndDate) fields, rather
 * than crammed as a range string into one date field (which the coercion boundary nullifies — the
 * "Classifier returned unparseable date value" TRACK that motivated eventEndDate).
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
    receivedAt: "2026-09-01T10:00:00Z",
    headers: {},
    allowedLabels: [],
    labelInstructions: {},
    signalId: "sgn-integration-test",
    accountId: "acc-integration-test",
    ...overrides,
  };
}

// A date is "parseable" per the coercion boundary when it carries no " to "/"–" range connector.
// The whole point of the fix is that a range never survives as a single value.
function hasNoRangeConnector(value: unknown): boolean {
  return typeof value === "string" && !/\bto\b|–|—|-{1,2}\s|\s-{1,2}/.test(value.replace(/\d{4}-\d{2}-\d{2}/g, ""));
}

describe("Classifier event date ranges → split start/end", () => {
  let classifier: SignalClassifier;

  beforeAll(() => {
    const client = new BedrockRuntimeClient({ region: "eu-central-1" });
    classifier = new SignalClassifier(client, createConsoleLogger());
  });

  it("date-only multi-day conference splits into eventDate (start) and eventEndDate (end)", async () => {
    const result = await classifier.classify(makeInput({
      from: "info@devconf.example",
      subject: "DevConf 2026 — save the date",
      body: "You're invited to DevConf 2026, our annual developer conference in Zurich, running from 28 September to 3 October. No tickets required yet — just save the dates. Full agenda to follow.",
    }));

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.workflow).toBe("events");
    const wd = output.workflowData as unknown as Record<string, unknown>;

    // Start and end are both populated, neither nullified, and neither is a range string.
    expect(wd.eventDate).toBeTruthy();
    expect(wd.eventEndDate).toBeTruthy();
    expect(wd.eventDate).not.toBe(wd.eventEndDate);
    expect(hasNoRangeConnector(wd.eventDate)).toBe(true);
    expect(hasNoRangeConnector(wd.eventEndDate)).toBe(true);

    // The coercion boundary produced valid instants for both (no nullification).
    expect(wd.eventDateInstant).toBeTruthy();
    expect(wd.eventEndDateInstant).toBeTruthy();
    expect(new Date(wd.eventEndDateInstant as string).getTime()).toBeGreaterThan(new Date(wd.eventDateInstant as string).getTime());
  }, 30_000);

  it("single-day event populates only the start, leaving eventEndDate empty", async () => {
    const result = await classifier.classify(makeInput({
      from: "tickets@venue.example",
      subject: "Your ticket for the show",
      body: "Thanks for booking! The concert is on 3 February 2027 at 20:00. Doors open at 19:00. See you there.",
    }));

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.workflow).toBe("events");
    const wd = output.workflowData as unknown as Record<string, unknown>;

    expect(wd.eventEndDate == null || wd.eventEndDate === "").toBe(true);
  }, 30_000);
});
