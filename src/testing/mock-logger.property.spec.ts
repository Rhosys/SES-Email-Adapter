import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { propertyRunner } from "./property-runner.js";
import { createMockLogger } from "./mock-logger.js";
import type { Logger, LogLevel } from "../logger.js";

const ALL_LEVELS: LogLevel[] = ["debug", "info", "track", "warn", "error", "critical"];

// Simulates a consumer that receives a logger via injection
function simulateConsumer(logger: Logger, level: LogLevel, message: string, context?: Record<string, unknown>): void {
  logger[level](message, context);
}

describe("Feature: structured-logging, Property 8: Mock injection routes all calls", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("all log calls route to mock.calls and nothing reaches stdout", async () => {
    /**
     * Validates: Requirements 7.3
     */
    const arbLevel = fc.constantFrom(...ALL_LEVELS);
    const arbMessage = fc.string({ minLength: 1, maxLength: 100 });
    const arbContext = fc.option(
      fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.jsonValue()),
      { nil: undefined },
    );

    await propertyRunner.assert(
      fc.asyncProperty(arbLevel, arbMessage, arbContext, async (level, message, context) => {
        consoleSpy.mockClear();
        const mock = createMockLogger();

        simulateConsumer(mock, level, message, context ?? undefined);

        // All calls are recorded in mock.calls
        expect(mock.calls).toHaveLength(1);
        expect(mock.calls[0].method).toBe(level);
        expect(mock.calls[0].message).toBe(message);
        if (context !== undefined) {
          expect(mock.calls[0].context).toEqual(context);
        }

        // Nothing was written to stdout
        expect(consoleSpy).not.toHaveBeenCalled();
      }),
    );
  });

  it("multiple sequential calls all route to mock without stdout writes", async () => {
    /**
     * Validates: Requirements 7.3
     */
    const arbCall = fc.record({
      level: fc.constantFrom(...ALL_LEVELS),
      message: fc.string({ minLength: 1, maxLength: 50 }),
      context: fc.option(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.jsonValue()),
        { nil: undefined },
      ),
    });
    const arbCalls = fc.array(arbCall, { minLength: 1, maxLength: 10 });

    await propertyRunner.assert(
      fc.asyncProperty(arbCalls, async (calls) => {
        consoleSpy.mockClear();
        const mock = createMockLogger();

        for (const { level, message, context } of calls) {
          simulateConsumer(mock, level, message, context ?? undefined);
        }

        // Every call is recorded
        expect(mock.calls).toHaveLength(calls.length);
        for (let i = 0; i < calls.length; i++) {
          expect(mock.calls[i].method).toBe(calls[i].level);
          expect(mock.calls[i].message).toBe(calls[i].message);
        }

        // Nothing reached stdout
        expect(consoleSpy).not.toHaveBeenCalled();
      }),
    );
  });
});
