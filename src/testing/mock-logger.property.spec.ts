import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockLogger } from "./mock-logger.js";
import type { Logger, LogLevel } from "../logger.js";

const ALL_LEVELS: LogLevel[] = ["info", "track", "warn", "error", "critical"];

function simulateConsumer(logger: Logger, level: LogLevel, message: string, context?: Record<string, unknown>): void {
  logger[level](message, context);
}

describe("Mock logger routes all calls to mock.calls without stdout", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it.each(ALL_LEVELS.map((level) => ({ level })))(
    "level=$level records call and does not write to stdout",
    ({ level }) => {
      const mock = createMockLogger();
      simulateConsumer(mock, level, "test.message", { key: "value" });

      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]!.method).toBe(level);
      expect(mock.calls[0]!.message).toBe("test.message");
      expect(mock.calls[0]!.context).toEqual({ key: "value" });
      expect(consoleSpy).not.toHaveBeenCalled();
    },
  );

  it("call without context omits context field from recorded call", () => {
    const mock = createMockLogger();
    simulateConsumer(mock, "info", "no.context");

    expect(mock.calls[0]!.context).toBeUndefined();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("multiple sequential calls are all recorded in order", () => {
    const mock = createMockLogger();
    simulateConsumer(mock, "info", "first");
    simulateConsumer(mock, "error", "second", { code: "ERR" });
    simulateConsumer(mock, "critical", "third");

    expect(mock.calls).toHaveLength(3);
    expect(mock.calls[0]!.method).toBe("info");
    expect(mock.calls[1]!.method).toBe("error");
    expect(mock.calls[2]!.method).toBe("critical");
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});
