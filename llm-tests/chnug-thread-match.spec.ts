// LLM Integration Test — CHNUG Thread Matching
//
// Tests two real-world signals from the same event (CHNUG #4) that should
// match on tier 2 (embedding similarity) but currently don't.
//
// 1. Classifies the UPDATE email and validates workflowData extraction
// 2. Generates embeddings for both signals and computes cosine distance
// 3. Asserts the distance is below SIMILARITY_THRESHOLD (0.5)
//
// RUN:
//   npx tsx ~/.kiro/skills/lib/aws-cli.ts "CHNUG thread match test" -- \
//     npx vitest run --config llm-tests/vitest.config.ts chnug-thread-match
//
// REQUIRES: AWS SSO authentication via ~/.kiro/skills/lib/aws-cli.ts
// The aws-cli wrapper authenticates to account 342695602194 (email-catcher)
// using the RhosysEngineerContext role and injects ephemeral credentials.
// The role needs bedrock:InvokeModel for both the classifier model (qwen)
// and the embedding model (amazon.titan-embed-text-v2:0).

import { describe, it, expect } from "vitest";
import { SignalClassifier } from "../src/classifier/classifier.js";
import type { ClassificationInput } from "../src/classifier/classifier.js";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { BedrockEmbeddingGenerator } from "../src/embedding/embedding-generator.js";
import { buildEmbedText } from "../src/embedding/embed-text.js";
import { getETLD1 } from "../src/processor/filter.js";
import { getPrimaryThreadMatcherRegistry } from "../src/embedding/cluster-registry.js";
import type { Logger } from "../src/logger.js";

const SIMILARITY_THRESHOLD = 0.5;

const logger: Logger = {
  startInvocation() {},
  getInvocationId() { return "llm-test"; },
  trackPoint() {},
  info() {},
  track() {},
  warn() {},
  error() {},
  critical() {},
} as never;

const bedrock = new BedrockRuntimeClient({ region: "eu-central-1" });
const classifier = new SignalClassifier(bedrock, logger as never);
const embeddingGenerator = new BedrockEmbeddingGenerator(bedrock, logger);

// ---------------------------------------------------------------------------
// Signal 1: Ticket confirmation (Aug 10)
// ---------------------------------------------------------------------------
const TICKET_CONFIRMATION_BODY = `Congratulations! Your order for CHNUG #4 on August 26, 2026 at 5:00 PM was successful. Please find your order details below.

Event Details
Event Name: CHNUG #4
Date & Time: August 26, 2026 at 5:00 PM

Order Summary
Order Number: O-UGWRW9Q
Total Amount: CHF 0.00

View Order Summary & Tickets: https://events.chnug.ch/checkout/5/o_YV28UCAMSvfah/summary

If you have any questions or need assistance, please contact events@chnug.ch.

Best regards,
CHNUG`;

// ---------------------------------------------------------------------------
// Signal 2: Speaker change update (Aug 14)
// ---------------------------------------------------------------------------
const UPDATE_BODY = `Hi everyone,

A short update on CHNUG #4. Unfortunately, Pim van Pelt had to postpone his presentation to a future meetup. I'm happy to announce that Marco Martinez steps in and will present "Managing IP Allocation with an Open-Source DDI" instead.
Date, time and location remain unchanged. Looking forward to seeing you on August 26.

Best,
Severin

You are receiving this communication because you are registered as an attendee for the following event: CHNUG #4. If you believe you have received this email in error, please contact the event organizer at events@chnug.ch.`;

function makeInput(overrides: Partial<ClassificationInput>): ClassificationInput {
  return {
    from: "events@chnug.ch",
    to: ["chung@vortex.link"],
    subject: "Test",
    body: "Test body",
    receivedAt: "2026-08-14T12:24:45.818Z",
    headers: {},
    allowedLabels: [],
    labelInstructions: {},
    ...overrides,
  };
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return 1 - similarity; // cosine distance (0 = identical, 2 = opposite)
}

describe("CHNUG #4 — Thread matching investigation", () => {
  describe("Classifier output for update email", () => {
    it("classifies CHNUG update as events workflow with correct eventStartDatetime", async () => {
      const input = makeInput({
        subject: "CHNUG #4 update: speaker change",
        body: UPDATE_BODY,
        receivedAt: "2026-08-14T12:24:45.818Z",
      });

      const result = await classifier.classify(input);
      if (result.isErr()) console.error("Classifier error:", result.error);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();

      expect(output.workflow).toBe("events");
      expect((output.workflowData as { eventName?: string }).eventName).toBe("CHNUG #4");
      expect((output.workflowData as { eventType?: string }).eventType).toBe("update");

      // The email says "August 26" — date only, no time, no timezone.
      // After coercion of "August 26" → "2026-08-26" (date-only, no time).
      const startDatetime = (output.workflowData as { eventStartDatetime?: string }).eventStartDatetime;
      console.log("LLM extracted eventStartDatetime:", startDatetime);
      expect(startDatetime).toMatch(/^\d{4}-\d{2}-\d{2}$/); // date-only, no T, no offset

      // Fields not present in the email should be null/undefined (not "not specified")
      // Note: LLM may still extract venueName from email context — assert only fields
      // that are definitively absent from the email body
      const wd = output.workflowData as Record<string, unknown>;
      expect(wd.seatDetails == null || wd.seatDetails === undefined).toBe(true);
      expect(wd.ticketUrl == null || wd.ticketUrl === undefined).toBe(true);
      expect(wd.totalAmount == null || wd.totalAmount === undefined).toBe(true);
      expect(wd.currency == null || wd.currency === undefined).toBe(true);
    });
  });

  describe("Classifier output for ticket confirmation email", () => {
    it("classifies CHNUG ticket confirmation as events workflow", async () => {
      const input = makeInput({
        subject: "Your Order is Confirmed!  🎉",
        body: TICKET_CONFIRMATION_BODY,
        receivedAt: "2026-08-10T10:16:25.789Z",
      });

      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();

      expect(output.workflow).toBe("events");
      expect((output.workflowData as { eventName?: string }).eventName).toBe("CHNUG #4");
      expect((output.workflowData as { eventType?: string }).eventType).toBe("ticket_confirmation");

      // The email says "August 26, 2026 at 5:00 PM" — has time but no timezone.
      // Correct: "2026-08-26T17:00" (no offset). NOT "2026-08-26T17:00+00:00".
      const startDatetime = (output.workflowData as { eventStartDatetime?: string }).eventStartDatetime;
      console.log("LLM extracted eventStartDatetime:", startDatetime);
    });
  });

  describe("Embedding similarity — tier 2 thread match", () => {
    it("embeddings for both CHNUG signals should be within SIMILARITY_THRESHOLD", async () => {
      // Classify both emails to get their embed text
      const ticketInput = makeInput({
        subject: "Your Order is Confirmed!  🎉",
        body: TICKET_CONFIRMATION_BODY,
        receivedAt: "2026-08-10T10:16:25.789Z",
      });
      const updateInput = makeInput({
        subject: "CHNUG #4 update: speaker change",
        body: UPDATE_BODY,
        receivedAt: "2026-08-14T12:24:45.818Z",
      });

      const [ticketResult, updateResult] = await Promise.all([
        classifier.classify(ticketInput),
        classifier.classify(updateInput),
      ]);

      expect(ticketResult.isOk()).toBe(true);
      expect(updateResult.isOk()).toBe(true);

      const ticketOutput = ticketResult._unsafeUnwrap();
      const updateOutput = updateResult._unsafeUnwrap();

      const senderETLD1 = getETLD1("events@chnug.ch");

      // Build embed texts (same as production — includes subject)
      const ticketEmbedText = buildEmbedText(senderETLD1, ticketOutput, "Your Order is Confirmed!  🎉");
      const updateEmbedText = buildEmbedText(senderETLD1, updateOutput, "CHNUG #4 update: speaker change");

      console.log("\n--- Ticket Embed Text ---");
      console.log(ticketEmbedText);
      console.log("\n--- Update Embed Text ---");
      console.log(updateEmbedText);

      // Generate embeddings using the primary cluster model
      const primaryCluster = getPrimaryThreadMatcherRegistry();
      const [ticketEmbedding, updateEmbedding] = await Promise.all([
        embeddingGenerator.generateForModel(ticketEmbedText, primaryCluster.modelId),
        embeddingGenerator.generateForModel(updateEmbedText, primaryCluster.modelId),
      ]);

      if (ticketEmbedding.isErr()) console.error("Ticket embedding error:", ticketEmbedding.error);
      if (updateEmbedding.isErr()) console.error("Update embedding error:", updateEmbedding.error);
      expect(ticketEmbedding.isOk()).toBe(true);
      expect(updateEmbedding.isOk()).toBe(true);

      const ticketVector = ticketEmbedding._unsafeUnwrap().vector;
      const updateVector = updateEmbedding._unsafeUnwrap().vector;

      const distance = cosineDistance(ticketVector, updateVector);
      console.log("\nCosine distance:", distance);
      console.log("Threshold:", SIMILARITY_THRESHOLD);
      console.log("Would match:", distance < SIMILARITY_THRESHOLD);

      // This is the core assertion: these two signals from the same event
      // should be similar enough to match in tier 2.
      expect(distance).toBeLessThan(SIMILARITY_THRESHOLD);
    });
  });
});
