import { vi } from "vitest";
import { ok } from "../../src/errors.js";
import type { ArcDatabase } from "../../src/database/arc-database.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import type { ProcessingDatabase } from "../../src/database/processing-database.js";
import type { Alias, UnknownSenderPolicy } from "../../src/types/index.js";

// ---------------------------------------------------------------------------
// Shared mock factories for processor tests.
// Each returns a partial mock typed to the concrete class, containing only the
// methods the processor calls on that class.
// ---------------------------------------------------------------------------

/**
 * ArcDatabase mock — arc and signal persistence methods used by the processor.
 */
export function makeArcDbMock(): ArcDatabase {
  return {
    getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    saveSignal: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    updateSignalSendStatus: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    updateSignalRetention: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    getArc: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    findSignalByEmailMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    fastFindArcByAlternativeLookupKey: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    saveArc: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    updateArc: vi.fn().mockReturnValue(Promise.resolve(ok({ id: "arc-mock" }))),
  } as unknown as ArcDatabase;
}

/**
 * AccountDatabase mock — account, alias, rule, domain, sender, template, and stats
 * methods used by the processor.
 */
export function makeAccountDbMock(): AccountDatabase {
  const saveAlias = vi.fn().mockImplementation((a: Alias) => Promise.resolve(ok(a)));
  const ensureAlias = vi.fn().mockImplementation((accountId: string, address: string, defaultUnknownSenderPolicy: UnknownSenderPolicy, existing?: Alias | null) => {
    if (existing) return Promise.resolve(ok(existing));
    const now = new Date().toISOString();
    return saveAlias({
      id: address,
      accountId,
      address,
      domain: address.split("@")[1]!,
      alias: address.split("@")[0]!,
      unknownSenderPolicy: defaultUnknownSenderPolicy,
      createdAt: now,
      updatedAt: now,
    });
  });
  return {
    listEnabledRules: vi.fn().mockReturnValue(Promise.resolve(ok([]))),
    getProcessorAccountContext: vi.fn().mockReturnValue(Promise.resolve(ok({
      retentionDuration: "P3M",
      filtering: null,
      aliasConfig: null,
      registeredDomains: [],
      userEmails: [],
      billingPlan: "Paid" as const,
    }))),
    saveAlias,
    ensureAlias,
    getSender: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    saveSender: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    getTemplate: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    getDomainByName: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    incrementStats: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    annotateRuleError: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    annotateTemplateError: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    listLabels: vi.fn().mockReturnValue(Promise.resolve(ok([]))),
    upsertSystemRuleStatus: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
  } as unknown as AccountDatabase;
}

/**
 * ProcessingDatabase mock — global reputation tracking used by the processor.
 */
export function makeProcessingDbMock(): ProcessingDatabase {
  return {
    updateGlobalReputation: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
  } as unknown as ProcessingDatabase;
}
