import type { Result, ResultAsync } from "neverthrow";
import { ok, err } from "neverthrow";

// --- Standalone error types (no composite unions) ---

export type DbError = { kind: "db_error"; cause: Error };
export type NotFoundError = { kind: "not_found"; resource: string; id: string };
export type InvalidResponseError = { kind: "invalid_response" };
export type ProcessError = { kind: "process_error"; messageId: string };

// --- Constructor helpers ---

export const dbError = (cause: Error): DbError => ({ kind: "db_error", cause });
export const notFoundError = (resource: string, id: string): NotFoundError => ({ kind: "not_found", resource, id });
export const invalidResponseError = (): InvalidResponseError => ({ kind: "invalid_response" });
export const processError = (messageId: string): ProcessError => ({ kind: "process_error", messageId });

// Re-export neverthrow primitives for convenience
export { ok, err };
export type { Result, ResultAsync };
