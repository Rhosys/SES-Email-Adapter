# Design Document: Structured Logging Migration

## Overview

Replace all ad-hoc `console.log/error/warn` calls across the email-catcher backend with a centralized `RequestLogger` class. The logger implements ADR 002's six-level taxonomy, provides per-invocation correlation, records timing track points, redacts secrets, and guards against CloudWatch's payload limit.

The logger is a zero-dependency class (no winston/pino/bunyan) that writes structured JSON to stdout. It's designed for Lambda's execution model: one invocation at a time, warm container reuse, and CloudWatch as the log sink.

## Architecture

```mermaid
graph TD
    subgraph "Lambda Container (cold start)"
        CID[Container_ID generated once]
    end

    subgraph "Per Invocation"
        SI[startInvocation] --> INV[invocationId + startTime]
        INV --> TP[trackPoint calls]
        TP --> LOG[level methods]
        LOG --> SER[serialize with redaction]
        SER --> TRUNC{"> 256KB?"}
        TRUNC -->|No| OUT[console.log JSON line]
        TRUNC -->|Yes| TRUN[truncate + warn]
        TRUN --> OUT
    end

    CID --> LOG
```

**Key design decisions:**

1. **Single `console.log` for all levels** — Lambda captures stdout; using `console.error` causes duplicate entries in some tooling. The `level` field in the JSON drives routing.
2. **Class-based, not functional** — Per-invocation state (invocationId, startTime, trackPoints) is naturally encapsulated in an instance.
3. **Injectable via constructor** — All consumers receive the logger as a required constructor parameter. Modules that were previously standalone functions (domain-health-job, authorization-middleware) are converted to classes to support injection.
4. **No async** — Logging is synchronous. `console.log` is synchronous in Node.js. No promises, no buffering.
5. **No optional logger** — The logger parameter is always required (never `logger?: Logger`). This makes it impossible to accidentally run without logging. The handler wires the singleton into all consumers at startup.

## Components and Interfaces

### RequestLogger Class

```typescript
// src/logger.ts

import { randomUUID } from "crypto";

export type LogLevel = "debug" | "info" | "track" | "warn" | "error" | "critical";

export interface TrackPoint {
  name: string;
  elapsedMs: number;
  data?: Record<string, unknown>;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  invocationId: string;
  containerId: string;
  trackPoints?: TrackPoint[];
  stack?: string;
  _truncated?: boolean;
  [key: string]: unknown;
}

export interface Logger {
  startInvocation(): void;
  trackPoint(name: string, data?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  track(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  critical(message: string, context?: Record<string, unknown>): void;
}

const PAYLOAD_LIMIT = 262_144; // 256KB in bytes

// Generated once per cold start — stable across warm invocations
const CONTAINER_ID = randomUUID().slice(0, 8);

const SECRET_PATTERN = /secret|signature/i;
const AUTH_KEYS = new Set(["authorization", "Authorization"]);
const COGNITO_KEYS = new Set(["cognitoIdentityId", "cognitoIdentityPoolId", "cognitoAuthenticationProvider", "cognitoAuthenticationType"]);

export class RequestLogger implements Logger {
  private invocationId = "";
  private startTime = 0;
  private trackPoints: TrackPoint[] = [];
  private readonly containerId: string;

  constructor(containerId?: string) {
    this.containerId = containerId ?? CONTAINER_ID;
  }

  startInvocation(): void {
    this.invocationId = randomUUID();
    this.startTime = Date.now();
    this.trackPoints = [];
  }

  trackPoint(name: string, data?: Record<string, unknown>): void {
    this.trackPoints.push({
      name,
      elapsedMs: Date.now() - this.startTime,
      ...(data !== undefined ? { data } : {}),
    });
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.emit("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.emit("info", message, context);
  }

  track(message: string, context?: Record<string, unknown>): void {
    this.emit("track", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.emit("warn", message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.emit("error", message, context);
  }

  critical(message: string, context?: Record<string, unknown>): void {
    this.emit("critical", message, context);
  }

  private emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const includeTrackPoints = level === "track" || level === "error" || level === "critical";
    const includeStack = level === "error" || level === "critical";

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      invocationId: this.invocationId,
      containerId: this.containerId,
      ...(includeTrackPoints && this.trackPoints.length > 0 ? { trackPoints: this.trackPoints } : {}),
      ...(includeStack ? { stack: new Error().stack } : {}),
      ...context,
    };

    // Required fields are set before the spread, so if context contains conflicting
    // keys they get overwritten by the spread. We re-assign after to guarantee correctness.
    entry.level = level;
    entry.message = message;
    entry.invocationId = this.invocationId;
    entry.containerId = this.containerId;

    let serialized = JSON.stringify(entry, redactReplacer);

    if (Buffer.byteLength(serialized, "utf8") > PAYLOAD_LIMIT) {
      // Truncate: keep required fields + truncation marker
      const truncated: LogEntry = {
        level,
        message,
        timestamp: entry.timestamp,
        invocationId: this.invocationId,
        containerId: this.containerId,
        _truncated: true,
      };
      serialized = JSON.stringify(truncated);

      // Emit a separate warning about the truncation
      const warning: LogEntry = {
        level: "warn",
        message: "logger.payload_truncated",
        timestamp: new Date().toISOString(),
        invocationId: this.invocationId,
        containerId: this.containerId,
        originalMessage: message,
        originalSizeBytes: Buffer.byteLength(JSON.stringify(entry, redactReplacer), "utf8"),
      };
      console.log(JSON.stringify(warning, redactReplacer));
    }

    console.log(serialized);
  }
}

// ---------------------------------------------------------------------------
// Redaction replacer for JSON.stringify
// ---------------------------------------------------------------------------

function redactReplacer(key: string, value: unknown): unknown {
  if (SECRET_PATTERN.test(key) && typeof value === "string") {
    return value.length > 8 ? value.slice(0, 8) + "[REDACTED]" : "[REDACTED]";
  }
  if (AUTH_KEYS.has(key) && typeof value === "string") {
    return value.length > 8 ? value.slice(0, 8) + "[REDACTED]" : "[REDACTED]";
  }
  if (COGNITO_KEYS.has(key)) return "[REDACTED]";
  return value;
}
```

### Constructor Injection Pattern (all consumers)

Every consumer receives the logger as a **required** constructor parameter — never optional, never defaulting to a new instance:

```typescript
// In SignalProcessor constructor options
interface SignalProcessorOptions {
  // ... existing deps ...
  logger: Logger;  // required — not optional
}

export class SignalProcessor {
  private readonly logger: Logger;

  constructor(opts: SignalProcessorOptions) {
    // ... existing ...
    this.logger = opts.logger;
  }
}
```

For modules that were previously standalone functions (e.g., `domain-health-job.ts`), convert to a class:

```typescript
// Before: standalone exported function
// export async function handler(): Promise<void> { ... }

// After: class with injected dependencies
export class DomainHealthJob {
  constructor(
    private readonly db: AccountDatabase,
    private readonly arcDb: ArcDatabase,
    private readonly logger: Logger,
  ) {}

  async run(): Promise<void> {
    this.logger.startInvocation();
    // ... existing logic using this.logger instead of console ...
  }
}
```

The Lambda handler file (`handler.ts`) instantiates the logger once and passes it to all consumers:

```typescript
// src/handler.ts
const logger = new RequestLogger();

const processor = new SignalProcessor({ ..., logger });
const reindexWorker = new ReindexWorker({ ..., logger });
const domainHealthJob = new DomainHealthJob(db, arcDb, logger);
// etc.
```

### Test Mock Pattern

```typescript
// In test files
import type { Logger } from "../logger.js";

function createMockLogger(): Logger & { calls: Array<{ method: string; message: string; context?: Record<string, unknown> }> } {
  const calls: Array<{ method: string; message: string; context?: Record<string, unknown> }> = [];
  return {
    calls,
    startInvocation() { /* no-op */ },
    trackPoint() { /* no-op */ },
    debug(msg, ctx) { calls.push({ method: "debug", message: msg, context: ctx }); },
    info(msg, ctx) { calls.push({ method: "info", message: msg, context: ctx }); },
    track(msg, ctx) { calls.push({ method: "track", message: msg, context: ctx }); },
    warn(msg, ctx) { calls.push({ method: "warn", message: msg, context: ctx }); },
    error(msg, ctx) { calls.push({ method: "error", message: msg, context: ctx }); },
    critical(msg, ctx) { calls.push({ method: "critical", message: msg, context: ctx }); },
  };
}
```

## Data Models

### LogEntry Structure

Every log entry written to stdout:

```json
{
  "level": "error",
  "message": "processor.signal.failed",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "invocationId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "containerId": "f8a2b1c3",
  "trackPoints": [
    { "name": "parse_mime", "elapsedMs": 45 },
    { "name": "classify", "elapsedMs": 230 },
    { "name": "arc_match", "elapsedMs": 312 }
  ],
  "stack": "Error\n    at RequestLogger.emit (src/logger.ts:85:30)\n    ...",
  "accountId": "acct-123",
  "messageId": "msg-456"
}
```

### Redaction Examples

Input context:
```json
{
  "authorization": "Bearer eyJhbGciOiJSUzI1NiIs...",
  "clientSecret": "sk_live_abc123",
  "nested": { "webhookSignature": "sha256=abc123def456" }
}
```

Output after redaction (first 8 chars preserved):
```json
{
  "authorization": "Bearer e[REDACTED]",
  "clientSecret": "sk_live_[REDACTED]",
  "nested": { "webhookSignature": "sha256=a[REDACTED]" }
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Log entry structural invariant

*For any* log level method call with any message identifier and any context object, the output SHALL be a single valid JSON line containing `level`, `message`, `timestamp` (ISO 8601), `invocationId`, and `containerId` fields, and SHALL be written via `console.log` (never `console.error`).

**Validates: Requirements 1.1, 1.2, 1.3, 2.5, 3.3**

### Property 2: Context merge preserves required fields

*For any* context object — including objects that contain keys named `level`, `message`, `timestamp`, `invocationId`, or `containerId` — the required fields in the output SHALL reflect the logger's internal state, not the context values.

**Validates: Requirements 1.5**

### Property 3: Track points included for track/error/critical levels

*For any* sequence of `trackPoint()` calls followed by a `track()`, `error()`, or `critical()` call, the output SHALL include all recorded track points with their names and non-negative elapsed times. For `debug()`, `info()`, and `warn()` calls, track points SHALL NOT be included.

**Validates: Requirements 2.3, 2.4, 4.2, 4.3**

### Property 4: Error and critical include stack trace

*For any* `error()` or `critical()` call, the output SHALL include a `stack` field containing a non-empty string. For `debug()`, `info()`, `track()`, and `warn()` calls, no `stack` field SHALL be present.

**Validates: Requirements 2.2**

### Property 5: startInvocation resets state and preserves container ID

*For any* sequence of operations — track points recorded, then `startInvocation()` called — subsequent log output SHALL contain a new `invocationId` (different from before), zero track points (old ones cleared), and the same `containerId` as before.

**Validates: Requirements 3.1, 3.2, 3.4**

### Property 6: Recursive secret redaction

*For any* object tree of arbitrary depth containing fields whose keys match `/secret|signature/i` or are `authorization`/`Authorization`, the serialized output SHALL preserve the first 8 characters of the value followed by `[REDACTED]`. For values 8 characters or shorter, the entire value is replaced with `[REDACTED]`. Redaction applies recursively regardless of nesting depth.

**Validates: Requirements 5.1, 5.2, 5.4**

### Property 7: Payload truncation guard

*For any* log entry whose serialized form exceeds 262,144 bytes, the actual output SHALL be within the 262,144 byte limit and SHALL contain `_truncated: true`. Additionally, a separate WARN-level entry SHALL be emitted with the original message identifier and pre-truncation size.

**Validates: Requirements 6.1, 6.2**

### Property 8: Mock injection routes all calls

*For any* mock logger injected via constructor or `setLogger()`, all subsequent log method calls SHALL be routed to the mock and SHALL NOT write to stdout.

**Validates: Requirements 7.3**

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| `startInvocation()` not called before logging | Logger uses empty string for `invocationId` — still emits valid JSON |
| Context contains circular references | `JSON.stringify` throws → catch and emit a fallback entry with `message` and `_serializationError: true` |
| Context contains non-serializable values (BigInt, functions) | Replacer function handles gracefully (converts to string representation) |
| Payload exceeds limit after redaction | Truncation logic runs on the post-redaction serialized form |
| `trackPoint()` called without `startInvocation()` | `elapsedMs` will be negative (Date.now() - 0) — acceptable, signals misuse |

## Testing Strategy

### Property-Based Tests (fast-check)

The logger is a pure-ish function (input → JSON output) making it ideal for property-based testing. Each correctness property maps to a fast-check test with minimum 100 iterations.

**Library**: `fast-check` (already in devDependencies)

**Configuration**: Each test runs 100+ iterations, tagged with the property number.

**Test file**: `src/logger.property.spec.ts`

Tag format: `Feature: structured-logging, Property N: <title>`

### Unit Tests

- Specific redaction patterns (Bearer tokens, cognito objects)
- Edge cases: empty message, undefined context, very deep nesting
- `startInvocation()` lifecycle
- Integration with `SignalProcessor` (logger receives expected calls)

### Static Analysis Test

A test that greps source files (excluding `logger.ts` and test files) for `console.log|error|warn` — fails if any remain after migration. This validates Requirement 8.1.

**Test file**: `src/static-analysis.property.spec.ts` (extend existing file or add a new assertion)

### Migration Verification

Existing property specs (e.g., `processor.side-effect-logging.property.spec.ts`) will be updated to inject a mock logger instead of spying on console. If they still pass, the migration preserved semantics.
