import { describe, it, expect } from "vitest";
import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import { processError } from "../errors.js";
import type { ProcessError } from "../errors.js";

/**
 * Extracts the failure collection logic from the batch handler's process() method.
 * Given an array of Result<void, ProcessError>, returns the batchItemFailures array.
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

describe("Batch handler failure collection", () => {
  it("empty results array produces zero failures", () => {
    expect(collectFailures([])).toEqual([]);
  });

  it("all-ok results produce zero failures", () => {
    const results: Result<void, ProcessError>[] = [ok(undefined), ok(undefined), ok(undefined)];
    expect(collectFailures(results)).toEqual([]);
  });

  it("all-err results produce one failure per result with matching messageIds", () => {
    const results: Result<void, ProcessError>[] = [
      err(processError("msg-1")),
      err(processError("msg-2")),
      err(processError("msg-3")),
    ];
    const failures = collectFailures(results);
    expect(failures).toHaveLength(3);
    expect(failures[0]!.itemIdentifier).toBe("msg-1");
    expect(failures[1]!.itemIdentifier).toBe("msg-2");
    expect(failures[2]!.itemIdentifier).toBe("msg-3");
  });

  it("mixed results produce failures only for err entries, preserving order", () => {
    const results: Result<void, ProcessError>[] = [
      ok(undefined),
      err(processError("msg-fail-1")),
      ok(undefined),
      err(processError("msg-fail-2")),
      ok(undefined),
    ];
    const failures = collectFailures(results);
    expect(failures).toHaveLength(2);
    expect(failures[0]!.itemIdentifier).toBe("msg-fail-1");
    expect(failures[1]!.itemIdentifier).toBe("msg-fail-2");
  });

  it("single err result produces exactly one failure", () => {
    const results: Result<void, ProcessError>[] = [err(processError("only-failure"))];
    const failures = collectFailures(results);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.itemIdentifier).toBe("only-failure");
  });
});
