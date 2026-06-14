import { describe, it, expect, beforeEach, vi } from "vitest";
import { ok, err } from "neverthrow";
import { OnboardingTaskHandler } from "../../src/onboarding/onboarding-task-handler.js";
import type { OnboardingStore } from "../../src/onboarding/onboarding-task-handler.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import type { Account, Domain } from "../../src/types/index.js";
import { dbError } from "../../src/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-test",
    name: "Test Account",
    deletionRetentionDays: 30,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeDomain(overrides: Partial<Domain> = {}): Domain {
  return {
    accountId: "acc-test",
    domain: "example.com",
    receivingSetupComplete: true,
    senderSetupComplete: false,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function createMockStore(overrides: Partial<OnboardingStore> = {}): OnboardingStore {
  return {
    getAccount: vi.fn().mockResolvedValue(ok(makeAccount())),
    updateAccount: vi.fn().mockResolvedValue(ok(makeAccount())),
    listDomains: vi.fn().mockResolvedValue(ok([])),
    hasSignals: vi.fn().mockResolvedValue(ok(false)),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleFollowup
// ---------------------------------------------------------------------------

describe("OnboardingTaskHandler.handleFollowup", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
  });

  it("logs TRACK with all 3 suggestions when no milestones complete", async () => {
    const store = createMockStore();
    const handler = new OnboardingTaskHandler(store, logger);

    const result = await handler.handleFollowup("acc-test", "user@example.com");

    expect(result.isOk()).toBe(true);
    const trackLog = logger.calls.find(c => c.method === "track");
    expect(trackLog).toBeDefined();
    expect(trackLog!.context).toMatchObject({
      code: "onboarding.followup",
      accountId: "acc-test",
      email: "user@example.com",
      progress: { domainAdded: false, senderSetupComplete: false, emailsReceived: false },
    });
  });

  it("logs TRACK with 2 suggestions when domain added only", async () => {
    const store = createMockStore({
      listDomains: vi.fn().mockResolvedValue(ok([makeDomain()])),
    });
    const handler = new OnboardingTaskHandler(store, logger);

    const result = await handler.handleFollowup("acc-test", "user@example.com");

    expect(result.isOk()).toBe(true);
    const trackLog = logger.calls.find(c => c.method === "track");
    expect(trackLog!.context).toMatchObject({
      progress: { domainAdded: true, senderSetupComplete: false, emailsReceived: false },
    });
  });

  it("marks testEmailReceived when signals exist and not yet marked", async () => {
    const store = createMockStore({
      getAccount: vi.fn().mockResolvedValue(ok(makeAccount({ onboarding: { completed: false } }))),
      listDomains: vi.fn().mockResolvedValue(ok([makeDomain({ senderSetupComplete: true })])),
      hasSignals: vi.fn().mockResolvedValue(ok(true)),
    });
    const handler = new OnboardingTaskHandler(store, logger);

    const result = await handler.handleFollowup("acc-test", "user@example.com");

    expect(result.isOk()).toBe(true);
    expect(store.updateAccount).toHaveBeenCalledWith("acc-test", {
      onboarding: { completed: false, testEmailReceived: true, testEmailReceivedAt: "2025-06-15T12:00:00.000Z" },
    });
  });

  it("does not update account when testEmailReceived already set", async () => {
    const store = createMockStore({
      getAccount: vi.fn().mockResolvedValue(ok(makeAccount({ onboarding: { completed: true, completedAt: "2025-06-01T00:00:00Z", testEmailReceived: true, testEmailReceivedAt: "2025-06-01T00:00:00Z" } }))),
      listDomains: vi.fn().mockResolvedValue(ok([makeDomain({ senderSetupComplete: true })])),
      hasSignals: vi.fn().mockResolvedValue(ok(true)),
    });
    const handler = new OnboardingTaskHandler(store, logger);

    const result = await handler.handleFollowup("acc-test", "user@example.com");

    expect(result.isOk()).toBe(true);
    expect(store.updateAccount).not.toHaveBeenCalled();
  });

  it("skips and returns Ok when account not found", async () => {
    const store = createMockStore({
      getAccount: vi.fn().mockResolvedValue(ok(null)),
    });
    const handler = new OnboardingTaskHandler(store, logger);

    const result = await handler.handleFollowup("acc-missing", "user@example.com");

    expect(result.isOk()).toBe(true);
    const infoLog = logger.calls.find(c => c.method === "info");
    expect(infoLog).toBeDefined();
    expect(infoLog!.context).toMatchObject({ code: "onboarding.followup", accountId: "acc-missing" });
    expect(store.listDomains).not.toHaveBeenCalled();
  });

  it("treats domainAdded as false when listDomains fails", async () => {
    const store = createMockStore({
      listDomains: vi.fn().mockResolvedValue(err(dbError(new Error("timeout")))),
    });
    const handler = new OnboardingTaskHandler(store, logger);

    const result = await handler.handleFollowup("acc-test", "user@example.com");

    expect(result.isOk()).toBe(true);
    const trackLog = logger.calls.find(c => c.method === "track");
    expect(trackLog!.context).toMatchObject({
      progress: { domainAdded: false, senderSetupComplete: false, emailsReceived: false },
    });
    const warnLog = logger.calls.find(c => c.method === "warn");
    expect(warnLog).toBeDefined();
  });

  it("treats emailsReceived as false when hasSignals fails", async () => {
    const store = createMockStore({
      listDomains: vi.fn().mockResolvedValue(ok([makeDomain({ senderSetupComplete: true })])),
      hasSignals: vi.fn().mockResolvedValue(err(dbError(new Error("timeout")))),
    });
    const handler = new OnboardingTaskHandler(store, logger);

    const result = await handler.handleFollowup("acc-test", "user@example.com");

    expect(result.isOk()).toBe(true);
    const trackLog = logger.calls.find(c => c.method === "track");
    expect(trackLog!.context).toMatchObject({
      progress: { domainAdded: true, senderSetupComplete: true, emailsReceived: false },
    });
  });

  it("returns Err when getAccount fails", async () => {
    const store = createMockStore({
      getAccount: vi.fn().mockResolvedValue(err(dbError(new Error("connection reset")))),
    });
    const handler = new OnboardingTaskHandler(store, logger);

    const result = await handler.handleFollowup("acc-test", "user@example.com");

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("db_error");
  });
});

// ---------------------------------------------------------------------------
// handleCleanup (same logic as followup, different code)
// ---------------------------------------------------------------------------

describe("OnboardingTaskHandler.handleCleanup", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it("logs TRACK with code onboarding.cleanup", async () => {
    const store = createMockStore();
    const handler = new OnboardingTaskHandler(store, logger);

    const result = await handler.handleCleanup("acc-test", "user@example.com");

    expect(result.isOk()).toBe(true);
    const trackLog = logger.calls.find(c => c.method === "track");
    expect(trackLog!.context).toMatchObject({ code: "onboarding.cleanup" });
  });
});

// ---------------------------------------------------------------------------
// handleTrialCheck
// ---------------------------------------------------------------------------

describe("OnboardingTaskHandler.handleTrialCheck", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it.each([
    { label: "Trial plan", billingPlan: "Trial" as const, expected: true },
    { label: "Paid plan", billingPlan: "Paid" as const, expected: false },
    { label: "Lifetime plan", billingPlan: "Lifetime" as const, expected: false },
  ])("$label → accountIsTrial=$expected", async ({ billingPlan, expected }) => {
    const store = createMockStore({
      getAccount: vi.fn().mockResolvedValue(ok(makeAccount({ billingPlan }))),
    });
    const handler = new OnboardingTaskHandler(store, logger);

    const result = await handler.handleTrialCheck("acc-test");

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ accountIsTrial: expected });
  });

  it("missing billingPlan → accountIsTrial=false", async () => {
    const store = createMockStore({
      getAccount: vi.fn().mockResolvedValue(ok(makeAccount())),
    });
    const handler = new OnboardingTaskHandler(store, logger);

    const result = await handler.handleTrialCheck("acc-test");

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ accountIsTrial: false });
  });

  it("returns ok({ accountIsTrial: false }) when account not found", async () => {
    const store = createMockStore({
      getAccount: vi.fn().mockResolvedValue(ok(null)),
    });
    const handler = new OnboardingTaskHandler(store, logger);

    const result = await handler.handleTrialCheck("acc-deleted");

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ accountIsTrial: false });
  });

  it("returns Err when DynamoDB read fails", async () => {
    const store = createMockStore({
      getAccount: vi.fn().mockResolvedValue(err(dbError(new Error("service unavailable")))),
    });
    const handler = new OnboardingTaskHandler(store, logger);

    const result = await handler.handleTrialCheck("acc-test");

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("db_error");
  });
});
