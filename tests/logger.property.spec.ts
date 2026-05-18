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

function lastEntry(consoleSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const calls = consoleSpy.mock.calls;
  const lastCall = calls[calls.length - 1]!;
  const parsed = JSON.parse(lastCall[0] as string);
  return parsed;
}

describe("Log entry structural invariant", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it.each(ALL_LEVELS.map((level) => ({ level })))(
    "level=$level produces valid JSON with required fields",
    ({ level }) => {
      const logger = new RequestLogger("test1234");
      logger.startInvocation();
      callLevel(logger, level, "test.msg", { extra: "data" });

      const entry = lastEntry(consoleSpy);
      expect(entry.level).toBe(level.toUpperCase());
      expect(entry.title).toBe("test.msg");
      expect(entry.containerId).toBe("test1234");
      expect(entry.invocationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Date(entry.timestamp as string).toISOString()).toBe(entry.timestamp);
    },
  );
});

describe("Context merge preserves required fields", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("context keys matching required field names cannot overwrite logger state", () => {
    const logger = new RequestLogger("test1234");
    logger.startInvocation();

    callLevel(logger, "info", "real.message", {
      level: "FAKE",
      message: "FAKE",
      timestamp: "FAKE",
      invocationId: "FAKE",
      containerId: "FAKE",
    });

    const entry = lastEntry(consoleSpy);
    expect(entry.level).toBe("INFO");
    expect(entry.title).toBe("real.message");
    expect(entry.containerId).toBe("test1234");
    expect(entry.invocationId).not.toBe("FAKE");
    expect(entry.invocationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("Track points included for track/error/critical levels", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it.each(TRACK_POINT_LEVELS.map((level) => ({ level })))(
    "level=$level includes trackPoints array",
    ({ level }) => {
      const logger = new RequestLogger("test1234");
      logger.startInvocation();
      logger.trackPoint("step.one");
      logger.trackPoint("step.two");
      callLevel(logger, level, "test.msg");

      const entry = lastEntry(consoleSpy);
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
      const logger = new RequestLogger("test1234");
      logger.startInvocation();
      logger.trackPoint("step.one");
      callLevel(logger, level, "test.msg");

      const entry = lastEntry(consoleSpy);
      expect(entry.trackPoints).toBeUndefined();
    },
  );
});

describe("Error and critical include stack trace", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it.each(STACK_LEVELS.map((level) => ({ level })))(
    "level=$level has non-empty stack field",
    ({ level }) => {
      const logger = new RequestLogger("test1234");
      logger.startInvocation();
      callLevel(logger, level, "test.msg");

      const entry = lastEntry(consoleSpy);
      expect(typeof entry.stack).toBe("string");
      expect((entry.stack as string).length).toBeGreaterThan(0);
    },
  );

  it.each(NO_STACK_LEVELS.map((level) => ({ level })))(
    "level=$level has no stack field",
    ({ level }) => {
      const logger = new RequestLogger("test1234");
      logger.startInvocation();
      callLevel(logger, level, "test.msg");

      const entry = lastEntry(consoleSpy);
      expect(entry.stack).toBeUndefined();
    },
  );
});

describe("startInvocation resets state and preserves container ID", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("after startInvocation, invocationId changes, track points cleared, containerId stable", () => {
    const logger = new RequestLogger("test1234");
    logger.startInvocation();
    logger.trackPoint("old.point");
    logger.track("before.reset");

    const firstEntry = lastEntry(consoleSpy);
    const firstInvocationId = firstEntry.invocationId;

    logger.startInvocation();
    consoleSpy.mockClear();
    logger.track("after.reset");

    const secondEntry = lastEntry(consoleSpy);
    expect(secondEntry.invocationId).not.toBe(firstInvocationId);
    expect(secondEntry.invocationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondEntry.trackPoints).toBeUndefined();
    expect(secondEntry.containerId).toBe("test1234");
  });
});

describe("Recursive secret redaction", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
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
    const logger = new RequestLogger("test1234");
    logger.startInvocation();
    logger.info("test.redaction", { [key]: value });

    const entry = lastEntry(consoleSpy);
    expect(entry[key]).toBe(expected);
  });

  it("nested secret fields are redacted recursively", () => {
    const logger = new RequestLogger("test1234");
    logger.startInvocation();
    logger.info("test.nested", { outer: { inner: { apiSecret: "longvalue123456" } } });

    const entry = lastEntry(consoleSpy);
    expect((entry.outer as Record<string, unknown> & { inner: { apiSecret: string } }).inner.apiSecret).toBe("longvalu[REDACTED]");
  });
});

describe("Code field promotion and omission", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("string code in context is promoted to top-level field", () => {
    const logger = new RequestLogger("test1234");
    logger.startInvocation();
    callLevel(logger, "info", "test.msg", { code: "auth.token_expired", extra: "data" });

    const entry = lastEntry(consoleSpy);
    expect(entry.code).toBe("auth.token_expired");
  });

  it("code appears exactly once in serialized output", () => {
    const logger = new RequestLogger("test1234");
    logger.startInvocation();
    callLevel(logger, "warn", "test.msg", { code: "db.connection_failed" });

    const raw = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1]![0] as string;
    const codeKeyMatches = raw.match(/"code"\s*:/g);
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
    const logger = new RequestLogger("test1234");
    logger.startInvocation();
    callLevel(logger, "info", "test.msg", { code } as Record<string, unknown>);

    const entry = lastEntry(consoleSpy);
    if ("code" in entry) {
      expect(typeof entry.code).not.toBe("string");
    }
  });

  it("missing code in context results in no code field", () => {
    const logger = new RequestLogger("test1234");
    logger.startInvocation();
    callLevel(logger, "info", "test.msg", { other: "data" });

    const entry = lastEntry(consoleSpy);
    expect(entry).not.toHaveProperty("code");
  });
});

describe("Payload truncation guard", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("entries exceeding 262,144 bytes are truncated with _truncated flag and a WARN entry", () => {
    const logger = new RequestLogger("test1234");
    logger.startInvocation();
    const largeValue = "x".repeat(270_000);
    logger.info("test.large.payload", { data: largeValue });

    const calls = consoleSpy.mock.calls;
    expect(calls.length).toBe(2);

    // First call is the warning
    const warningEntry = JSON.parse(calls[0]![0] as string);
    expect(warningEntry.level).toBe("WARN");
    expect(warningEntry.title).toBe("logger.payload_truncated");
    expect(warningEntry.originalTitle).toBe("test.large.payload");
    expect(warningEntry.originalSizeBytes).toBeGreaterThan(262_144);

    // Second call is the truncated entry
    const truncatedEntry = JSON.parse(calls[1]![0] as string);
    expect(truncatedEntry._truncated).toBe(true);
    expect(truncatedEntry.level).toBe("INFO");
    expect(truncatedEntry.title).toBe("test.large.payload");

    const truncatedSize = Buffer.byteLength(calls[1]![0] as string, "utf8");
    expect(truncatedSize).toBeLessThanOrEqual(262_144);
  });
});
