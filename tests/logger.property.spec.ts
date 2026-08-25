import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RequestLogger } from "../src/logger.js";
import type { LogLevel } from "../src/logger.js";

const ALL_LEVELS: LogLevel[] = ["info", "track", "warn", "error", "critical"];
const TRACK_POINT_LEVELS: LogLevel[] = ["track", "error", "critical"];
const NO_TRACK_POINT_LEVELS: LogLevel[] = ["info", "warn"];
const STACK_LEVELS: LogLevel[] = ["error", "critical"];
const NO_STACK_LEVELS: LogLevel[] = ["info", "track", "warn"];

function callLevel(logger: RequestLogger, level: LogLevel, message: string, context?: Record<string, unknown>): void {
  logger[level](message, context);
}

function lastEntryFromSpies(...spies: Array<ReturnType<typeof vi.spyOn>>): Record<string, unknown> {
  for (const spy of spies) {
    const calls = spy.mock.calls;
    if (calls.length > 0) {
      const lastCall = calls[calls.length - 1]!;
      const value = lastCall[0];
      if (typeof value === "string") return JSON.parse(value);
      return value as Record<string, unknown>;
    }
  }
  throw new Error("No console calls recorded");
}

function allCallsFromSpies(...spies: Array<ReturnType<typeof vi.spyOn>>): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  for (const spy of spies) {
    for (const call of spy.mock.calls) {
      const value = call[0];
      if (typeof value === "string") results.push(JSON.parse(value));
      else results.push(value as Record<string, unknown>);
    }
  }
  return results;
}

describe("Log entry structural invariant", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it.each(ALL_LEVELS.map((level) => ({ level })))(
    "level=$level produces valid JSON with required fields",
    ({ level }) => {
      const logger = new RequestLogger({ containerId: "test1234" });
      logger.startInvocation("test-invocation");
      callLevel(logger, level, "test.msg", { extra: "data" });

      const entry = lastEntryFromSpies(logSpy, warnSpy, errorSpy);
      expect(entry.level).toBe(level.toUpperCase());
      expect(entry.title).toBe("test.msg");
      expect(entry.containerId).toBe("test1234");
      if (level === "error" || level === "critical") {
        // Omitted so error-tracking tools can aggregate identical errors across invocations.
        expect(entry.invocationId).toBeUndefined();
      } else {
        expect(entry.invocationId).toBe("test-invocation");
      }
      expect(new Date(entry.timestamp as string).toISOString()).toBe(entry.timestamp);
    },
  );
});

describe("Context merge preserves required fields", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("context keys matching required field names cannot overwrite logger state", () => {
    const logger = new RequestLogger({ containerId: "test1234" });
    logger.startInvocation("test-invocation");

    callLevel(logger, "info", "real.message", {
      level: "FAKE",
      message: "FAKE",
      timestamp: "FAKE",
      invocationId: "FAKE",
      containerId: "FAKE",
    });

    const entry = lastEntryFromSpies(logSpy, warnSpy, errorSpy);
    expect(entry.level).toBe("INFO");
    expect(entry.title).toBe("real.message");
    expect(entry.containerId).toBe("test1234");
    expect(entry.invocationId).not.toBe("FAKE");
    expect(entry.invocationId).toBe("test-invocation");
  });

  it("error level omits invocationId even when context supplies one", () => {
    const logger = new RequestLogger({ containerId: "test1234" });
    logger.startInvocation("test-invocation");

    callLevel(logger, "error", "real.message", { invocationId: "FAKE" });

    const entry = lastEntryFromSpies(logSpy, warnSpy, errorSpy);
    expect(entry.invocationId).toBeUndefined();
  });
});

describe("Track points included for track/error/critical levels", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it.each(TRACK_POINT_LEVELS.map((level) => ({ level })))(
    "level=$level includes trackPoints array",
    ({ level }) => {
      const logger = new RequestLogger({ containerId: "test1234" });
      logger.startInvocation("test-invocation");
      logger.trackPoint("step.one");
      logger.trackPoint("step.two");
      callLevel(logger, level, "test.msg");

      const entry = lastEntryFromSpies(logSpy, warnSpy, errorSpy);
      expect(entry.trackPoints).toBeDefined();
      const tp = entry.trackPoints as Array<{ name: string; elapsedMs: number }>;
      expect(tp).toHaveLength(2);
      expect(tp[0]!.name).toBe("step.one");
      expect(tp[1]!.name).toBe("step.two");
      expect(tp[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
    },
  );

  it.each(NO_TRACK_POINT_LEVELS.map((level) => ({ level })))(
    "level=$level does NOT include trackPoints",
    ({ level }) => {
      const logger = new RequestLogger({ containerId: "test1234" });
      logger.startInvocation("test-invocation");
      logger.trackPoint("step.one");
      callLevel(logger, level, "test.msg");

      const entry = lastEntryFromSpies(logSpy, warnSpy, errorSpy);
      expect(entry.trackPoints).toBeUndefined();
    },
  );
});

describe("Error and critical include stack trace", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it.each(STACK_LEVELS.map((level) => ({ level })))(
    "level=$level has non-empty stack field",
    ({ level }) => {
      const logger = new RequestLogger({ containerId: "test1234" });
      logger.startInvocation("test-invocation");
      callLevel(logger, level, "test.msg");

      const entry = lastEntryFromSpies(logSpy, warnSpy, errorSpy);
      expect(typeof entry.stack).toBe("string");
      expect((entry.stack as string).length).toBeGreaterThan(0);
    },
  );

  it.each(NO_STACK_LEVELS.map((level) => ({ level })))(
    "level=$level has no stack field",
    ({ level }) => {
      const logger = new RequestLogger({ containerId: "test1234" });
      logger.startInvocation("test-invocation");
      callLevel(logger, level, "test.msg");

      const entry = lastEntryFromSpies(logSpy, warnSpy, errorSpy);
      expect(entry.stack).toBeUndefined();
    },
  );
});

describe("startInvocation resets state and preserves container ID", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("after startInvocation, invocationId changes, track points cleared, containerId stable", () => {
    const logger = new RequestLogger({ containerId: "test1234" });
    logger.startInvocation("first-invocation");
    logger.trackPoint("old.point");
    logger.track("before.reset");

    const firstEntry = lastEntryFromSpies(logSpy, warnSpy, errorSpy);
    expect(firstEntry.invocationId).toBe("first-invocation");

    logger.startInvocation("second-invocation");
    logSpy.mockClear();
    warnSpy.mockClear();
    errorSpy.mockClear();
    logger.track("after.reset");

    const secondEntry = lastEntryFromSpies(logSpy, warnSpy, errorSpy);
    expect(secondEntry.invocationId).toBe("second-invocation");
    expect(secondEntry.invocationId).not.toBe(firstEntry.invocationId);
    expect(secondEntry.trackPoints).toBeUndefined();
    expect(secondEntry.containerId).toBe("test1234");
  });
});

describe("Recursive secret redaction", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const redactionCases = [
    { label: "long secret key — preserves first 8 chars", key: "clientSecret", value: "abcdefghijklmnop", expected: "abcdefgh[REDACTED]" },
    { label: "short secret key — fully redacted", key: "clientSecret", value: "short", expected: "[REDACTED]" },
    { label: "signature key — preserves first 8 chars", key: "webhookSignature", value: "123456789abcdef", expected: "12345678[REDACTED]" },
    { label: "authorization key — preserves first 8 chars", key: "authorization", value: "Bearer xyztoken123", expected: "Bearer x[REDACTED]" },
    { label: "Authorization (capitalized) — preserves first 8 chars", key: "Authorization", value: "Bearer xyztoken123", expected: "Bearer x[REDACTED]" },
    { label: "short authorization — fully redacted", key: "authorization", value: "short", expected: "[REDACTED]" },
  ];

  it.each(redactionCases)("$label", ({ key, value, expected }) => {
    const logger = new RequestLogger({ containerId: "test1234" });
    logger.startInvocation("test-invocation");
    logger.info("test.redaction", { [key]: value });

    const entry = lastEntryFromSpies(logSpy, warnSpy, errorSpy);
    expect(entry[key]).toBe(expected);
  });

  it("nested secret fields are redacted recursively", () => {
    const logger = new RequestLogger({ containerId: "test1234" });
    logger.startInvocation("test-invocation");
    logger.info("test.nested", { outer: { inner: { apiSecret: "longvalue123456" } } });

    const entry = lastEntryFromSpies(logSpy, warnSpy, errorSpy);
    expect((entry.outer as Record<string, unknown> & { inner: { apiSecret: string } }).inner.apiSecret).toBe("longvalu[REDACTED]");
  });
});

describe("Code field promotion and omission", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("string code in context is promoted to top-level field", () => {
    const logger = new RequestLogger({ containerId: "test1234" });
    logger.startInvocation("test-invocation");
    callLevel(logger, "info", "test.msg", { code: "auth.token_expired", extra: "data" });

    const entry = lastEntryFromSpies(logSpy, warnSpy, errorSpy);
    expect(entry.code).toBe("auth.token_expired");
  });

  it("code appears exactly once in serialized output", () => {
    const logger = new RequestLogger({ containerId: "test1234" });
    logger.startInvocation("test-invocation");
    callLevel(logger, "warn", "test.msg", { code: "db.connection_failed" });

    const entry = lastEntryFromSpies(logSpy, warnSpy, errorSpy);
    // code is promoted to top-level and removed from context spread — verify it exists once
    expect(entry.code).toBe("db.connection_failed");
    // Verify by serializing: code key should appear exactly once
    const serialized = JSON.stringify(entry);
    const codeKeyMatches = serialized.match(/"code"\s*:/g);
    expect(codeKeyMatches).not.toBeNull();
    expect(codeKeyMatches!.length).toBe(1);
  });

  const nonStringCases = [
    { label: "numeric code", code: 42 },
    { label: "boolean code", code: true },
    { label: "null code", code: null },
    { label: "object code", code: { nested: true } },
  ];

  it.each(nonStringCases)("$label is not promoted to top-level string", ({ code }) => {
    const logger = new RequestLogger({ containerId: "test1234" });
    logger.startInvocation("test-invocation");
    callLevel(logger, "info", "test.msg", { code } as Record<string, unknown>);

    const entry = lastEntryFromSpies(logSpy, warnSpy, errorSpy);
    if ("code" in entry) {
      expect(typeof entry.code).not.toBe("string");
    }
  });

  it("missing code in context results in no code field", () => {
    const logger = new RequestLogger({ containerId: "test1234" });
    logger.startInvocation("test-invocation");
    callLevel(logger, "info", "test.msg", { other: "data" });

    const entry = lastEntryFromSpies(logSpy, warnSpy, errorSpy);
    expect(entry).not.toHaveProperty("code");
  });
});

describe("Payload truncation guard", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("entries exceeding 262,144 bytes are truncated with _truncated flag and a WARN entry", () => {
    const logger = new RequestLogger({ containerId: "test1234" });
    logger.startInvocation("test-invocation");
    const largeValue = "x".repeat(270_000);
    logger.info("test.large.payload", { data: largeValue });

    // Warning is emitted via console.warn
    expect(warnSpy.mock.calls.length).toBe(1);
    const warningEntry = warnSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(warningEntry.level).toBe("WARN");
    expect(warningEntry.title).toBe("logger.payload_truncated");
    expect(warningEntry.originalTitle).toBe("test.large.payload");
    expect(warningEntry.originalSizeBytes).toBeGreaterThan(262_144);

    // Truncated entry emitted via console.log (since original level=info)
    expect(logSpy.mock.calls.length).toBe(1);
    const truncatedEntry = logSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(truncatedEntry._truncated).toBe(true);
    expect(truncatedEntry.level).toBe("INFO");
    expect(truncatedEntry.title).toBe("test.large.payload");
  });
});
