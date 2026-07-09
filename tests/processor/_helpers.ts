import { vi } from "vitest";
import { ok } from "../../src/errors.js";
import type { ThreadDatabase } from "../../src/database/thread-database.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import type { ProcessingDatabase } from "../../src/database/processing-database.js";
import type { Account, Alias, Domain, UnknownSenderPolicy } from "../../src/types/index.js";

// ---------------------------------------------------------------------------
// Shared mock factories for processor tests.
// Each returns a partial mock typed to the concrete class, containing only the
// methods the processor calls on that class.
// ---------------------------------------------------------------------------

/**
 * ThreadDatabase mock — thread and signal persistence methods used by the processor.
 */
export function makeThreadDbMock(): ThreadDatabase {
  return {
    getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    saveSignal: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    updateSignalSendStatus: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    updateSignalRetention: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    getThread: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    listSignals: vi.fn().mockReturnValue(Promise.resolve(ok({ items: [] }))),
    findSignalByEmailMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    findThreadByGroupingKey: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    saveThread: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    updateThread: vi.fn().mockReturnValue(Promise.resolve(ok({ id: "arc-mock" }))),
  } as unknown as ThreadDatabase;
}

/**
 * AccountDatabase mock — account, alias, rule, domain, sender, template, and stats
 * methods used by the processor.
 */
export function makeAccountDbMock(accountId = "acct-default", recipientAddress = "user@example.com"): AccountDatabase {
  const saveAlias = vi.fn().mockImplementation((a: Alias) => Promise.resolve(ok(a)));
  // Mirrors AccountDatabase.ensureAlias: resolves to { alias, created }. `created` is false when
  // an existing alias was passed, true when a new one was saved.
  const ensureAlias = vi.fn().mockImplementation(async (accountId: string, address: string, defaultUnknownSenderPolicy: UnknownSenderPolicy, existing?: Alias | null) => {
    if (existing) return ok({ alias: existing, created: false });
    const now = new Date().toISOString();
    const saved = await saveAlias({
      id: address,
      accountId,
      address,
      domain: address.split("@")[1]!,
      alias: address.split("@")[0]!,
      unknownSenderPolicy: defaultUnknownSenderPolicy,
      createdAt: now,
      updatedAt: now,
    });
    return saved.isErr() ? saved : ok({ alias: saved.value, created: true });
  });
  return {
    listEnabledRules: vi.fn().mockReturnValue(Promise.resolve(ok([]))),
    getAccount: vi.fn().mockReturnValue(Promise.resolve(ok({
      retentionDuration: "P3M",
      filtering: null,
      billingPlan: "Paid" as const,
      onboarding: { completed: true },
    }))),
    // Recipient resolution. Default: no alias row, but the recipient's domain is owned by
    // the test account — mirrors the old default processor context where aliasConfig was
    // null and the accountId came from the message. Tests exercising alias-scoped behaviour
    // override getAliasByGlobalAddress (e.g. via mockRecipientAlias).
    getAliasByGlobalAddress: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    getDomainOwner: vi.fn().mockReturnValue(Promise.resolve(ok({
      accountId,
      domain: recipientAddress.split("@")[1]!,
      status: "active",
      receivingSetupComplete: true,
      senderSetupComplete: true,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }))),
    saveAlias,
    ensureAlias,
    getSender: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    saveSender: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    getTemplate: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    getDomainByName: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    listDomains: vi.fn().mockReturnValue(Promise.resolve(ok([]))),
    incrementStatMetric: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    annotateRuleError: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    annotateTemplateError: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    listLabels: vi.fn().mockReturnValue(Promise.resolve(ok([]))),
    upsertSystemRuleStatus: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
  } as unknown as AccountDatabase;
}

/**
 * Wire recipient resolution so processMessage derives `accountId` (with a non-null
 * aliasConfig) for the given alias. Use for tests that exercise alias-scoped behaviour.
 */
export function mockRecipientAlias(accountDb: AccountDatabase, alias: Alias): void {
  vi.mocked(accountDb.getAliasByGlobalAddress).mockReturnValue(Promise.resolve(ok(alias)));
}

/**
 * Wire recipient resolution so processMessage derives `accountId` via the domain-owner
 * fallback (aliasConfig is null — the catch-all path). Mirrors the previous default
 * where the processor account context had `aliasConfig: null`.
 */
export function mockRecipientDomainOwner(accountDb: AccountDatabase, accountId: string, domain = "example.com"): void {
  vi.mocked(accountDb.getDomainOwner).mockReturnValue(Promise.resolve(ok({
    accountId,
    domain,
    status: "active",
    receivingSetupComplete: true,
    senderSetupComplete: true,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  } as Domain)));
}

/**
 * Translates a context-shaped object into the underlying calls the processor now makes:
 * `getAccount` (retention/filtering/billingPlan/onboarding) and
 * `getAliasByGlobalAddress` (aliasConfig). When `aliasConfig` is null, resolution falls
 * through to the domain-owner default wired in `makeAccountDbMock(accountId)`.
 */
export interface CtxLike {
  retentionDuration?: string;
  filtering?: { defaultUnknownSenderPolicy?: UnknownSenderPolicy } | null;
  aliasConfig?: Alias | null;
  billingPlan?: string;
  onboardingCompleted?: boolean;
  /** Accepted but ignored — test-email detection now uses a getDomainByName point-read. */
  registeredDomains?: string[];
  /** Accepted but ignored — the userEmails test-detection clause was removed. */
  userEmails?: string[];
}

export function applyCtx(accountDb: AccountDatabase, ctx: CtxLike, opts?: { once?: boolean }): void {
  const account = ok({
    retentionDuration: ctx.retentionDuration ?? "P3M",
    filtering: ctx.filtering ?? null,
    billingPlan: ctx.billingPlan ?? "Paid",
    onboarding: { completed: ctx.onboardingCompleted ?? true },
  } as unknown as Account);
  const aliasRes = ok(ctx.aliasConfig ?? null);
  if (opts?.once) {
    vi.mocked(accountDb.getAccount).mockReturnValueOnce(Promise.resolve(account));
    vi.mocked(accountDb.getAliasByGlobalAddress).mockReturnValueOnce(Promise.resolve(aliasRes));
  } else {
    vi.mocked(accountDb.getAccount).mockReturnValue(Promise.resolve(account));
    vi.mocked(accountDb.getAliasByGlobalAddress).mockReturnValue(Promise.resolve(aliasRes));
  }
}

/**
 * ProcessingDatabase mock — global reputation tracking used by the processor.
 */
export function makeProcessingDbMock(): ProcessingDatabase {
  return {
    updateGlobalReputation: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
  } as unknown as ProcessingDatabase;
}
