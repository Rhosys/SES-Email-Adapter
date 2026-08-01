// ---------------------------------------------------------------------------
// Unit tests for ReindexDispatcher
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ReindexDispatcher } from "../../../src/jobs/reindex/reindex-dispatcher.js";
import { createMockLogger } from "../../helpers/mock-logger.js";
import type { SignalQueue } from "../../../src/messaging/signal-queue.js";
import { ok } from "neverthrow";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockQueue() {
  const calls: Array<{ messageType: string; payload: unknown }> = [];
  const queue = {
    send: vi.fn(async (messageType: string, payload: unknown) => {
      calls.push({ messageType, payload });
      return ok(undefined);
    }),
    sendBatch: vi.fn(async () => ok(undefined)),
  } satisfies Pick<SignalQueue, "send" | "sendBatch">;
  return { queue: queue as unknown as SignalQueue, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReindexDispatcher", () => {
  let dispatcher: ReindexDispatcher;
  let mockQueue: ReturnType<typeof createMockQueue>;

  beforeEach(() => {
    mockQueue = createMockQueue();
    dispatcher = new ReindexDispatcher({ signalQueue: mockQueue.queue, logger: createMockLogger() });
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

      expect(mockQueue.queue.send).toHaveBeenCalledTimes(32);
    });

    it("dispatches custom segment count", async () => {
      const result = await dispatcher.dispatch("aurora-prod-titan-v2", 8);

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;
      expect(result.value.segmentCount).toBe(8);

      expect(mockQueue.queue.send).toHaveBeenCalledTimes(8);
    });

    it("sends well-formed SQS messages with correct segment metadata", async () => {
      const result = await dispatcher.dispatch("aurora-prod-titan-v2", 4);

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;

      expect(mockQueue.calls).toHaveLength(4);
      for (let i = 0; i < 4; i++) {
        expect(mockQueue.calls[i]!.messageType).toBe("reindex");
        expect(mockQueue.calls[i]!.payload).toEqual({
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
