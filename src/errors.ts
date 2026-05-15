import type { Result, ResultAsync } from "neverthrow";
import { ok, err } from "neverthrow";

// --- Standalone error types (no composite unions) ---

export type DbError = { kind: "db_error"; cause: Error };
export type NotFoundError = { kind: "not_found"; resource: string; id: string };
export type InvalidResponseError = { kind: "invalid_response" };
export type ProcessError = { kind: "process_error"; messageId: string };
export type AuthressServiceError = { kind: "authress_service_error"; cause: Error };
export type BedrockError = { kind: "bedrock_error"; modelId: string; cause: Error };
export type AuthError = { kind: "auth_error"; cause: Error };

// --- Constructor helpers ---

export const dbError = (cause: Error): DbError => ({ kind: "db_error", cause });
export const notFoundError = (resource: string, id: string): NotFoundError => ({ kind: "not_found", resource, id });
export const invalidResponseError = (): InvalidResponseError => ({ kind: "invalid_response" });
export const processError = (messageId: string): ProcessError => ({ kind: "process_error", messageId });
export const authressServiceError = (cause: Error): AuthressServiceError => ({ kind: "authress_service_error", cause });
export const bedrockError = (modelId: string, cause: Error): BedrockError => ({ kind: "bedrock_error", modelId, cause });
export const authError = (cause: Error): AuthError => ({ kind: "auth_error", cause });

// Re-export neverthrow primitives for convenience
export { ok, err };
export type { Result, ResultAsync };
