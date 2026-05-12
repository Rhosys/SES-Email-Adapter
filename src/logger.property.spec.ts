import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { propertyRunner } from "./testing/property-runner.js";
import { RequestLogger } from "./logger.js";
import type { LogLevel } from "./logger.js";

const ALL_LEVELS: LogLevel[] = ["debug", "info", "track", "warn", "error", "critical"];
const TRACK_POINT_LEVELS: LogLevel[] = ["track", "error", "critical"];
const NO_TRACK_POINT_LEVELS: LogLevel[] = ["debug", "info", "warn"];
const STACK_LEVELS: LogLevel[] = ["error", "critical"];
const NO_STACK_LEVELS: LogLevel[] = ["debug", "info", "track", "warn"];

function callLevel(logger: RequestLogger, level: LogLevel, message: string, context?: Record<string, unknown>): void {
  logger[level](message, context);
}

describe("Feature: structured-logging, Property 1: Log entry structural invariant", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("every log call produces a single valid JSON line with required fields via console.log", async () => {
    /**
     * Validates: Requirements 1.1, 1.2, 1.3, 2.5, 3.3
     */
    const arbLevel = fc.constantFrom(...ALL_LEVELS);
    const arbMessage = fc.string({ minLength: 1, maxLength: 100 }).map((s) => s.replace(/\s/g, "."));
    const arbContext = fc.option(fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.jsonValue()), { nil: undefined });

    await propertyRunner.assert(
      fc.asyncProperty(arbLevel, arbMessage, arbContext, async (level, message, context) => {
        consoleSpy.mockClear();
        const logger = new RequestLogger("test1234");
        logger.startInvocation();

        callLevel(logger, level, message, context ?? undefined);

        // Find the last console.log call (the actual entry, not a truncation warning)
        const calls = consoleSpy.mock.calls;
        expect(calls.length).toBeGreaterThanOrEqual(1);

        const lastCall = calls[calls.length - 1];
        expect(lastCall).toHaveLength(1);
        const raw = lastCall[0] as string;

        // Must be valid JSON
        const entry = JSON.parse(raw);

        // Required fields present
        expect(entry).toHaveProperty("level", level);
        expect(entry).toHaveProperty("message", message);
        expect(entry).toHaveProperty("timestamp");
        expect(entry).toHaveProperty("invocationId");
        expect(entry).toHaveProperty("containerId", "test1234");

        // Timestamp is ISO 8601
        const ts = new Date(entry.timestamp);
        expect(ts.toISOString()).toBe(entry.timestamp);

        // Written via console.log (not console.error)
        expect(consoleSpy).toHaveBeenCalled();
      }),
    );
  });
});

describe("Feature: structured-logging, Property 2: Context merge preserves required fields", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("context keys matching required field names cannot overwrite logger internal state", async () => {
    /**
     * Validates: Requirements 1.5
     */
    const arbLevel = fc.constantFrom(...ALL_LEVELS);
    const arbMessage = fc.string({ minLength: 1, maxLength: 50 }).map((s) => s.replace(/\s/g, "."));
    const arbConflictingContext = fc.record({
      level: fc.string({ minLength: 1, maxLength: 20 }),
      message: fc.string({ minLength: 1, maxLength: 50 }),
      timestamp: fc.string({ minLength: 1, maxLength: 30 }),
      invocationId: fc.string({ minLength: 1, maxLength: 40 }),
      containerId: fc.string({ minLength: 1, maxLength: 20 }),
    });

    await propertyRunner.assert(
      fc.asyncProperty(arbLevel, arbMessage, arbConflictingContext, async (level, message, context) => {
        consoleSpy.mockClear();
        const logger = new RequestLogger("test1234");
        logger.startInvocation();

        callLevel(logger, level, message, context);

        const calls = consoleSpy.mock.calls;
        const lastCall = calls[calls.length - 1];
        const entry = JSON.parse(lastCall[0] as string);

        // Required fields reflect logger state, not context values
        expect(entry.level).toBe(level);
        expect(entry.message).toBe(message);
        expect(entry.containerId).toBe("test1234");
        // invocationId should be a UUID, not the arbitrary string from context
        expect(entry.invocationId).not.toBe(context.invocationId);
        expect(entry.invocationId).toMatch(/^[0-9a-f-]{36}$/);
      }),
    );
  });
});

describe("Feature: structured-logging, Property 3: Track points included for track/error/critical levels", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("track/error/critical include all recorded track points; debug/info/warn do not", async () => {
    /**
     * Validates: Requirements 2.3, 2.4, 4.2, 4.3
     */
    const arbTrackPointNames = fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 1, maxLength: 5 });
    const arbLevelWithPoints = fc.constantFrom(...TRACK_POINT_LEVELS);
    const arbLevelWithoutPoints = fc.constantFrom(...NO_TRACK_POINT_LEVELS);
    const arbMessage = fc.constant("test.message");

    await propertyRunner.assert(
      fc.asyncProperty(arbTrackPointNames, arbLevelWithPoints, async (names, level) => {
        consoleSpy.mockClear();
        const logger = new RequestLogger("test1234");
        logger.startInvocation();

        for (const name of names) {
          logger.trackPoint(name);
        }

        callLevel(logger, level, "test.message");

        const calls = consoleSpy.mock.calls;
        const lastCall = calls[calls.length - 1];
        const entry = JSON.parse(lastCall[0] as string);

        expect(entry.trackPoints).toBeDefined();
        expect(entry.trackPoints).toHaveLength(names.length);
        for (let i = 0; i < names.length; i++) {
          expect(entry.trackPoints[i].name).toBe(names[i]);
          expect(entry.trackPoints[i].elapsedMs).toBeGreaterThanOrEqual(0);
        }
      }),
    );

    await propertyRunner.assert(
      fc.asyncProperty(arbTrackPointNames, arbLevelWithoutPoints, async (names, level) => {
        consoleSpy.mockClear();
        const logger = new RequestLogger("test1234");
        logger.startInvocation();

        for (const name of names) {
          logger.trackPoint(name);
        }

        callLevel(logger, level, "test.message");

        const calls = consoleSpy.mock.calls;
        const lastCall = calls[calls.length - 1];
        const entry = JSON.parse(lastCall[0] as string);

        expect(entry.trackPoints).toBeUndefined();
      }),
    );
  });
});

describe("Feature: structured-logging, Property 4: Error and critical include stack trace", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("error/critical have non-empty stack field; other levels have no stack field", async () => {
    /**
     * Validates: Requirements 2.2
     */
    const arbStackLevel = fc.constantFrom(...STACK_LEVELS);
    const arbNoStackLevel = fc.constantFrom(...NO_STACK_LEVELS);
    const arbMessage = fc.string({ minLength: 1, maxLength: 50 }).map((s) => s.replace(/\s/g, "."));

    await propertyRunner.assert(
      fc.asyncProperty(arbStackLevel, arbMessage, async (level, message) => {
        consoleSpy.mockClear();
        const logger = new RequestLogger("test1234");
        logger.startInvocation();

        callLevel(logger, level, message);

        const calls = consoleSpy.mock.calls;
        const lastCall = calls[calls.length - 1];
        const entry = JSON.parse(lastCall[0] as string);

        expect(entry.stack).toBeDefined();
        expect(typeof entry.stack).toBe("string");
        expect(entry.stack.length).toBeGreaterThan(0);
      }),
    );

    await propertyRunner.assert(
      fc.asyncProperty(arbNoStackLevel, arbMessage, async (level, message) => {
        consoleSpy.mockClear();
        const logger = new RequestLogger("test1234");
        logger.startInvocation();

        callLevel(logger, level, message);

        const calls = consoleSpy.mock.calls;
        const lastCall = calls[calls.length - 1];
        const entry = JSON.parse(lastCall[0] as string);

        expect(entry.stack).toBeUndefined();
      }),
    );
  });
});

describe("Feature: structured-logging, Property 5: startInvocation resets state and preserves container ID", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("after startInvocation, invocationId changes, track points are cleared, containerId is stable", async () => {
    /**
     * Validates: Requirements 3.1, 3.2, 3.4
     */
    const arbTrackPointNames = fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 5 });

    await propertyRunner.assert(
      fc.asyncProperty(arbTrackPointNames, async (names) => {
        consoleSpy.mockClear();
        const logger = new RequestLogger("test1234");
        logger.startInvocation();

        // Record some track points
        for (const name of names) {
          logger.trackPoint(name);
        }

        // Log to capture the first invocationId
        logger.track("before.reset");
        const firstCall = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1];
        const firstEntry = JSON.parse(firstCall[0] as string);
        const firstInvocationId = firstEntry.invocationId;
        const firstContainerId = firstEntry.containerId;

        // Reset
        logger.startInvocation();

        // Log again — should have new invocationId, no track points, same containerId
        consoleSpy.mockClear();
        logger.track("after.reset");
        const secondCall = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1];
        const secondEntry = JSON.parse(secondCall[0] as string);

        expect(secondEntry.invocationId).not.toBe(firstInvocationId);
        expect(secondEntry.invocationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(secondEntry.trackPoints).toBeUndefined();
        expect(secondEntry.containerId).toBe(firstContainerId);
        expect(secondEntry.containerId).toBe("test1234");
      }),
    );
  });
});

describe("Feature: structured-logging, Property 6: Recursive secret redaction", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("fields matching secret/signature/authorization are redacted preserving first 8 chars", async () => {
    /**
     * Validates: Requirements 5.1, 5.2, 5.4
     */
    const arbSecretKey = fc.constantFrom("clientSecret", "webhookSignature", "apiSecret", "tokenSignature");
    const arbLongValue = fc.string({ minLength: 9, maxLength: 100 });
    const arbShortValue = fc.string({ minLength: 1, maxLength: 8 });

    // Test long values (> 8 chars): first 8 preserved + [REDACTED]
    await propertyRunner.assert(
      fc.asyncProperty(arbSecretKey, arbLongValue, async (key, value) => {
        consoleSpy.mockClear();
        const logger = new RequestLogger("test1234");
        logger.startInvocation();

        logger.info("test.redaction", { [key]: value });

        const calls = consoleSpy.mock.calls;
        const lastCall = calls[calls.length - 1];
        const entry = JSON.parse(lastCall[0] as string);

        expect(entry[key]).toBe(value.slice(0, 8) + "[REDACTED]");
      }),
    );

    // Test short values (<= 8 chars): entire value replaced
    await propertyRunner.assert(
      fc.asyncProperty(arbSecretKey, arbShortValue, async (key, value) => {
        consoleSpy.mockClear();
        const logger = new RequestLogger("test1234");
        logger.startInvocation();

        logger.info("test.redaction", { [key]: value });

        const calls = consoleSpy.mock.calls;
        const lastCall = calls[calls.length - 1];
        const entry = JSON.parse(lastCall[0] as string);

        expect(entry[key]).toBe("[REDACTED]");
      }),
    );

    // Test authorization key specifically
    await propertyRunner.assert(
      fc.asyncProperty(fc.constantFrom("authorization", "Authorization"), arbLongValue, async (key, value) => {
        consoleSpy.mockClear();
        const logger = new RequestLogger("test1234");
        logger.startInvocation();

        logger.info("test.auth.redaction", { [key]: value });

        const calls = consoleSpy.mock.calls;
        const lastCall = calls[calls.length - 1];
        const entry = JSON.parse(lastCall[0] as string);

        expect(entry[key]).toBe(value.slice(0, 8) + "[REDACTED]");
      }),
    );

    // Test nested redaction (recursive)
    await propertyRunner.assert(
      fc.asyncProperty(arbSecretKey, arbLongValue, async (key, value) => {
        consoleSpy.mockClear();
        const logger = new RequestLogger("test1234");
        logger.startInvocation();

        logger.info("test.nested.redaction", {
          outer: { inner: { [key]: value } },
        });

        const calls = consoleSpy.mock.calls;
        const lastCall = calls[calls.length - 1];
        const entry = JSON.parse(lastCall[0] as string);

        expect(entry.outer.inner[key]).toBe(value.slice(0, 8) + "[REDACTED]");
      }),
    );
  });
});

describe("Feature: log-message-review, Property 2: Code field does not duplicate in context", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("code appears exactly once in serialized output when provided in context", async () => {
    /**
     * Validates: Requirements 2.1, 2.2
     */
    const arbLevel = fc.constantFrom(...ALL_LEVELS);
    const arbMessage = fc.string({ minLength: 1, maxLength: 100 });
    // Generate valid dot-separated identifiers for code values
    const arbSegment = fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/);
    const arbCode = fc
      .array(arbSegment, { minLength: 2, maxLength: 4 })
      .map((segments) => segments.join("."));
    // Generate random context with additional fields (excluding "code" key)
    const arbExtraContext = fc.dictionary(
      fc.string({ minLength: 1, maxLength: 20 }).filter((k) => k !== "code"),
      fc.jsonValue(),
    );

    await propertyRunner.assert(
      fc.asyncProperty(arbLevel, arbMessage, arbCode, arbExtraContext, async (level, message, code, extra) => {
        consoleSpy.mockClear();
        const logger = new RequestLogger("test1234");
        logger.startInvocation();

        const context = { ...extra, code };
        callLevel(logger, level, message, context);

        const calls = consoleSpy.mock.calls;
        expect(calls.length).toBeGreaterThanOrEqual(1);

        // Get the primary log entry (last call, skipping any truncation warning)
        const lastCall = calls[calls.length - 1];
        const raw = lastCall[0] as string;

        // Count occurrences of "code" as a JSON key in the serialized output.
        // A JSON key appears as "code": (with quotes and colon).
        const codeKeyMatches = raw.match(/"code"\s*:/g);
        expect(codeKeyMatches).not.toBeNull();
        expect(codeKeyMatches!.length).toBe(1);
      }),
    );
  });
});

describe("Feature: structured-logging, Property 7: Payload truncation guard", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("entries exceeding 262,144 bytes are truncated with _truncated flag and a separate WARN entry", async () => {
    /**
     * Validates: Requirements 6.1, 6.2
     */
    // Generate a string large enough to exceed 256KB
    const arbLargeString = fc.string({ minLength: 270_000, maxLength: 300_000 });

    await propertyRunner.assert(
      fc.asyncProperty(arbLargeString, async (largeValue) => {
        consoleSpy.mockClear();
        const logger = new RequestLogger("test1234");
        logger.startInvocation();

        logger.info("test.large.payload", { data: largeValue });

        const calls = consoleSpy.mock.calls;
        // Should have 2 calls: the warning entry and the truncated entry
        expect(calls.length).toBe(2);

        // First call is the warning
        const warningEntry = JSON.parse(calls[0][0] as string);
        expect(warningEntry.level).toBe("warn");
        expect(warningEntry.message).toBe("logger.payload_truncated");
        expect(warningEntry.originalMessage).toBe("test.large.payload");
        expect(warningEntry.originalSizeBytes).toBeGreaterThan(262_144);

        // Second call is the truncated entry
        const truncatedEntry = JSON.parse(calls[1][0] as string);
        expect(truncatedEntry._truncated).toBe(true);
        expect(truncatedEntry.level).toBe("info");
        expect(truncatedEntry.message).toBe("test.large.payload");

        // Verify the truncated output is within the limit
        const truncatedSize = Buffer.byteLength(calls[1][0] as string, "utf8");
        expect(truncatedSize).toBeLessThanOrEqual(262_144);
      }),
      { numRuns: 20 }, // Fewer runs for large payloads to keep test time reasonable
    );
  });
});
