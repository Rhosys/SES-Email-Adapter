import { randomUUID } from "crypto";
import { DateTime } from "luxon";

export type LogLevel = "info" | "track" | "warn" | "error" | "critical";

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
  invocationId: string;
  containerId: string;
  trackPoints?: TrackPoint[];
  stack?: string;
  _truncated?: boolean;
  [key: string]: unknown;
}

export interface Logger {
  startInvocation(invocationId: string): void;
  getInvocationId(): string;
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
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
  return value;
}

function redact(obj: Record<string, unknown>, seen = new WeakSet()): Record<string, unknown> {
  if (seen.has(obj)) return { _circular: true };
  seen.add(obj);
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(obj)) {
    const value = redactValue(key, raw);
    if (value !== raw) {
      result[key] = value;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redact(value as Record<string, unknown>, seen);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? redact(item as Record<string, unknown>, seen)
          : redactValue("", item),
      );
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
    if (value instanceof Error) {
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

  constructor(containerId?: string) {
    this.containerId = containerId ?? CONTAINER_ID;
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
      invocationId: this.invocationId,
      containerId: this.containerId,
      ...(includeTrackPoints && this.trackPoints.length > 0 ? { trackPoints: this.trackPoints } : {}),
      ...(includeStack ? { stack: new Error().stack ?? "" } : {}),
    };

    // Re-assign required fields AFTER spread to guarantee context cannot overwrite them
    entry.level = level.toUpperCase() as unknown as LogLevel;
    entry.title = title;
    entry.invocationId = this.invocationId;
    entry.containerId = this.containerId;
    if (code !== undefined) entry.code = code;

    // Emit the entry directly — Lambda JSON log format serializes objects natively
    let redacted: Record<string, unknown>;
    try {
      redacted = redact(entry as unknown as Record<string, unknown>);
    } catch {
      // Circular reference or other failure
      const fallbackEmitter = level === "error" || level === "critical" ? console.error : level === "warn" ? console.warn : console.log;
      fallbackEmitter({
        level: level.toUpperCase(),
        title,
        timestamp: entry.timestamp,
        invocationId: this.invocationId,
        containerId: this.containerId,
        _serializationError: true,
      });
      return;
    }

    const byteSize = Buffer.byteLength(JSON.stringify(redacted), "utf8");
    if (byteSize > PAYLOAD_LIMIT) {
      // Emit a separate warning about the truncation
      console.warn({
        level: "WARN",
        title: "logger.payload_truncated",
        timestamp: DateTime.utc().toISO()!,
        invocationId: this.invocationId,
        containerId: this.containerId,
        originalTitle: title,
        originalSizeBytes: byteSize,
      });

      // Truncate: keep required fields + truncation marker
      const truncatedEmitter = level === "error" || level === "critical" ? console.error : level === "warn" ? console.warn : console.log;
      truncatedEmitter({
        level: level.toUpperCase(),
        title,
        timestamp: entry.timestamp,
        invocationId: this.invocationId,
        containerId: this.containerId,
        _truncated: true,
      });
      return;
    }

    const emit = level === "error" || level === "critical" ? console.error : level === "warn" ? console.warn : console.log;
    emit(redacted);
  }
}
