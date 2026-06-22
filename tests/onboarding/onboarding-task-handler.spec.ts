import { describe, it, expect, beforeEach, vi } from "vitest";
import { ok, err } from "neverthrow";
import { OnboardingTaskHandler } from "../../src/onboarding/onboarding-task-handler.js";
import type { IOnboardingAccountDb, IOnboardingArcDb } from "../../src/onboarding/onboarding-task-handler.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import type { Account, Domain } from "../../src/types/index.js";
import type { EmailService } from "../../src/email/email-service.js";
import { dbError } from "../../src/errors.js";

vi.mock("../../src/email/template-renderer.js", () => ({
  renderTemplate: vi.fn().mockResolvedValue("<html>rendered</html>"),
}));

vi.mock("../../src/email/unsubscribe-token.js", () => ({
  generateUnsubscribeToken: vi.fn().mockResolvedValue("mock-jwt-token"),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-test",
    name: "Test Account",
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

function createMockStore(overrides: Partial<IOnboardingAccountDb & IOnboardingArcDb> = {}): { accountDb: IOnboardingAccountDb; arcDb: IOnboardingArcDb } {
  return {
    accountDb: {
      getAccount: overrides.getAccount ?? vi.fn().mockResolvedValue(ok(makeAccount())),
      updateAccount: overrides.updateAccount ?? vi.fn().mockResolvedValue(ok(makeAccount())),
      listDomains: overrides.listDomains ?? vi.fn().mockResolvedValue(ok([])),
    },
    arcDb: {
      hasSignals: overrides.hasSignals ?? vi.fn().mockResolvedValue(ok(false)),
    },
  };
}

function createMockEmailService() {
  return {
    send: vi.fn().mockResolvedValue(ok({ messageId: "msg-123" })),
    sendRaw: vi.fn().mockResolvedValue(ok({ messageId: "msg-456" })),
  } as unknown as EmailService;
}

// ---------------------------------------------------------------------------
// handleFollowup
// ---------------------------------------------------------------------------

describe("OnboardingTaskHandler.handleFollowup", () => {
  let logger: ReturnType<typeof createMockLogger>;
  let emailService: ReturnType<typeof createMockEmailService>;

  beforeEach(() => {
    logger = createMockLogger();
    emailService = createMockEmailService();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
  });

  it("sends email with TRACK log when no milestones complete", async () => {
    const store = createMockStore();
    const handler = new OnboardingTaskHandler(store.accountDb, store.arcDb, logger, emailService);

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
    expect((emailService.send as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({
      to: "user@example.com",
      subject: "The Next Step",
    }));
  });

  it("sends email when domain added only (2 incomplete steps)", async () => {
    const store = createMockStore({
      listDomains: vi.fn().mockResolvedValue(ok([makeDomain()])),
    });
    const handler = new OnboardingTaskHandler(store.accountDb, store.arcDb, logger, emailService);

    const result = await handler.handleFollowup("acc-test", "user@example.com");

    expect(result.isOk()).toBe(true);
    const trackLog = logger.calls.find(c => c.method === "track");
    expect(trackLog!.context).toMatchObject({
      progress: { domainAdded: true, senderSetupComplete: false, emailsReceived: false },
    });
    expect((emailService.send as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it("marks testEmailReceived when signals exist and not yet marked", async () => {
    const store = createMockStore({
      getAccount: vi.fn().mockResolvedValue(ok(makeAccount({ onboarding: { completed: false } }))),
      listDomains: vi.fn().mockResolvedValue(ok([makeDomain({ senderSetupComplete: true })])),
      hasSignals: vi.fn().mockResolvedValue(ok(true)),
    });
    const handler = new OnboardingTaskHandler(store.accountDb, store.arcDb, logger, emailService);

    const result = await handler.handleFollowup("acc-test", "user@example.com");

    expect(result.isOk()).toBe(true);
    expect(store.accountDb.updateAccount).toHaveBeenCalledWith("acc-test", {
      onboarding: { completed: false, testEmailReceived: true, testEmailReceivedAt: "2025-06-15T12:00:00.000Z" },
    });
  });

  it("suppresses email when all steps complete", async () => {
    const store = createMockStore({
      getAccount: vi.fn().mockResolvedValue(ok(makeAccount({ onboarding: { completed: true, completedAt: "2025-06-01T00:00:00Z", testEmailReceived: true, testEmailReceivedAt: "2025-06-01T00:00:00Z" } }))),
      listDomains: vi.fn().mockResolvedValue(ok([makeDomain({ senderSetupComplete: true })])),
      hasSignals: vi.fn().mockResolvedValue(ok(true)),
    });
    const handler = new OnboardingTaskHandler(store.accountDb, store.arcDb, logger, emailService);

    const result = await handler.handleFollowup("acc-test", "user@example.com");

    expect(result.isOk()).toBe(true);
    expect(store.accountDb.updateAccount).not.toHaveBeenCalled();
    expect((emailService.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("skips and returns Ok when account not found", async () => {
    const store = createMockStore({
      getAccount: vi.fn().mockResolvedValue(ok(null)),
    });
    const handler = new OnboardingTaskHandler(store.accountDb, store.arcDb, logger, emailService);

    const result = await handler.handleFollowup("acc-missing", "user@example.com");

    expect(result.isOk()).toBe(true);
    const infoLog = logger.calls.find(c => c.method === "info");
    expect(infoLog).toBeDefined();
    expect(infoLog!.context).toMatchObject({ code: "onboarding.followup", accountId: "acc-missing" });
    expect(store.accountDb.listDomains).not.toHaveBeenCalled();
  });

  it("treats domainAdded as false when listDomains fails", async () => {
    const store = createMockStore({
      listDomains: vi.fn().mockResolvedValue(err(dbError(new Error("timeout")))),
    });
    const handler = new OnboardingTaskHandler(store.accountDb, store.arcDb, logger, emailService);

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
    const handler = new OnboardingTaskHandler(store.accountDb, store.arcDb, logger, emailService);

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
    const handler = new OnboardingTaskHandler(store.accountDb, store.arcDb, logger, emailService);

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
  let emailService: ReturnType<typeof createMockEmailService>;

  beforeEach(() => {
    logger = createMockLogger();
    emailService = createMockEmailService();
  });

  it("sends email with TRACK code onboarding.cleanup", async () => {
    const store = createMockStore();
    const handler = new OnboardingTaskHandler(store.accountDb, store.arcDb, logger, emailService);

    const result = await handler.handleCleanup("acc-test", "user@example.com");

    expect(result.isOk()).toBe(true);
    const trackLog = logger.calls.find(c => c.method === "track");
    expect(trackLog!.context).toMatchObject({ code: "onboarding.cleanup" });
    expect((emailService.send as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleTrialCheck
// ---------------------------------------------------------------------------

describe("OnboardingTaskHandler.handleTrialCheck", () => {
  let logger: ReturnType<typeof createMockLogger>;
  let emailService: ReturnType<typeof createMockEmailService>;

  beforeEach(() => {
    logger = createMockLogger();
    emailService = createMockEmailService();
  });

  it.each([
    { label: "Trial plan", billingPlan: "Trial" as const, expected: true },
    { label: "Paid plan", billingPlan: "Paid" as const, expected: false },
    { label: "Lifetime plan", billingPlan: "Lifetime" as const, expected: false },
  ])("$label → accountIsTrial=$expected", async ({ billingPlan, expected }) => {
    const store = createMockStore({
      getAccount: vi.fn().mockResolvedValue(ok(makeAccount({ billingPlan }))),
    });
    const handler = new OnboardingTaskHandler(store.accountDb, store.arcDb, logger, emailService);

    const result = await handler.handleTrialCheck("acc-test", new Date().toISOString());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ accountIsTrial: expected, trialExpired: false });
  });

  it("missing billingPlan → accountIsTrial=false", async () => {
    const store = createMockStore({
      getAccount: vi.fn().mockResolvedValue(ok(makeAccount())),
    });
    const handler = new OnboardingTaskHandler(store.accountDb, store.arcDb, logger, emailService);

    const result = await handler.handleTrialCheck("acc-test", new Date().toISOString());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ accountIsTrial: false, trialExpired: false });
  });

  it("returns ok({ accountIsTrial: false }) when account not found", async () => {
    const store = createMockStore({
      getAccount: vi.fn().mockResolvedValue(ok(null)),
    });
    const handler = new OnboardingTaskHandler(store.accountDb, store.arcDb, logger, emailService);

    const result = await handler.handleTrialCheck("acc-deleted", new Date().toISOString());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ accountIsTrial: false, trialExpired: false });
  });

  it("sets trialExpired=true and logs TRACK when execution is over 60 days old", async () => {
    const store = createMockStore({
      getAccount: vi.fn().mockResolvedValue(ok(makeAccount({ billingPlan: "Trial" }))),
    });
    const handler = new OnboardingTaskHandler(store.accountDb, store.arcDb, logger, emailService);
    const sixtyOneDaysAgo = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000).toISOString();

    const result = await handler.handleTrialCheck("acc-test", sixtyOneDaysAgo);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ accountIsTrial: true, trialExpired: true });
    const trackLog = logger.calls.find(c => c.method === "track" && (c.context as { code?: string }).code === "onboarding.trial_check_expired");
    expect(trackLog).toBeDefined();
  });

  it("returns Err when DynamoDB read fails", async () => {
    const store = createMockStore({
      getAccount: vi.fn().mockResolvedValue(err(dbError(new Error("service unavailable")))),
    });
    const handler = new OnboardingTaskHandler(store.accountDb, store.arcDb, logger, emailService);

    const result = await handler.handleTrialCheck("acc-test", new Date().toISOString());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("db_error");
  });
});
