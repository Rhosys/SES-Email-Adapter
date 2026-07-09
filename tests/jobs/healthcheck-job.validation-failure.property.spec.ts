import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok } from "neverthrow";
import { DateTime } from "luxon";
import { HealthcheckJob, type HealthcheckJobDeps } from "../../src/jobs/healthcheck-job.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Property 3 — Validation failure detection (thread-based)
//
// Validation lists the SYSTEM account's threads and looks for the one created
// on the target day. For a thread whose workflow is not "healthcheck", OR that
// lacks an embedding in Aurora pgvector, the job SHALL log a track-level message
// with code `healthcheck.validation_failed` including which specific checks
// failed. When no thread was created for the day it logs
// `healthcheck.thread_not_found` instead.
// ---------------------------------------------------------------------------

vi.mock("../../src/email/template-renderer.js", () => ({
  renderTemplate: vi.fn().mockResolvedValue("<html></html>"),
}));

const MAIL_DOMAIN = "platform.email.rhosys.cloud";
const YESTERDAY = DateTime.utc().minus({ days: 1 }).toFormat("yyyy-MM-dd");

function makeThread(overrides: { id?: string; workflow?: string; createdAt?: string } = {}) {
  const createdAt = overrides.createdAt ?? `${YESTERDAY}T06:00:00.000Z`;
  return {
    id: overrides.id ?? "thr-hc",
    accountId: "SYSTEM",
    workflow: overrides.workflow ?? "healthcheck",
    labels: [],
    status: "active",
    summary: "Healthcheck",
    lastSignalAt: createdAt,
    createdAt,
    updatedAt: createdAt,
    senderAddress: `healthcheck@${MAIL_DOMAIN}`,
    recipientAddress: `healthcheck@${MAIL_DOMAIN}`,
    subject: `Healthcheck ${YESTERDAY}`,
  };
}

function makeDeps(overrides: {
  threads?: ReturnType<typeof makeThread>[];
  hasEmbedding?: boolean;
  logger?: MockLogger;
} = {}): { deps: HealthcheckJobDeps; logger: MockLogger } {
  const logger = overrides.logger ?? createMockLogger();

  const deps: HealthcheckJobDeps = {
    threadDb: {
      listThreads: vi.fn().mockResolvedValue(ok({ items: overrides.threads ?? [makeThread()] })),
    } as unknown as HealthcheckJobDeps["threadDb"],
    emailService: {
      send: vi.fn().mockResolvedValue(ok({ messageId: "ses-msg-id" })),
    } as unknown as HealthcheckJobDeps["emailService"],
    searchDatabase: {
      hasEmbedding: vi.fn().mockResolvedValue(overrides.hasEmbedding ?? true),
    },
    mailDomain: MAIL_DOMAIN,
    logger,
  };

  return { deps, logger };
}

// ---------------------------------------------------------------------------
// Parameterized test: all failure combinations for a thread that WAS created
// ---------------------------------------------------------------------------

interface ValidationScenario {
  label: string;
  workflow: string;
  hasEmbedding: boolean;
  expectedChecks: { hasThreadId: boolean; workflowIsHealthcheck: boolean; hasEmbedding: boolean };
}

const failureScenarios: ValidationScenario[] = [
  {
    label: "wrong workflow (conversation)",
    workflow: "conversation",
    hasEmbedding: true,
    expectedChecks: { hasThreadId: true, workflowIsHealthcheck: false, hasEmbedding: true },
  },
  {
    label: "wrong workflow (test)",
    workflow: "test",
    hasEmbedding: true,
    expectedChecks: { hasThreadId: true, workflowIsHealthcheck: false, hasEmbedding: true },
  },
  {
    label: "missing embedding",
    workflow: "healthcheck",
    hasEmbedding: false,
    expectedChecks: { hasThreadId: true, workflowIsHealthcheck: true, hasEmbedding: false },
  },
  {
    label: "wrong workflow + missing embedding",
    workflow: "alert",
    hasEmbedding: false,
    expectedChecks: { hasThreadId: true, workflowIsHealthcheck: false, hasEmbedding: false },
  },
];

describe("Property 3: Validation failure detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(failureScenarios)("$label → logs healthcheck.validation_failed with correct checks", async (scenario) => {
    const thread = makeThread({ workflow: scenario.workflow });
    const { deps, logger } = makeDeps({ threads: [thread], hasEmbedding: scenario.hasEmbedding });

    const job = new HealthcheckJob(deps);
    await job.run();

    const failedLog = logger.calls.find(c => c.context && (c.context as Record<string, unknown>).code === "healthcheck.validation_failed");
    expect(failedLog).toBeDefined();
    expect(failedLog!.method).toBe("error");

    const ctx = failedLog!.context as Record<string, unknown>;
    expect(ctx.checks).toEqual(scenario.expectedChecks);
  });

  // Positive case: all checks pass → validation_passed (not validation_failed)
  it("all checks pass → logs healthcheck.validation_passed (not validation_failed)", async () => {
    const { deps, logger } = makeDeps({ threads: [makeThread({ workflow: "healthcheck" })], hasEmbedding: true });

    const job = new HealthcheckJob(deps);
    await job.run();

    const passedLog = logger.calls.find(c => c.context && (c.context as Record<string, unknown>).code === "healthcheck.validation_passed");
    expect(passedLog).toBeDefined();
    expect(passedLog!.method).toBe("track");

    const failedLog = logger.calls.find(c => c.context && (c.context as Record<string, unknown>).code === "healthcheck.validation_failed");
    expect(failedLog).toBeUndefined();

    const ctx = passedLog!.context as Record<string, unknown>;
    expect(ctx.checks).toEqual({ hasThreadId: true, workflowIsHealthcheck: true, hasEmbedding: true });
  });

  // Verify the log includes which thread failed
  it("validation_failed log includes threadState with id and workflow", async () => {
    const thread = makeThread({ id: "thr-bad", workflow: "conversation" });
    const { deps, logger } = makeDeps({ threads: [thread], hasEmbedding: false });

    const job = new HealthcheckJob(deps);
    await job.run();

    const failedLog = logger.calls.find(c => c.context && (c.context as Record<string, unknown>).code === "healthcheck.validation_failed");
    expect(failedLog).toBeDefined();

    const ctx = failedLog!.context as Record<string, unknown>;
    expect(ctx.threadState).toBeDefined();
    const threadState = ctx.threadState as Record<string, unknown>;
    expect(threadState.id).toBe("thr-bad");
    expect(threadState.workflow).toBe("conversation");
  });

  // No thread created for the day → thread_not_found (not validation_failed)
  it("no thread created for the day → logs healthcheck.thread_not_found", async () => {
    // A thread exists, but it was created several days earlier.
    const stale = makeThread({ createdAt: "2020-01-01T06:00:00.000Z" });
    const { deps, logger } = makeDeps({ threads: [stale] });

    const job = new HealthcheckJob(deps);
    await job.run();

    const notFoundLog = logger.calls.find(c => c.context && (c.context as Record<string, unknown>).code === "healthcheck.thread_not_found");
    expect(notFoundLog).toBeDefined();
    expect(notFoundLog!.method).toBe("error");
  });
});
