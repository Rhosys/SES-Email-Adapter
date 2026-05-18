import type { Logger } from "../../src/logger.js";

export interface MockLoggerCall {
  method: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface MockLogger extends Logger {
  calls: MockLoggerCall[];
}

export function createMockLogger(): MockLogger {
  const calls: MockLoggerCall[] = [];
  return {
    calls,
    startInvocation(_id: string) {
      /* no-op */
    },
    getInvocationId() {
      return "test-invocation-id";
    },
    trackPoint() {
      /* no-op */
    },
    info(msg, ctx) {
      calls.push({ method: "info", message: msg, ...(ctx !== undefined ? { context: ctx } : {}) });
    },
    track(msg, ctx) {
      calls.push({ method: "track", message: msg, ...(ctx !== undefined ? { context: ctx } : {}) });
    },
    warn(msg, ctx) {
      calls.push({ method: "warn", message: msg, ...(ctx !== undefined ? { context: ctx } : {}) });
    },
    error(msg, ctx) {
      calls.push({ method: "error", message: msg, ...(ctx !== undefined ? { context: ctx } : {}) });
    },
    critical(msg, ctx) {
      calls.push({ method: "critical", message: msg, ...(ctx !== undefined ? { context: ctx } : {}) });
    },
  };
}
