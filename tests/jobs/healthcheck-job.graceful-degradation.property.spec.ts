// Feature: weekly-healthcheck, Property 4: Graceful degradation — send always executes
// **Validates: Requirements 4.1, 10.1, 10.2, 10.3, 10.4**
//
// For any outcome of the validation phase (success, failure, signal not found,
// DynamoDB error, Aurora error), the job SHALL proceed to the send phase.
// For any error occurring in the send phase, the job SHALL catch it and return
// normally without re-throwing. The job NEVER throws.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err, dbError } from "../../src/errors.js";
import { HealthcheckJob } from "../../src/jobs/healthcheck-job.js";
import type { HealthcheckJobDeps } from "../../src/jobs/healthcheck-job.js";
import { HealthcheckValidator } from "../../src/jobs/healthcheck-validator.js";
import { checkDomain } from "../../src/dns/dns-checker.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import type { MockLogger } from "../helpers/mock-logger.js";

const okSesChecker = { canSendFrom: vi.fn().mockResolvedValue({ verified: true, dkimEnabled: true, accountSendingEnabled: true }) };

vi.mock("../../src/dns/dns-checker.js", () => ({
  checkDomain: vi.fn().mockResolvedValue([
    { name: "platform.email.rhosys.cloud", type: "MX", value: "10 mx.platform.email.rhosys.cloud", status: "verified" },
    { name: "mail._domainkey.platform.email.rhosys.cloud", type: "CNAME", value: "mail._domainkey.platform.email.rhosys.cloud", status: "verified" },
    { name: "bounce.platform.email.rhosys.cloud", type: "CNAME", value: "bounce.platform.email.rhosys.cloud", status: "verified" },
    { name: "_dmarc.platform.email.rhosys.cloud", type: "CNAME", value: "_dmarc.platform.email.rhosys.cloud", status: "verified" },
  ]),
}));

// Mock the template renderer — we don't need real MJML in property tests
vi.mock("../../src/email/template-renderer.js", () => ({
  renderTemplate: vi.fn().mockResolvedValue("<html>healthcheck</html>"),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAIL_DOMAIN = "platform.email.rhosys.cloud";

// Fake system time is fixed to 2025-07-08 in beforeEach, so "yesterday" is 2025-07-07.
function makeThread(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread-hc-1",
    accountId: "SYSTEM",
    workflow: "healthcheck",
    labels: [],
    status: "active",
    summary: "Healthcheck",
    lastSignalAt: "2025-07-07T06:00:00.000Z",
    createdAt: "2025-07-07T06:00:00.000Z",
    updatedAt: "2025-07-07T06:00:00.000Z",
    senderAddress: `healthcheck@${MAIL_DOMAIN}`,
    recipientAddress: `healthcheck@${MAIL_DOMAIN}`,
    subject: "Healthcheck 2025-07-07",
    ...overrides,
  };
}

type DepsOverrides = {
  threadDb?: HealthcheckJobDeps["threadDb"];
  emailService?: HealthcheckJobDeps["emailService"];
  searchDatabase?: ConstructorParameters<typeof HealthcheckValidator>[0]["searchDatabase"];
  logger?: HealthcheckJobDeps["logger"];
};

function makeDeps(overrides: DepsOverrides = {}): HealthcheckJobDeps {
  const threadDb = overrides.threadDb ?? ({ listThreads: vi.fn().mockResolvedValue(ok({ items: [makeThread()] })) } as any);
  const emailService = overrides.emailService ?? ({ send: vi.fn().mockResolvedValue(ok({ messageId: "ses-msg-1" })) } as any);
  const searchDatabase = overrides.searchDatabase ?? { hasEmbedding: vi.fn().mockResolvedValue(ok(true)) };
  const logger = overrides.logger ?? createMockLogger();
  const validator = new HealthcheckValidator({ threadDb, searchDatabase, sesChecker: okSesChecker, dnsChecker: { checkDomain }, mailDomain: MAIL_DOMAIN, logger });
  return {
    threadDb,
    emailService,
    validator,
    mailDomain: MAIL_DOMAIN,
    logger,
  };
}

// ---------------------------------------------------------------------------
// Static test cases: validation phase outcomes that must NOT prevent send
// ---------------------------------------------------------------------------

const validationScenarios = [
  {
    scenario: "validation success — all checks pass",
    setupThreadDb: () => vi.fn().mockResolvedValue(ok({ items: [makeThread()] })),
    setupSearchDb: () => vi.fn().mockResolvedValue(true),
  },
  {
    scenario: "validation failure — wrong workflow",
    setupThreadDb: () => vi.fn().mockResolvedValue(ok({ items: [makeThread({ workflow: "conversation" })] })),
    setupSearchDb: () => vi.fn().mockResolvedValue(true),
  },
  {
    scenario: "thread not found — no thread created for the day",
    setupThreadDb: () => vi.fn().mockResolvedValue(ok({ items: [] })),
    setupSearchDb: () => vi.fn().mockResolvedValue(false),
  },
  {
    scenario: "DynamoDB error — listThreads returns Err",
    setupThreadDb: () => vi.fn().mockResolvedValue(err(dbError(new Error("DynamoDB timeout")))),
    setupSearchDb: () => vi.fn().mockResolvedValue(ok(false)),
  },
  {
    scenario: "Aurora error — hasEmbedding throws",
    setupThreadDb: () => vi.fn().mockResolvedValue(ok({ items: [makeThread()] })),
    setupSearchDb: () => vi.fn().mockRejectedValue(new Error("Aurora connectivity timeout")),
  },
];

// ---------------------------------------------------------------------------
// Property 4: Graceful degradation — send always executes
// ---------------------------------------------------------------------------

describe("Property 4: Graceful degradation — send always executes", () => {
  let mockLogger: MockLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-07-08T06:00:00.000Z"));
    mockLogger = createMockLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Sub-property: send phase runs regardless of validation outcome ---

  it.each(validationScenarios)("send phase runs after: $scenario", async ({ setupThreadDb, setupSearchDb }) => {
    const emailSend = vi.fn().mockResolvedValue(ok({ messageId: "ses-msg-1" }));
    const deps = makeDeps({
      threadDb: { listThreads: setupThreadDb() } as any,
      emailService: { send: emailSend } as any,
      searchDatabase: { hasEmbedding: setupSearchDb() },
      logger: mockLogger,
    });

    const job = new HealthcheckJob(deps);
    await job.run();

    // The property: emailService.send was called — send phase executed
    expect(emailSend).toHaveBeenCalledTimes(1);
  });

  // --- Sub-property: job never throws, even when send phase fails ---

  it("job completes without throwing when send phase returns Err result", async () => {
    const deps = makeDeps({
      emailService: { send: vi.fn().mockResolvedValue(err(dbError(new Error("SES throttle")))) } as any,
      logger: mockLogger,
    });

    const job = new HealthcheckJob(deps);

    // The property: run() resolves without throwing
    await expect(job.run()).resolves.toBeUndefined();
  });

  it("job completes without throwing when send phase throws unexpected exception", async () => {
    const deps = makeDeps({
      emailService: { send: vi.fn().mockRejectedValue(new Error("Network unreachable")) } as any,
      logger: mockLogger,
    });

    const job = new HealthcheckJob(deps);

    // The property: run() resolves without throwing
    await expect(job.run()).resolves.toBeUndefined();

    // Verify it logged the error
    const sendErrorLogs = mockLogger.calls.filter(c => c.context && (c.context as any).code === "healthcheck.send_error");
    expect(sendErrorLogs.length).toBeGreaterThanOrEqual(1);
  });

  it("job completes without throwing when both validation AND send throw", async () => {
    const deps = makeDeps({
      threadDb: { listThreads: vi.fn().mockRejectedValue(new Error("DynamoDB catastrophic")) } as any,
      emailService: { send: vi.fn().mockRejectedValue(new Error("SES catastrophic")) } as any,
      searchDatabase: { hasEmbedding: vi.fn().mockRejectedValue(new Error("Aurora down")) },
      logger: mockLogger,
    });

    const job = new HealthcheckJob(deps);

    // The property: run() NEVER throws — Lambda always reports success to EventBridge
    await expect(job.run()).resolves.toBeUndefined();
  });
});
