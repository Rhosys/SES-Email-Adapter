import { describe, it, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { propertyRunner } from "../testing/property-runner.js";
import { ArcDatabase } from "./arc-database.js";

/**
 * Feature: dynamodb-storage-optimization, Property 5: Search warning threshold is bidirectional
 * Validates: Requirements 4.1, 4.3
 */
describe("Feature: dynamodb-storage-optimization, Property 5: Search warning threshold is bidirectional", () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  let db: ArcDatabase;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ddbMock.reset();
    db = new ArcDatabase();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    ddbMock.restore();
    warnSpy.mockRestore();
  });

  // Generator: random item count between 0 and 500
  const arbitraryItemCount = fc.integer({ min: 0, max: 500 });

  // Helper: generate fake Arc items for a given count
  function makeFakeItems(count: number): Record<string, unknown>[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `arc-${i}`,
      accountId: "acct-1",
      status: "active",
      summary: "test summary",
      workflow: "default",
      lastSignalAt: "2024-01-01T00:00:00.000Z",
      labels: [],
      urgency: "normal",
    }));
  }

  it("emits warning if and only if item count > 200", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbitraryItemCount, async (itemCount) => {
        ddbMock.reset();
        warnSpy.mockClear();

        ddbMock.on(QueryCommand).resolves({ Items: makeFakeItems(itemCount) });

        await db.searchArcs("acct-1", "test", { limit: 20 });

        const warningEmitted = warnSpy.mock.calls.length > 0;
        const shouldWarn = itemCount > 200;

        if (shouldWarn && !warningEmitted) {
          throw new Error(
            `Expected warning for itemCount=${itemCount} (>200), but none was emitted`,
          );
        }
        if (!shouldWarn && warningEmitted) {
          throw new Error(
            `Expected no warning for itemCount=${itemCount} (<=200), but one was emitted`,
          );
        }
      }),
    );
  });
});
