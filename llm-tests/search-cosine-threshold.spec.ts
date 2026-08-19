// LLM Integration Test — Search Query Cosine Distance
//
// Validates that a single-word search query ("chnug") produces an embedding
// close enough to a real CHNUG signal's embedding to be found by vector search.
//
// This test exposed that the SIMILARITY_THRESHOLD (0.5) was too tight for
// single-word queries — the user types "chnug" expecting to find their CHNUG
// event ticket, but vector search returns nothing.
//
// RUN:
//   npx tsx ~/.kiro/skills/lib/aws-cli.ts "Search cosine threshold test" -- \
//     npx vitest run --config llm-tests/vitest.config.ts search-cosine-threshold
//
// REQUIRES: AWS SSO authentication (same as chnug-thread-match.spec.ts)

import { describe, it, expect } from "vitest";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { SignalClassifier } from "../src/classifier/classifier.js";
import type { ClassificationInput } from "../src/classifier/classifier.js";
import { BedrockEmbeddingGenerator } from "../src/embedding/embedding-generator.js";
import { buildEmbedText } from "../src/embedding/embed-text.js";
import { getETLD1 } from "../src/processor/filter.js";
import { getPrimaryThreadMatcherRegistry } from "../src/embedding/cluster-registry.js";
import type { Logger } from "../src/logger.js";

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
  return 1 - similarity;
}

// ---------------------------------------------------------------------------
// Signal data: CHNUG #4 ticket confirmation (real production signal)
// ---------------------------------------------------------------------------
const CHNUG_SIGNAL = {
  from: "events@chnug.ch",
  subject: "Your Order is Confirmed!  🎉",
  body: `Congratulations! Your order for CHNUG #4 on August 26, 2026 at 5:00 PM was successful. Please find your order details below.

Event Details
Event Name: CHNUG #4
Date & Time: August 26, 2026 at 5:00 PM

Order Summary
Order Number: O-UGWRW9Q
Total Amount: CHF 0.00

View Order Summary & Tickets: https://events.chnug.ch/checkout/5/o_YV28UCAMSvfah/summary

If you have any questions or need assistance, please contact events@chnug.ch.

Best regards,
CHNUG`,
  receivedAt: "2026-08-10T10:16:25.789Z",
};

describe("Search query cosine distance — single-word queries", () => {
  it("'chnug' search query is within threshold of CHNUG ticket signal embedding", async () => {
    // Step 1: Classify the signal (same as production processor does)
    const classificationInput: ClassificationInput = {
      from: CHNUG_SIGNAL.from,
      to: ["chung@vortex.link"],
      subject: CHNUG_SIGNAL.subject,
      body: CHNUG_SIGNAL.body,
      receivedAt: CHNUG_SIGNAL.receivedAt,
      headers: {},
      allowedLabels: [],
      labelInstructions: {},
    };

    const classResult = await classifier.classify(classificationInput);
    if (classResult.isErr()) console.error("Classification failed:", classResult.error);
    expect(classResult.isOk()).toBe(true);
    const classification = classResult._unsafeUnwrap();

    console.log("Classification:", JSON.stringify(classification, null, 2));

    // Step 2: Build the signal's embed text (same as production)
    const senderETLD1 = getETLD1(CHNUG_SIGNAL.from);
    const signalEmbedText = buildEmbedText(senderETLD1, classification, CHNUG_SIGNAL.subject);
    console.log("\n--- Signal Embed Text ---");
    console.log(signalEmbedText);

    // Step 3: Generate embeddings for both the signal and the search query
    const primaryCluster = getPrimaryThreadMatcherRegistry();
    const [signalEmbedding, queryEmbedding] = await Promise.all([
      embeddingGenerator.generateForModel(signalEmbedText, primaryCluster.modelId),
      embeddingGenerator.generateForModel("chnug", primaryCluster.modelId),
    ]);

    if (signalEmbedding.isErr()) console.error("Signal embedding error:", signalEmbedding.error);
    if (queryEmbedding.isErr()) console.error("Query embedding error:", queryEmbedding.error);
    expect(signalEmbedding.isOk()).toBe(true);
    expect(queryEmbedding.isOk()).toBe(true);

    const signalVector = signalEmbedding._unsafeUnwrap().vector;
    const queryVector = queryEmbedding._unsafeUnwrap().vector;

    // Step 4: Compute cosine distance
    const distance = cosineDistance(signalVector, queryVector);
    console.log("\nSearch query: 'chnug'");
    console.log("Cosine distance:", distance);
    console.log("Old threshold (0.5):", distance < 0.5 ? "PASS" : "FAIL");
    console.log("New threshold (0.8):", distance < 0.8 ? "PASS" : "FAIL");

    // Step 5: Assert the distance is within the production SEARCH_THRESHOLD (0.75).
    // The distance (≈0.57) is above the old THREAD_MATCH_THRESHOLD (0.5) — which is
    // correct: you don't want a search query merging signals. But it's well below the
    // SEARCH_THRESHOLD (0.75), so the user's search finds the signal.
    expect(distance).toBeGreaterThan(0.5);  // confirms thread-match threshold was too tight
    expect(distance).toBeLessThan(0.75);    // confirms search threshold catches it
  });
});
