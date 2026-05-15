// ---------------------------------------------------------------------------
// Unit tests for ReindexDispatcher
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ReindexDispatcher } from "./reindex-dispatcher.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const sqsMock = mockClient(SQSClient);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReindexDispatcher", () => {
  let dispatcher: ReindexDispatcher;

  beforeEach(() => {
    sqsMock.reset();
    sqsMock.on(SendMessageCommand).resolves({});
    dispatcher = new ReindexDispatcher({ sqs: sqsMock as unknown as SQSClient });
  });

  describe("dispatch", () => {
    it("rejects unknown cluster IDs", async () => {
      const result = await dispatcher.dispatch("nonexistent-cluster");
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.kind).toBe("not_found");
      }
    });

    it("dispatches correct number of SQS messages with default segment count", async () => {
      const result = await dispatcher.dispatch("aurora-prod-titan-v2");

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;
      expect(result.value.targetRegistryId).toBe("aurora-prod-titan-v2");
      expect(result.value.modelId).toBe("amazon.titan-embed-text-v2:0");
      expect(result.value.segmentCount).toBe(32);
      expect(result.value.jobId).toBeDefined();
      expect(result.value.startedAt).toBeDefined();

      const sqsCalls = sqsMock.commandCalls(SendMessageCommand);
      expect(sqsCalls).toHaveLength(32);
    });

    it("dispatches custom segment count", async () => {
      const result = await dispatcher.dispatch("aurora-prod-titan-v2", 8);

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;
      expect(result.value.segmentCount).toBe(8);

      const sqsCalls = sqsMock.commandCalls(SendMessageCommand);
      expect(sqsCalls).toHaveLength(8);
    });

    it("sends well-formed SQS messages with correct segment metadata", async () => {
      const result = await dispatcher.dispatch("aurora-prod-titan-v2", 4);

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;

      const sqsCalls = sqsMock.commandCalls(SendMessageCommand);
      const messages = sqsCalls.map((call) => JSON.parse(call.args[0].input.MessageBody!));

      for (let i = 0; i < 4; i++) {
        expect(messages[i]).toEqual({
          jobId: result.value.jobId,
          segment: i,
          totalSegments: 4,
          targetRegistryId: "aurora-prod-titan-v2",
          modelId: "amazon.titan-embed-text-v2:0",
        });
      }
    });
  });
});
