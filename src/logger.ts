import { randomUUID } from "crypto";

export type LogLevel = "info" | "track" | "warn" | "error" | "critical";

export interface TrackPoint {
  name: string;
  elapsedMs: number;
  data?: Record<string, unknown>;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
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
  startInvocation(): void;
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

    const entry: LogEntry = {
      ...(restContext ?? {}),
      level,
      message,
      ...(code !== undefined ? { code } : {}),
      timestamp: new Date().toISOString(),
      invocationId: this.invocationId,
      containerId: this.containerId,
      ...(includeTrackPoints && this.trackPoints.length > 0 ? { trackPoints: this.trackPoints } : {}),
      ...(includeStack ? { stack: new Error().stack ?? "" } : {}),
    };

    // Re-assign required fields AFTER spread to guarantee context cannot overwrite them
    entry.level = level;
    entry.message = message;
    entry.invocationId = this.invocationId;
    entry.containerId = this.containerId;
    if (code !== undefined) entry.code = code;

    let serialized: string;
    try {
      serialized = JSON.stringify(entry, redactReplacer);
    } catch {
      // Circular reference or other serialization failure
      const fallback: LogEntry = {
        level,
        message,
        timestamp: entry.timestamp,
        invocationId: this.invocationId,
        containerId: this.containerId,
        _serializationError: true,
      };
      console.log(JSON.stringify(fallback));
      return;
    }

    if (Buffer.byteLength(serialized, "utf8") > PAYLOAD_LIMIT) {
      const originalSizeBytes = Buffer.byteLength(serialized, "utf8");

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
        originalSizeBytes,
      };
      console.log(JSON.stringify(warning, redactReplacer));
    }

    console.log(serialized);
  }
}
