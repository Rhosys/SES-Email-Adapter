import { randomUUID } from "crypto";
import stringify from "json-stringify-safe";
import { DateTime } from "luxon";

// TRACK sits between WARN and ERROR: it always means "investigate," but never urgently.
// WARN = system compensated, alert only if volume crosses a threshold.
// TRACK = worth a human looking at eventually (batched daily); no alerting on its own.
// ERROR = this specific operation failed, needs attention now.
export type LogLevel = "info" | "warn" | "track" | "error" | "critical";

export interface TrackPoint {
  name: string;
  elapsedMs: number;
  data?: Record<string, unknown>;
}

export interface LogEntry {
  level: LogLevel;
  title: string;
  code?: string;
  timestamp: string;
  invocationId?: string;
  containerId: string;
  trackPoints?: TrackPoint[];
  stack?: string;
  _truncated?: boolean;
  [key: string]: unknown;
}

export interface Logger {
  startInvocation(invocationId: string): void;
  getInvocationId(): string;
  // Cheap and side-effect-free — call unconditionally at every meaningful step of a
  // pipeline, not just on the success path. Never gate it behind a conditional; the
  // resulting timeline is what makes debugging a slow or failed invocation tractable.
  trackPoint(name: string, data?: Record<string, unknown>): void;
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
const COGNITO_KEYS = new Set([
  "cognitoIdentityId",
  "cognitoIdentityPoolId",
  "cognitoAuthenticationProvider",
  "cognitoAuthenticationType",
]);

function redactValue(key: string, value: unknown): unknown {
  if (COGNITO_KEYS.has(key)) return "[REDACTED]";
  if (SECRET_PATTERN.test(key) && typeof value === "string") {
    return value.length > 8 ? value.slice(0, 8) + "[REDACTED]" : "[REDACTED]";
  }
  if (AUTH_KEYS.has(key) && typeof value === "string") {
    return value.length > 8 ? value.slice(0, 8) + "[REDACTED]" : "[REDACTED]";
  }
  if (key === "embeddings" && value && typeof value === "object") return "<Embeddings-Map-Array>";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
  return value;
}

// Error instances carry message/name/stack as non-enumerable properties, so a plain
// Object.entries()/JSON.stringify() walk silently drops them to `{}`. This matters
// beyond the top-level context fields serializeErrors() already covers: our error
// types (DbError, ProcessorError, etc.) nest the underlying Error under a `cause`
// property, and redact() recurses arbitrarily deep into those — so every level must
// flatten an Error to a plain object before it gets recursed into or stringified.
function errorToPlain(e: Error): Record<string, unknown> {
  if (e instanceof AggregateError) {
    return {
      ...e,
      message: e.message,
      name: e.name,
      stack: e.stack,
      errors: e.errors.map((sub: unknown) => (sub instanceof Error ? errorToPlain(sub) : sub)),
    };
  }
  return { ...e, message: e.message, name: e.name, stack: e.stack };
}

function redact(obj: Record<string, unknown>, seen = new WeakSet()): Record<string, unknown> {
  if (seen.has(obj)) return { _circular: true };
  seen.add(obj);
  const result: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(obj)) {
    const raw = rawValue instanceof Error ? errorToPlain(rawValue) : rawValue;
    const value = redactValue(key, raw);
    if (value !== raw) {
      result[key] = value;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redact(value as Record<string, unknown>, seen);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        const plainItem = item instanceof Error ? errorToPlain(item) : item;
        return plainItem && typeof plainItem === "object" && !Array.isArray(plainItem)
          ? redact(plainItem as Record<string, unknown>, seen)
          : redactValue("", plainItem);
      });
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** @deprecated Use redact() for object trees. Kept for JSON.stringify compatibility in edge cases. */
export function redactReplacer(key: string, value: unknown): unknown {
  return redactValue(key, value);
}

function serializeErrors(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value instanceof AggregateError) {
      result[key] = {
        ...value,
        message: value.message,
        name: value.name,
        stack: value.stack,
        errors: value.errors.map((e: unknown) =>
          e instanceof Error ? { ...e, message: e.message, name: e.name, stack: e.stack } : e,
        ),
      };
    } else if (value instanceof Error) {
      result[key] = { ...value, message: value.message, name: value.name, stack: value.stack };
    } else {
      result[key] = value;
    }
  }
  return result;
}

export class RequestLogger implements Logger {
  private invocationId = "";
  private startTime = 0;
  private trackPoints: TrackPoint[] = [];
  private readonly containerId: string;
  private readonly serialize: boolean;

  constructor({ containerId, serialize }: { containerId?: string; serialize?: boolean } = {}) {
    this.containerId = containerId ?? CONTAINER_ID;
    this.serialize = serialize ?? false;
  }

  startInvocation(invocationId: string): void {
    this.invocationId = invocationId;
    this.startTime = Date.now();
    this.trackPoints = [];
  }

  getInvocationId(): string {
    return this.invocationId;
  }

  trackPoint(name: string, data?: Record<string, unknown>): void {
    this.trackPoints.push({
      name,
      elapsedMs: Date.now() - this.startTime,
      ...(data !== undefined ? { data } : {}),
    });
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

  private emit(level: LogLevel, title: string, context?: Record<string, unknown>): void {
    const includeTrackPoints = level === "track" || level === "error" || level === "critical";
    const includeStack = level === "error" || level === "critical";
    // error/critical logs omit invocationId: it's unique per invocation, so including it
    // defeats log-aggregation tools that group errors by identical fields.
    const includeInvocationId = level !== "error" && level !== "critical";

    // Extract code from context if present
    let code: string | undefined;
    let restContext: Record<string, unknown> | undefined;
    if (context && "code" in context && typeof context.code === "string") {
      const { code: extractedCode, ...rest } = context;
      code = extractedCode;
      restContext = Object.keys(rest).length > 0 ? rest : undefined;
    } else {
      restContext = context;
    }

    // Serialize Error instances in context so they don't become {}
    const serializedContext = restContext ? serializeErrors(restContext) : undefined;

    const entry: LogEntry = {
      ...(serializedContext ?? {}),
      level: level.toUpperCase() as unknown as LogLevel,
      title,
      ...(code !== undefined ? { code } : {}),
      timestamp: DateTime.utc().toISO()!,
      ...(includeInvocationId ? { invocationId: this.invocationId } : {}),
      containerId: this.containerId,
      ...(includeTrackPoints && this.trackPoints.length > 0 ? { trackPoints: this.trackPoints } : {}),
      ...(includeStack ? { stack: new Error().stack ?? "" } : {}),
    };

    // Re-assign required fields AFTER spread to guarantee context cannot overwrite them
    entry.level = level.toUpperCase() as unknown as LogLevel;
    entry.title = title;
    if (includeInvocationId) {
      entry.invocationId = this.invocationId;
    } else {
      delete entry.invocationId;
    }
    entry.containerId = this.containerId;
    if (code !== undefined) entry.code = code;

    // Emit the entry directly — Lambda JSON log format serializes objects natively
    let redacted: Record<string, unknown>;
    try {
      redacted = redact(entry as unknown as Record<string, unknown>);
    } catch {
      // Circular reference or other failure
      const fallbackEmitter = level === "error" || level === "critical" ? console.error : level === "warn" ? console.warn : console.log;
      const fallbackEntry = {
        level: level.toUpperCase(),
        title,
        timestamp: entry.timestamp,
        invocationId: this.invocationId,
        containerId: this.containerId,
        _serializationError: true,
      };
      fallbackEmitter(this.serialize ? stringify(fallbackEntry) : fallbackEntry);
      return;
    }

    const byteSize = Buffer.byteLength(JSON.stringify(redacted), "utf8");
    if (byteSize > PAYLOAD_LIMIT) {
      // Emit a separate warning about the truncation
      const truncationWarning = {
        level: "WARN",
        title: "logger.payload_truncated",
        timestamp: DateTime.utc().toISO()!,
        invocationId: this.invocationId,
        containerId: this.containerId,
        originalTitle: title,
        originalSizeBytes: byteSize,
      };
      console.warn(this.serialize ? stringify(truncationWarning) : truncationWarning);

      // Truncate: keep required fields + truncation marker
      const truncatedEmitter = level === "error" || level === "critical" ? console.error : level === "warn" ? console.warn : console.log;
      const truncatedEntry = {
        level: level.toUpperCase(),
        title,
        timestamp: entry.timestamp,
        invocationId: this.invocationId,
        containerId: this.containerId,
        _truncated: true,
      };
      truncatedEmitter(this.serialize ? stringify(truncatedEntry) : truncatedEntry);
      return;
    }

    const emit = level === "error" || level === "critical" ? console.error : level === "warn" ? console.warn : console.log;
    emit(this.serialize ? stringify(redacted) : redacted);
  }
}
