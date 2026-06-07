import { ok } from "../../src/errors.js";
import { BillingHandler } from "../../src/billing/billing-handler.js";
import type { AppDeps } from "../../src/api/app.js";

type DeepPartial<T> = { [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P] };

/** Provides sensible no-op defaults for all AppDeps fields that tests don't exercise. */
export function makeAppDeps(overrides: DeepPartial<AppDeps>): AppDeps {
  return {
    arcDb: {} as never,
    accountDb: {} as never,
    auditDb: {} as never,
    auth: {} as never,
    access: { removeUser: async () => ok(undefined), checkAccess: async () => {}, createInvite: async () => ok({ inviteId: "mock" }) } as never,
    logger: {} as never,
    verificationMailer: { sendForwardVerification: async () => ok(undefined) } as never,
    jobDispatcher: { dispatchReindex: async () => {}, dispatchSegment: async () => {} } as never,
    draftSendDispatcher: { dispatch: async () => ok(undefined) } as never,
    accountCreationStarter: { start: async () => {} },
    appBaseUrl: "http://localhost",
    contentCdnBaseUrl: "https://cdn.test",
    astValidator: { validateAstBatch: async () => ({ success: true, purpose: "validate_ast_batch", results: [] }) } as never,
    billingHandler: new BillingHandler(),
    emailService: { send: async () => ok({ messageId: "stub" }), sendRaw: async () => {} } as never,
    domainIdentityService: { register: async () => ok(undefined), deregister: async () => ok(undefined), tenantNameForAccount: (a: string) => a },
    rsvpComposer: (async () => ok(undefined)) as never,
    postApprovalCalendarDeps: { accountDb: {} as never, emailService: {} as never, serviceDomain: "platform.email.rhosys.cloud" } as never,
    schedulerClient: { scheduleMessage: async () => ok(undefined), deleteSchedule: async () => ok(undefined) } as never,
    ...overrides,
  } as AppDeps;
}
