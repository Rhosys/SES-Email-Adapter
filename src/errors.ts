import type { Result } from "neverthrow";
import { ok, err } from "neverthrow";

// --- Standalone error types (no composite unions) ---

export type DbError = { kind: "db_error"; message: string; cause: Error; schemaMismatch?: boolean };
export type NotFoundError = { kind: "not_found"; resource: string; id: string };
export type InvalidResponseError = { kind: "invalid_response" };
export type AuthressServiceError = { kind: "authress_service_error"; message: string; cause: Error };
export type BedrockError = { kind: "bedrock_error"; message: string; modelId: string; cause: Error };
export type AuthError = { kind: "auth_error"; message: string; cause: Error };
export type ProcessorError = { kind: "processor_error"; message: string; cause: Error };
export type TransientSesError = { kind: "transient_ses_error"; errorName: string; httpStatus: number; cause: unknown };
export type InvalidArgumentError = { kind: "invalid_argument"; argument: string; message: string };

export type ReindexSegmentProcessingError = { kind: "reindex_segment_processing_error"; segment: number; failureCount: number; failures: Array<{ signalId: string; cause: unknown }> };

// --- Constructor helpers ---

function toError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  if (typeof cause === "string") return new Error(cause);
  return new Error("");
}

// A schema mismatch is a Postgres "missing object" error — the code expects a
// column/table/type the applied migrations never created (i.e. schema.ts drifted
// ahead of src/migrations, or a migration failed to apply). These are NOT
// transient: retrying can never fix them, so they must be reported distinctly
// from cluster-health/connectivity errors. The RDS Data API surfaces these only
// as message strings (no structured SQLSTATE), so we match on the message text.
const SCHEMA_MISMATCH_PATTERNS = [
  /column .* does not exist/i,
  /relation .* does not exist/i,
  /type .* does not exist/i,
  /(undefined|unknown) (column|table)/i,
];

/** True when the error looks like a schema/migration mismatch (missing column/table/type). */
export function isSchemaMismatchError(message: string): boolean {
  return SCHEMA_MISMATCH_PATTERNS.some((pattern) => pattern.test(message));
}

export const dbError = (cause: unknown): DbError => {
  const error = toError(cause);
  const result: DbError = { kind: "db_error", message: error.message, cause: error };
  if (isSchemaMismatchError(error.message)) result.schemaMismatch = true;
  return result;
};
export const notFoundError = (resource: string, id: string): NotFoundError => ({ kind: "not_found", resource, id });
export const invalidResponseError = (): InvalidResponseError => ({ kind: "invalid_response" });
export const authressServiceError = (cause: unknown): AuthressServiceError => {
  const error = toError(cause);
  return { kind: "authress_service_error", message: error.message, cause: error };
};
export const bedrockError = (modelId: string, cause: unknown): BedrockError => {
  const error = toError(cause);
  return { kind: "bedrock_error", message: error.message, modelId, cause: error };
};
export const authError = (cause: unknown): AuthError => {
  const error = toError(cause);
  return { kind: "auth_error", message: error.message, cause: error };
};
export const processorError = (cause: unknown): ProcessorError => {
  const error = toError(cause);
  return { kind: "processor_error", message: error.message, cause: error };
};
export const reindexSegmentProcessingError = (segment: number, failures: Array<{ signalId: string; cause: unknown }>): ReindexSegmentProcessingError => ({ kind: "reindex_segment_processing_error", segment, failureCount: failures.length, failures });
export const invalidArgumentError = (argument: string, message: string): InvalidArgumentError => ({ kind: "invalid_argument", argument, message });

// Re-export neverthrow primitives for convenience
export { ok, err };
export type { Result };
