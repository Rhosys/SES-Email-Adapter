import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok } from "neverthrow";
import { HealthcheckJob, type HealthcheckJobDeps } from "../../src/jobs/healthcheck-job.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Task 10.4: Property 3 — Validation failure detection
// Validates: Requirements 3.3, 3.4, 3.5, 3.7
//
// For any signal returned from GSI3 that is missing a non-empty threadId,
// OR has a workflow other than "healthcheck", OR lacks an embedding in
// Aurora pgvector, the job SHALL log a track-level message with code
// `healthcheck.validation_failed` including which specific checks failed.
// ---------------------------------------------------------------------------

vi.mock("../../src/email/template-renderer.js", () => ({
  renderTemplate: vi.fn().mockResolvedValue("<html></html>"),
}));

const MAIL_DOMAIN = "platform.email.rhosys.cloud";

function makeSignal(overrides: { threadId?: string; workflow?: string } = {}) {
  return {
    id: "sig-test",
    signalLookupId: "lookup-test",
    accountId: "SYSTEM",
    status: "active",
    source: "email",
    type: "email",
    threadId: overrides.threadId,
    data: { workflow: overrides.workflow },
  };
}

function makeDeps(overrides: {
  signal?: ReturnType<typeof makeSignal> | null;
  hasEmbedding?: boolean;
  logger?: MockLogger;
} = {}): { deps: HealthcheckJobDeps; logger: MockLogger } {
  const logger = overrides.logger ?? createMockLogger();
  const signal = overrides.signal === undefined ? makeSignal({ threadId: "thread-1", workflow: "healthcheck" }) : overrides.signal;

  const deps: HealthcheckJobDeps = {
    threadDb: {
      findSignalByEmailMessageId: vi.fn().mockResolvedValue(ok(signal)),
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
// Parameterized test: all failure combinations
// ---------------------------------------------------------------------------

interface ValidationScenario {
  label: string;
  threadId: string | undefined;
  workflow: string;
  hasEmbedding: boolean;
  expectedChecks: { hasThreadId: boolean; workflowIsHealthcheck: boolean; hasEmbedding: boolean };
}

const failureScenarios: ValidationScenario[] = [
  // Single failures
  {
    label: "missing threadId (undefined)",
    threadId: undefined,
    workflow: "healthcheck",
    hasEmbedding: true,
    expectedChecks: { hasThreadId: false, workflowIsHealthcheck: true, hasEmbedding: false },
    // hasEmbedding is false because embedding lookup is skipped when threadId is missing
  },
  {
    label: "missing threadId (empty string)",
    threadId: "",
    workflow: "healthcheck",
    hasEmbedding: true,
    expectedChecks: { hasThreadId: false, workflowIsHealthcheck: true, hasEmbedding: false },
  },
  {
    label: "wrong workflow (conversation)",
    threadId: "thread-abc",
    workflow: "conversation",
    hasEmbedding: true,
    expectedChecks: { hasThreadId: true, workflowIsHealthcheck: false, hasEmbedding: true },
  },
  {
    label: "wrong workflow (test)",
    threadId: "thread-abc",
    workflow: "test",
    hasEmbedding: true,
    expectedChecks: { hasThreadId: true, workflowIsHealthcheck: false, hasEmbedding: true },
  },
  {
    label: "missing embedding",
    threadId: "thread-abc",
    workflow: "healthcheck",
    hasEmbedding: false,
    expectedChecks: { hasThreadId: true, workflowIsHealthcheck: true, hasEmbedding: false },
  },

  // Double failures
  {
    label: "missing threadId + wrong workflow",
    threadId: undefined,
    workflow: "payments",
    hasEmbedding: true,
    expectedChecks: { hasThreadId: false, workflowIsHealthcheck: false, hasEmbedding: false },
  },
  {
    label: "missing threadId + missing embedding",
    threadId: undefined,
    workflow: "healthcheck",
    hasEmbedding: false,
    expectedChecks: { hasThreadId: false, workflowIsHealthcheck: true, hasEmbedding: false },
  },
  {
    label: "wrong workflow + missing embedding",
    threadId: "thread-abc",
    workflow: "alert",
    hasEmbedding: false,
    expectedChecks: { hasThreadId: true, workflowIsHealthcheck: false, hasEmbedding: false },
  },

  // Triple failure
  {
    label: "all checks fail (no threadId, wrong workflow, no embedding)",
    threadId: undefined,
    workflow: "unspecified",
    hasEmbedding: false,
    expectedChecks: { hasThreadId: false, workflowIsHealthcheck: false, hasEmbedding: false },
  },
];

describe("Property 3: Validation failure detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(failureScenarios)("$label → logs healthcheck.validation_failed with correct checks", async (scenario) => {
    const signal = makeSignal({ threadId: scenario.threadId, workflow: scenario.workflow });
    const { deps, logger } = makeDeps({ signal, hasEmbedding: scenario.hasEmbedding });

    const job = new HealthcheckJob(deps);
    await job.run();

    const failedLog = logger.calls.find(c => c.context && (c.context as Record<string, unknown>).code === "healthcheck.validation_failed");
    expect(failedLog).toBeDefined();
    expect(failedLog!.method).toBe("track");

    const ctx = failedLog!.context as Record<string, unknown>;
    expect(ctx.checks).toEqual(scenario.expectedChecks);
  });

  // Positive case: all checks pass → validation_passed (not validation_failed)
  it("all checks pass → logs healthcheck.validation_passed (not validation_failed)", async () => {
    const signal = makeSignal({ threadId: "thread-valid", workflow: "healthcheck" });
    const { deps, logger } = makeDeps({ signal, hasEmbedding: true });

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

  // Verify the log includes which checks failed (signal state context)
  it("validation_failed log includes signalState with threadId and workflow", async () => {
    const signal = makeSignal({ threadId: undefined, workflow: "conversation" });
    const { deps, logger } = makeDeps({ signal, hasEmbedding: false });

    const job = new HealthcheckJob(deps);
    await job.run();

    const failedLog = logger.calls.find(c => c.context && (c.context as Record<string, unknown>).code === "healthcheck.validation_failed");
    expect(failedLog).toBeDefined();

    const ctx = failedLog!.context as Record<string, unknown>;
    expect(ctx.signalState).toBeDefined();
    const signalState = ctx.signalState as Record<string, unknown>;
    expect(signalState.id).toBe("sig-test");
    expect(signalState.threadId).toBeUndefined();
    expect(signalState.workflow).toBe("conversation");
  });
});
