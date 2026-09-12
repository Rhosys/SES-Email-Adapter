import { ok } from "../../src/errors.js";
import { BillingHandler } from "../../src/billing/billing-handler.js";
import type { AppDeps } from "../../src/api/app.js";
import type { ProviderAdapter } from "../../src/external-exchanges/provider-adapter.js";
import { EMX_PLATFORMS, type EmxPlatform } from "../../src/types/index.js";

// Vitest-free default adapters. `app-deps.ts` is imported by the tsx-executed integration
// harness (tests/integration/harness.ts), which runs outside the vitest runner — so this file
// must never pull in `vitest`. Tests that assert on adapter calls pass their own spy-backed
// adapters via `makeMockAdapters` (see provider-adapters.ts); these no-op stubs only fill the
// slots those tests don't exercise.
function makeNoopAdapters(): Record<EmxPlatform, ProviderAdapter> {
  const noop = (): ProviderAdapter => ({
    activate: async () => ok({}) as never,
    renew: async () => ok(undefined) as never,
    deactivate: async () => ok(undefined) as never,
    fetchMessage: async () => ok({}) as never,
    sendMessage: async () => ok({}) as never,
  });
  return Object.fromEntries(EMX_PLATFORMS.map((platform) => [platform, noop()])) as Record<EmxPlatform, ProviderAdapter>;
}

/** Provides sensible no-op defaults for all AppDeps fields that tests don't exercise. */
export function makeAppDeps(overrides: Partial<AppDeps>): AppDeps {
  return {
    threadDb: {} as never,
    resourceDb: {} as never,
    accountDb: {} as never,
    exchangesDb: {} as never,
    auditDb: {} as never,
    auth: {} as never,
    access: { removeUser: async () => ok(undefined), checkAccess: async () => {}, createInvite: async () => ok({ inviteId: "mock" }) } as never,
    logger: {} as never,
    forwardingService: { sendVerification: async () => ok(undefined), forward: async () => ok(undefined) } as never,
    jobDispatcher: { dispatch: async () => ok({ jobId: "j", targetRegistryId: "r", modelId: "m", segmentCount: 1, startedAt: "2025-01-01T00:00:00Z" }) } as never,
    healthCheckValidator: { validateLatest: async () => ({ status: "pass", checkedDate: "2025-01-01", checkedAt: "2025-01-01T00:00:00.000Z", checks: [], rawChecks: null }) } as never,
    draftSendDispatcher: { dispatch: async () => ok(undefined) } as never,
    accountCreationStarter: { start: async () => {} },
    contentCdnBaseUrl: "https://cdn.test",
    astValidator: { validateAstBatch: async () => ({ success: true, purpose: "validate_ast_batch", results: [] }) } as never,
    billingHandler: new BillingHandler(),
    emailService: { send: async () => ok({ messageId: "stub" }), sendRaw: async () => {} } as never,
    domainIdentityService: { register: async () => ok(undefined), deregister: async () => ok(undefined) },
    calendarForwarder: { forwardInvite: async () => ok(undefined), sendReply: async () => ok({ messageId: "stub" }) } as never,
    postApprovalCalendarDeps: { threadDb: {} as never, accountDb: {} as never, emailService: {} as never, serviceDomain: "platform.email.rhosys.cloud" } as never,
    schedulerClient: { scheduleMessage: async () => ok(undefined), deleteSchedule: async () => ok(undefined) } as never,
    emailContentStore: { createReadUrl: async () => "https://signed.test/key", getRawEmailUrl: async () => "https://signed.test/key" } as never,
    triggerDigest: async () => {},
    embeddingGenerator: {} as never,
    threadMatcher: {} as never,
    unsubscribeTokenGenerator: { generate: async () => "tok", verify: async () => ok({ accountId: "acct", emailType: "digest" as const }) } as never,
    adapters: makeNoopAdapters(),
    encryptionManager: { encrypt: () => "encrypted", decrypt: () => "decrypted" } as never,
    signalQueue: { send: async () => ok(undefined), sendBatch: async () => ok(undefined) } as never,
    gmailProvider: { handle: async () => new Response("{}", { status: 200 }) } as never,
    outlookProvider: { handle: async () => new Response("{}", { status: 200 }) } as never,
    jmapAdapter: { handleWebhook: async () => ok(undefined) } as never,
    ...overrides,
  } as AppDeps;
}
