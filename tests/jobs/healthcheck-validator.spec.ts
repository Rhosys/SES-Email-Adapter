import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "neverthrow";
import { HealthcheckValidator, type HealthcheckValidatorDeps } from "../../src/jobs/healthcheck-validator.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

const MAIL_DOMAIN = "platform.email.rhosys.cloud";

function makeSignal(overrides: { threadId?: string | undefined; workflow?: string } = {}) {
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
  findResult?: ReturnType<typeof ok> | ReturnType<typeof err>;
  hasEmbedding?: boolean;
  logger?: MockLogger;
} = {}): { deps: HealthcheckValidatorDeps; logger: MockLogger } {
  const logger = overrides.logger ?? createMockLogger();
  const signal = overrides.signal === undefined ? makeSignal({ threadId: "thread-1", workflow: "healthcheck" }) : overrides.signal;
  const findResult = overrides.findResult ?? ok(signal);

  const deps: HealthcheckValidatorDeps = {
    threadDb: {
      findSignalByEmailMessageId: vi.fn().mockResolvedValue(findResult),
    } as unknown as HealthcheckValidatorDeps["threadDb"],
    searchDatabase: {
      hasEmbedding: vi.fn().mockResolvedValue(overrides.hasEmbedding ?? true),
    },
    mailDomain: MAIL_DOMAIN,
    logger,
  };

  return { deps, logger };
}

function checkById(checks: { id: string; status: string; detail?: string }[], id: string) {
  const c = checks.find(x => x.id === id);
  if (!c) throw new Error(`check ${id} not found`);
  return c;
}

describe("HealthcheckValidator", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns pass with every check passing when the signal is fully processed", async () => {
    const { deps } = makeDeps({ signal: makeSignal({ threadId: "thread-1", workflow: "healthcheck" }), hasEmbedding: true });
    const result = await new HealthcheckValidator(deps).validate("2026-07-08");

    expect(result.status).toBe("pass");
    expect(result.checkedDate).toBe("2026-07-08");
    expect(result.messageId).toBe(`healthcheck-2026-07-08@${MAIL_DOMAIN}`);
    expect(result.checks).toHaveLength(4);
    expect(result.checks.every(c => c.status === "pass")).toBe(true);
    expect(result.rawChecks).toEqual({ hasThreadId: true, workflowIsHealthcheck: true, hasEmbedding: true });
  });

  it("marks the specific failing check when an embedding is missing", async () => {
    const { deps } = makeDeps({ signal: makeSignal({ threadId: "thread-1", workflow: "healthcheck" }), hasEmbedding: false });
    const result = await new HealthcheckValidator(deps).validate("2026-07-08");

    expect(result.status).toBe("fail");
    expect(checkById(result.checks, "signal-received").status).toBe("pass");
    expect(checkById(result.checks, "thread-assigned").status).toBe("pass");
    expect(checkById(result.checks, "workflow-classified").status).toBe("pass");
    const embedding = checkById(result.checks, "embedding-indexed");
    expect(embedding.status).toBe("fail");
    expect(embedding.detail).toBeTruthy();
  });

  it("reports signal-received as fail and downstream checks as unknown when no signal exists", async () => {
    const { deps } = makeDeps({ signal: null });
    const result = await new HealthcheckValidator(deps).validate("2026-07-08");

    expect(result.status).toBe("fail");
    expect(result.rawChecks).toBeNull();
    expect(checkById(result.checks, "signal-received").status).toBe("fail");
    expect(checkById(result.checks, "thread-assigned").status).toBe("unknown");
    expect(checkById(result.checks, "workflow-classified").status).toBe("unknown");
    expect(checkById(result.checks, "embedding-indexed").status).toBe("unknown");
  });

  it("reports overall unknown when the signals table query errors", async () => {
    const { deps } = makeDeps({ findResult: err({ kind: "db_error", message: "boom" }) });
    const result = await new HealthcheckValidator(deps).validate("2026-07-08");

    expect(result.status).toBe("unknown");
    expect(result.rawChecks).toBeNull();
    expect(result.checks.every(c => c.status === "unknown")).toBe(true);
  });

  it("validateLatest validates yesterday (UTC)", async () => {
    const { deps } = makeDeps();
    const result = await new HealthcheckValidator(deps).validateLatest();
    const expectedDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(result.checkedDate).toBe(expectedDate);
  });
});
