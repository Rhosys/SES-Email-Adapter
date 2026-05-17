/**
 * Global test setup — fails any test that writes to console.
 *
 * Production code should never call console.log/warn/error directly in tests.
 * If a test triggers console output, it means either:
 *   1. A dependency isn't mocked (e.g. the Logger writes to console.log)
 *   2. Code is using console directly instead of the Logger interface
 *
 * To intentionally test code that logs, mock the Logger interface — don't let
 * real console output leak into test runs.
 */

import { beforeEach, afterEach } from "vitest";

const INTERCEPTED_METHODS = ["log", "warn", "error", "info", "debug"] as const;

let originals: Record<string, typeof console.log>;

beforeEach(() => {
  originals = {};
  for (const method of INTERCEPTED_METHODS) {
    originals[method] = console[method];
    console[method] = (...args: unknown[]) => {
      // Restore immediately so the error itself can be printed
      for (const m of INTERCEPTED_METHODS) {
        console[m] = originals[m]!;
      }
      const preview = args.map(a => typeof a === "string" ? a.slice(0, 200) : JSON.stringify(a)?.slice(0, 200)).join(" ");
      throw new Error(
        `Unexpected console.${method}() call in test. This usually means a dependency is not mocked.\n` +
        `Output: ${preview}`,
      );
    };
  }
});

afterEach(() => {
  // Restore in case a test caught the error or the throw didn't propagate
  if (originals) {
    for (const method of INTERCEPTED_METHODS) {
      console[method] = originals[method]!;
    }
  }
});
