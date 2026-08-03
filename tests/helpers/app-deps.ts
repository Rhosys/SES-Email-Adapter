import { ok } from "../../src/errors.js";
import { BillingHandler } from "../../src/billing/billing-handler.js";
import type { AppDeps } from "../../src/api/app.js";

/** Provides sensible no-op defaults for all AppDeps fields that tests don't exercise. */
export function makeAppDeps(overrides: Partial<AppDeps>): AppDeps {
  return {
    threadDb: {} as never,
    resourceDb: {} as never,
    accountDb: {} as never,
    auditDb: {} as never,
    auth: {} as never,
    access: { removeUser: async () => ok(undefined), checkAccess: async () => {}, createInvite: async () => ok({ inviteId: "mock" }) } as never,
    logger: {} as never,
    forwardingService: { sendVerification: async () => ok(undefined), verifyWebhook: async () => ok(undefined), forward: async () => ok(undefined) } as never,
    jobDispatcher: { dispatch: async () => ok({ jobId: "j", targetRegistryId: "r", modelId: "m", segmentCount: 1, startedAt: "2025-01-01T00:00:00Z" }) } as never,
    healthCheckValidator: { validateLatest: async () => ({ status: "pass", checkedDate: "2025-01-01", checkedAt: "2025-01-01T00:00:00.000Z", checks: [], rawChecks: null }) } as never,
    draftSendDispatcher: { dispatch: async () => ok(undefined) } as never,
    accountCreationStarter: { start: async () => {} },
    appBaseUrl: "http://localhost",
    contentCdnBaseUrl: "https://cdn.test",
    astValidator: { validateAstBatch: async () => ({ success: true, purpose: "validate_ast_batch", results: [] }) } as never,
    billingHandler: new BillingHandler(),
    emailService: { send: async () => ok({ messageId: "stub" }), sendRaw: async () => {} } as never,
    domainIdentityService: { register: async () => ok(undefined), deregister: async () => ok(undefined) },
    rsvpComposer: (async () => ok(undefined)) as never,
    postApprovalCalendarDeps: { threadDb: {} as never, accountDb: {} as never, emailService: {} as never, serviceDomain: "platform.email.rhosys.cloud" } as never,
    schedulerClient: { scheduleMessage: async () => ok(undefined), deleteSchedule: async () => ok(undefined) } as never,
    emailContentStore: { getSignedUrl: async () => "https://signed.test/key", getRawEmailUrl: async () => "https://signed.test/key" } as never,
    triggerDigest: async () => {},
    embeddingGenerator: {} as never,
    threadMatcher: {} as never,
    unsubscribeTokenGenerator: { generate: async () => "tok", verify: async () => ok({ accountId: "acct", emailType: "digest" as const }) } as never,
    adapters: {},
    encryptionManager: { encrypt: () => "encrypted", decrypt: () => "decrypted" } as never,
    getProviderToken: async () => "",
    signalQueue: { send: async () => ok(undefined), sendBatch: async () => ok(undefined) } as never,
    ...overrides,
  } as AppDeps;
}
