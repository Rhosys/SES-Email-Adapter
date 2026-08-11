import { describe, it, expect, beforeEach, vi } from "vitest";
import { ok } from "neverthrow";
import { OnboardingTaskHandler } from "../../src/onboarding/onboarding-task-handler.js";
import type { IOnboardingAccountDb, IOnboardingThreadDb } from "../../src/onboarding/onboarding-task-handler.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import type { Account, Domain } from "../../src/types/index.js";
import type { EmailService } from "../../src/email/email-service.js";

vi.mock("../../src/email/template-renderer.js", () => ({
  renderTemplate: vi.fn().mockResolvedValue("<html>rendered</html>"),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-test",
    name: "Test Account",
    timezone: "Europe/London",
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

function createMockStore(overrides: Partial<IOnboardingAccountDb & IOnboardingThreadDb> = {}): { accountDb: IOnboardingAccountDb; threadDb: IOnboardingThreadDb } {
  return {
    accountDb: {
      getAccount: overrides.getAccount ?? vi.fn().mockResolvedValue(ok(makeAccount())),
      updateAccount: overrides.updateAccount ?? vi.fn().mockResolvedValue(ok(makeAccount())),
      listDomains: overrides.listDomains ?? vi.fn().mockResolvedValue(ok([])),
      getForwardingTarget: overrides.getForwardingTarget ?? vi.fn().mockResolvedValue(ok(null)),
      saveForwardingTarget: overrides.saveForwardingTarget ?? vi.fn().mockResolvedValue(ok(undefined)),
    },
    threadDb: {
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
// Onboarding email send — REQ-2
// ---------------------------------------------------------------------------

describe("Onboarding email send", () => {
  let logger: ReturnType<typeof createMockLogger>;
  let emailService: ReturnType<typeof createMockEmailService>;

  beforeEach(() => {
    logger = createMockLogger();
    emailService = createMockEmailService();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
  });

  it("does not send when all onboarding steps are complete", async () => {
    const store = createMockStore({
      getAccount: vi.fn().mockResolvedValue(ok(makeAccount({
        onboarding: { completed: true, completedAt: "2025-06-01T00:00:00Z", testEmailReceived: true, testEmailReceivedAt: "2025-06-01T00:00:00Z" },
      }))),
      listDomains: vi.fn().mockResolvedValue(ok([makeDomain({ senderSetupComplete: true })])),
      hasSignals: vi.fn().mockResolvedValue(ok(true)),
    });
    const handler = new OnboardingTaskHandler(store.accountDb, store.threadDb, logger, emailService);

    const result = await handler.handleFollowup("acc-test", "user@example.com");

    expect(result.isOk()).toBe(true);
    expect((emailService.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("sends email with correct subject and template data when account is incomplete", async () => {
    const { renderTemplate } = await import("../../src/email/template-renderer.js");
    const store = createMockStore({
      listDomains: vi.fn().mockResolvedValue(ok([makeDomain({ senderSetupComplete: false })])),
      hasSignals: vi.fn().mockResolvedValue(ok(false)),
    });
    const handler = new OnboardingTaskHandler(store.accountDb, store.threadDb, logger, emailService);

    const result = await handler.handleFollowup("acc-test", "user@example.com");

    expect(result.isOk()).toBe(true);
    expect((emailService.send as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({
      to: "user@example.com",
      subject: "The Next Step",
      htmlBody: "<html>rendered</html>",
      fromOverride: expect.stringContaining("Numaeel"),
    }));

    // Verify template rendered with correct progress flags
    expect(renderTemplate).toHaveBeenCalledWith("onboarding-followup", expect.objectContaining({
      domainAdded: true,
      senderSetupComplete: false,
      emailsReceived: false,
      domainIcon: "✅",
      senderIcon: "❌",
      emailsIcon: "❌",
    }));
  });
});
