import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import { processError } from "../errors.js";
import type { ProcessError } from "../errors.js";
import { propertyRunner } from "../testing/property-runner.js";

// ---------------------------------------------------------------------------
// Property 2: Batch handler failure collection
// For any list of Result<void, ProcessError> values, the batch handler produces
// exactly one batchItemFailure entry per err result, and zero entries for ok results.
// Each failure's itemIdentifier matches the corresponding messageId.
// **Validates: Requirements 3.3, 3.5, 8.4**
// ---------------------------------------------------------------------------

/**
 * Extracts the failure collection logic from the batch handler's process() method.
 * Given an array of Result<void, ProcessError>, returns the batchItemFailures array.
 * This mirrors the logic in SignalProcessor.process() and ReindexWorker.process().
 */
function collectFailures(results: Result<void, ProcessError>[]): Array<{ itemIdentifier: string }> {
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const result of results) {
    if (result.isErr()) {
      failures.push({ itemIdentifier: result.error.messageId });
    }
  }
  return failures;
}

describe("Property 2: Batch handler failure collection", () => {
  it("produces exactly one batchItemFailure per err result and zero for ok results", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            isError: fc.boolean(),
            messageId: fc.uuid(),
          }),
          { minLength: 0, maxLength: 50 },
        ),
        async (records) => {
          const results: Result<void, ProcessError>[] = records.map((r) =>
            r.isError ? err(processError(r.messageId)) : ok(undefined),
          );

          const failures = collectFailures(results);

          // Count of failures must equal count of err results
          const expectedCount = records.filter((r) => r.isError).length;
          expect(failures.length).toBe(expectedCount);
        },
      ),
    );
  });

  it("each failure's itemIdentifier matches the corresponding messageId", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            isError: fc.boolean(),
            messageId: fc.uuid(),
          }),
          { minLength: 1, maxLength: 50 },
        ),
        async (records) => {
          const results: Result<void, ProcessError>[] = records.map((r) =>
            r.isError ? err(processError(r.messageId)) : ok(undefined),
          );

          const failures = collectFailures(results);

          // Every error record's messageId must appear in failures
          const errorRecords = records.filter((r) => r.isError);
          for (const r of errorRecords) {
            expect(failures.some((f) => f.itemIdentifier === r.messageId)).toBe(true);
          }

          // Every failure's itemIdentifier must come from an error record
          const errorMessageIds = new Set(errorRecords.map((r) => r.messageId));
          for (const f of failures) {
            expect(errorMessageIds.has(f.itemIdentifier)).toBe(true);
          }
        },
      ),
    );
  });

  it("ok results never produce batchItemFailures", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        fc.array(fc.uuid(), { minLength: 1, maxLength: 50 }),
        async (messageIds) => {
          // All results are ok
          const results: Result<void, ProcessError>[] = messageIds.map(() => ok(undefined));

          const failures = collectFailures(results);

          expect(failures.length).toBe(0);
        },
      ),
    );
  });

  it("all-error results produce failures for every record", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        fc.array(fc.uuid(), { minLength: 1, maxLength: 50 }),
        async (messageIds) => {
          // All results are err
          const results: Result<void, ProcessError>[] = messageIds.map((id) =>
            err(processError(id)),
          );

          const failures = collectFailures(results);

          expect(failures.length).toBe(messageIds.length);
          for (const id of messageIds) {
            expect(failures.some((f) => f.itemIdentifier === id)).toBe(true);
          }
        },
      ),
    );
  });

  it("preserves order — failures appear in the same order as err results", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            isError: fc.boolean(),
            messageId: fc.uuid(),
          }),
          { minLength: 1, maxLength: 50 },
        ),
        async (records) => {
          const results: Result<void, ProcessError>[] = records.map((r) =>
            r.isError ? err(processError(r.messageId)) : ok(undefined),
          );

          const failures = collectFailures(results);

          // Failures should appear in the same order as the err results in the input
          const expectedOrder = records
            .filter((r) => r.isError)
            .map((r) => r.messageId);

          expect(failures.map((f) => f.itemIdentifier)).toEqual(expectedOrder);
        },
      ),
    );
  });
});
