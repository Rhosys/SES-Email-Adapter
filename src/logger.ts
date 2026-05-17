import { randomUUID } from "crypto";

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
  startInvocation(invocationId?: string): void;
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

export function redactReplacer(key: string, value: unknown): unknown {
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

  startInvocation(invocationId?: string): void {
    this.invocationId = invocationId ?? randomUUID();
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
      timestamp: new Date().toISOString(),
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

    // Wrap in { message: entry } so the subscription filter receives an object at .message
    let serialized: string;
    try {
      serialized = JSON.stringify({ message: entry }, redactReplacer);
    } catch {
      // Circular reference or other serialization failure
      const fallback: LogEntry = {
        level: level.toUpperCase() as unknown as LogLevel,
        title,
        timestamp: entry.timestamp,
        invocationId: this.invocationId,
        containerId: this.containerId,
        _serializationError: true,
      };
      console.log(JSON.stringify({ message: fallback }));
      return;
    }

    if (Buffer.byteLength(serialized, "utf8") > PAYLOAD_LIMIT) {
      const originalSizeBytes = Buffer.byteLength(serialized, "utf8");

      // Truncate: keep required fields + truncation marker
      const truncated: LogEntry = {
        level: level.toUpperCase() as unknown as LogLevel,
        title,
        timestamp: entry.timestamp,
        invocationId: this.invocationId,
        containerId: this.containerId,
        _truncated: true,
      };
      serialized = JSON.stringify({ message: truncated });

      // Emit a separate warning about the truncation
      const warning: LogEntry = {
        level: "WARN" as unknown as LogLevel,
        title: "logger.payload_truncated",
        timestamp: new Date().toISOString(),
        invocationId: this.invocationId,
        containerId: this.containerId,
        originalTitle: title,
        originalSizeBytes,
      };
      console.log(JSON.stringify({ message: warning }, redactReplacer));
    }

    console.log(serialized);
  }
}
