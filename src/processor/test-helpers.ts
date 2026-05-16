/**
 * Shared test helpers for processor tests.
 * Provides mock factories for the ContentSanitizerClient and related dependencies.
 */
import { vi } from "vitest";
import { ok } from "neverthrow";
import type { ContentSanitizerClient } from "./content-sanitizer-client.js";
import type { UserCodeExecutorClient, UserCodeResponse } from "./user-code-client.js";

export function makeContentSanitizer(overrides?: Partial<{ parsed: Record<string, unknown>; urlMapping: Record<string, string> }>): ContentSanitizerClient {
  return {
    invoke: vi.fn().mockReturnValue(Promise.resolve(ok({
      success: true as const,
      parsed: {
        from: { address: "sender@example.com", name: "Sender" },
        to: [{ address: "user@example.com" }],
        cc: [],
        subject: "Test email",
        textBody: "Hello world",
        htmlBody: "<p>Hello world</p>",
        attachments: [],
        headers: { "authentication-results": "spf=pass dkim=pass" },
        sentAt: "2024-01-15T09:00:00Z",
        ...overrides?.parsed,
      },
      urlMapping: overrides?.urlMapping ?? {},
    }))),
  };
}

export function makeUserCodeExecutor(response?: UserCodeResponse): UserCodeExecutorClient {
  const defaultResponse: UserCodeResponse = { success: true, purpose: "rule_condition", result: true };
  return {
    invoke: vi.fn().mockReturnValue(Promise.resolve(response ?? defaultResponse)),
  };
}

/** No-op store stub for annotateRuleError — used when tests don't exercise JS rules */
export const stubAnnotateRuleError = vi.fn().mockReturnValue(Promise.resolve(ok(undefined)));

/** No-op store stub for annotateTemplateError — used when tests don't exercise template functions */
export const stubAnnotateTemplateError = vi.fn().mockReturnValue(Promise.resolve(ok(undefined)));

/** Minimal RuleAnnotationStore mock for tests that don't exercise JS rule paths */
export function makeRuleAnnotationStore() {
  return { annotateRuleError: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };
}

/** Stub S3 client — presign module is mocked at module level so this is never called */
export const stubS3Client = {} as never;

/** Default processor options for the new fields */
export const DEFAULT_PROCESSOR_EXTRAS = {
  userCodeExecutor: { invoke: vi.fn().mockReturnValue(Promise.resolve({ success: true, purpose: "template_function", result: "mock" })) } as UserCodeExecutorClient,
  s3Client: stubS3Client,
  emailBucket: "test-email-bucket",
  contentBucket: "test-content-bucket",
  contentCdnBaseUrl: "https://cdn.example.com",
} as const;
