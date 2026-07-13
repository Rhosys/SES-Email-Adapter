import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "neverthrow";
import { HealthcheckValidator, type HealthcheckValidatorDeps } from "../../src/jobs/healthcheck-validator.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

vi.mock("../../src/dns/dns-checker.js", () => ({
  checkDomain: vi.fn().mockResolvedValue([
    { name: "platform.email.rhosys.cloud", type: "MX", value: "10 mx.platform.email.rhosys.cloud", status: "verified" },
    { name: "mail._domainkey.platform.email.rhosys.cloud", type: "CNAME", value: "mail._domainkey.platform.email.rhosys.cloud", status: "verified" },
    { name: "bounce.platform.email.rhosys.cloud", type: "CNAME", value: "bounce.platform.email.rhosys.cloud", status: "verified" },
    { name: "_dmarc.platform.email.rhosys.cloud", type: "CNAME", value: "_dmarc.platform.email.rhosys.cloud", status: "verified" },
  ]),
}));

function makeThread(overrides: { id?: string; workflow?: string; createdAt?: string } = {}) {
  return {
    id: overrides.id ?? "thr-hc",
    accountId: "SYSTEM",
    workflow: overrides.workflow ?? "healthcheck",
    labels: [],
    status: "active",
    summary: "Healthcheck",
    lastSignalAt: overrides.createdAt ?? "2026-07-08T06:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-07-08T06:00:00.000Z",
    updatedAt: overrides.createdAt ?? "2026-07-08T06:00:00.000Z",
    senderAddress: "healthcheck@platform.email.rhosys.cloud",
    recipientAddress: "healthcheck@platform.email.rhosys.cloud",
    subject: "Healthcheck 2026-07-08",
  };
}

function makeDeps(overrides: {
  threads?: ReturnType<typeof makeThread>[];
  listErr?: boolean;
  hasEmbedding?: boolean;
  logger?: MockLogger;
} = {}): { deps: HealthcheckValidatorDeps; logger: MockLogger } {
  const logger = overrides.logger ?? createMockLogger();
  const listResult = overrides.listErr
    ? err({ kind: "db_error", message: "boom" })
    : ok({ items: overrides.threads ?? [makeThread()] });

  const deps: HealthcheckValidatorDeps = {
    threadDb: {
      listThreads: vi.fn().mockResolvedValue(listResult),
    } as unknown as HealthcheckValidatorDeps["threadDb"],
    searchDatabase: {
      hasEmbedding: vi.fn().mockResolvedValue(overrides.hasEmbedding ?? true),
    },
    mailDomain: "platform.email.rhosys.cloud",
    logger,
  };

  return { deps, logger };
}

function checkById(checks: { id: string; status: string; detail?: string }[], id: string) {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`check ${id} not found`);
  return c;
}

describe("HealthcheckValidator", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns pass with every check passing when a healthcheck thread was created that day", async () => {
    const { deps } = makeDeps({ threads: [makeThread({ createdAt: "2026-07-08T06:00:00.000Z" })], hasEmbedding: true });
    const result = await new HealthcheckValidator(deps).validate("2026-07-08");

    expect(result.status).toBe("pass");
    expect(result.checkedDate).toBe("2026-07-08");
    expect(result.checks).toHaveLength(7);
    expect(result.checks.every((c) => c.status === "pass")).toBe(true);
    expect(result.rawChecks).toEqual({ hasThreadId: true, workflowIsHealthcheck: true, hasEmbedding: true });
  });

  it("marks the embedding check as failing when the thread has no embedding", async () => {
    const { deps } = makeDeps({ threads: [makeThread()], hasEmbedding: false });
    const result = await new HealthcheckValidator(deps).validate("2026-07-08");

    expect(result.status).toBe("fail");
    expect(checkById(result.checks, "thread-created").status).toBe("pass");
    expect(checkById(result.checks, "workflow-classified").status).toBe("pass");
    const embedding = checkById(result.checks, "embedding-indexed");
    expect(embedding.status).toBe("fail");
    expect(embedding.detail).toBeTruthy();
  });

  it("marks workflow-classified as failing when the thread is not the healthcheck workflow", async () => {
    const { deps } = makeDeps({ threads: [makeThread({ workflow: "conversation" })], hasEmbedding: true });
    const result = await new HealthcheckValidator(deps).validate("2026-07-08");

    expect(result.status).toBe("fail");
    expect(checkById(result.checks, "workflow-classified").status).toBe("fail");
  });

  it("reports thread-created as fail and downstream checks as unknown when no thread was created that day", async () => {
    // Thread exists but for a different day.
    const { deps } = makeDeps({ threads: [makeThread({ createdAt: "2026-07-05T06:00:00.000Z" })] });
    const result = await new HealthcheckValidator(deps).validate("2026-07-08");

    expect(result.status).toBe("fail");
    expect(result.rawChecks).toBeNull();
    expect(checkById(result.checks, "thread-created").status).toBe("fail");
    expect(checkById(result.checks, "workflow-classified").status).toBe("unknown");
    expect(checkById(result.checks, "embedding-indexed").status).toBe("unknown");
  });

  it("reports overall unknown when listing SYSTEM threads errors", async () => {
    const { deps } = makeDeps({ listErr: true });
    const result = await new HealthcheckValidator(deps).validate("2026-07-08");

    expect(result.status).toBe("unknown");
    expect(result.rawChecks).toBeNull();
    expect(checkById(result.checks, "thread-created").status).toBe("unknown");
    expect(checkById(result.checks, "workflow-classified").status).toBe("unknown");
    expect(checkById(result.checks, "embedding-indexed").status).toBe("unknown");
  });

  it("validateLatest validates yesterday (UTC)", async () => {
    const expectedDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { deps } = makeDeps({ threads: [makeThread({ createdAt: `${expectedDate}T06:00:00.000Z` })] });
    const result = await new HealthcheckValidator(deps).validateLatest();
    expect(result.checkedDate).toBe(expectedDate);
    expect(result.status).toBe("pass");
  });
});
