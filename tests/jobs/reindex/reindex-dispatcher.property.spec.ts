// Feature: aurora-reindex-strategy, Property 10: Reindex dispatcher emits exactly N well-formed segment messages
// **Validates: Requirements 4.2, 4.3**
//
// For any target cluster and any segment count (1-256), the ReindexDispatcher dispatch method:
// 1. Emits exactly N SQS messages (where N = segmentCount)
// 2. Each message has the correct structure: { jobId, segment, totalSegments, targetRegistryId, modelId }
// 3. Segment numbers are 0..N-1 with no gaps or duplicates
// 4. totalSegments equals the requested segmentCount
// 5. modelId is resolved from the cluster registry

import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ReindexDispatcher } from "../../../src/jobs/reindex/reindex-dispatcher.js";
import { CLUSTER_REGISTRY } from "../../../src/embedding/cluster-registry.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const sqsMock = mockClient(SQSClient);

// ---------------------------------------------------------------------------
// Edge-case-driven tests
// ---------------------------------------------------------------------------

const cases: Array<[string, { targetRegistryId: string; segmentCount: number }]> = [
  ["single segment — minimum work unit", { targetRegistryId: "aurora-prod-titan-v2", segmentCount: 1 }],
  ["two segments — verifies 0-based indexing", { targetRegistryId: "aurora-prod-titan-v2", segmentCount: 2 }],
  ["ten segments — typical small job", { targetRegistryId: "aurora-prod-titan-v2", segmentCount: 10 }],
  ["256 segments — maximum allowed", { targetRegistryId: "aurora-prod-titan-v2", segmentCount: 256 }],
];

describe("Property 10: Reindex dispatcher emits exactly N well-formed segment messages", () => {
  let dispatcher: ReindexDispatcher;

  beforeEach(() => {
    sqsMock.reset();
    sqsMock.on(SendMessageCommand).resolves({});
    dispatcher = new ReindexDispatcher({ sqs: sqsMock as unknown as SQSClient });
  });

  it.each(cases)("%s", async (_label, { targetRegistryId, segmentCount }) => {
    sqsMock.reset();
    sqsMock.on(SendMessageCommand).resolves({});

    const result = await dispatcher.dispatch(targetRegistryId, segmentCount);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // 1. Verify exactly N SQS messages were sent
    const sqsCalls = sqsMock.commandCalls(SendMessageCommand);
    expect(sqsCalls).toHaveLength(segmentCount);

    // 2. Parse all messages and verify structure
    const messages = sqsCalls.map((call) =>
      JSON.parse(call.args[0].input.MessageBody!) as {
        jobId: string;
        segment: number;
        totalSegments: number;
        targetRegistryId: string;
        modelId: string;
      },
    );

    // Get expected modelId from registry
    const expectedModelId = CLUSTER_REGISTRY.find(
      (c) => c.registryId === targetRegistryId,
    )!.modelId;

    // 3. Each message contains all required fields with correct values
    for (const message of messages) {
      expect(message.jobId).toBe(result.value.jobId);
      expect(message.totalSegments).toBe(segmentCount);
      expect(message.targetRegistryId).toBe(targetRegistryId);
      expect(message.modelId).toBe(expectedModelId);
      expect(typeof message.segment).toBe("number");
    }

    // 4. Segment numbers cover [0, segmentCount) with no gaps or duplicates
    const segments = messages.map((m) => m.segment).sort((a, b) => a - b);
    const expectedSegments = Array.from({ length: segmentCount }, (_, i) => i);
    expect(segments).toEqual(expectedSegments);

    // 5. modelId matches the target cluster's registry entry
    expect(result.value.modelId).toBe(expectedModelId);
  });
});
