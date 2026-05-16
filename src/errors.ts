import type { Result } from "neverthrow";
import { ok, err } from "neverthrow";

// --- Standalone error types (no composite unions) ---

export type DbError = { kind: "db_error"; cause: unknown };
export type NotFoundError = { kind: "not_found"; resource: string; id: string };
export type InvalidResponseError = { kind: "invalid_response" };
export type AuthressServiceError = { kind: "authress_service_error"; cause: unknown };
export type BedrockError = { kind: "bedrock_error"; modelId: string; cause: unknown };
export type AuthError = { kind: "auth_error"; cause: unknown };

export type ReindexSegmentProcessingError = { kind: "reindex_segment_processing_error"; segment: number; failureCount: number; failures: Array<{ signalId: string; reason: string }> };

// --- Constructor helpers ---

export const dbError = (cause: unknown): DbError => ({ kind: "db_error", cause });
export const notFoundError = (resource: string, id: string): NotFoundError => ({ kind: "not_found", resource, id });
export const invalidResponseError = (): InvalidResponseError => ({ kind: "invalid_response" });
export const authressServiceError = (cause: unknown): AuthressServiceError => ({ kind: "authress_service_error", cause });
export const bedrockError = (modelId: string, cause: unknown): BedrockError => ({ kind: "bedrock_error", modelId, cause });
export const authError = (cause: unknown): AuthError => ({ kind: "auth_error", cause });
export const reindexSegmentProcessingError = (segment: number, failures: Array<{ signalId: string; reason: string }>): ReindexSegmentProcessingError => ({ kind: "reindex_segment_processing_error", segment, failureCount: failures.length, failures });

// Re-export neverthrow primitives for convenience
export { ok, err };
export type { Result };
