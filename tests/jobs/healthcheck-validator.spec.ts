import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err, type Result } from "neverthrow";
import { HealthcheckValidator, type HealthcheckValidatorDeps } from "../../src/jobs/healthcheck-validator.js";
import { dbError, type DbError } from "../../src/errors.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";
import { checkDomain } from "../../src/dns/dns-checker.js";

vi.mock("node:dns/promises", () => ({
  default: {
    resolveMx: vi.fn().mockResolvedValue([{ exchange: "mx.platform.email.rhosys.cloud", priority: 10 }]),
    resolveTxt: vi.fn().mockImplementation((name: string) => {
      if (name.startsWith("mail._domainkey")) return Promise.resolve([["v=DKIM1; k=rsa; p=fake"]]);
      if (name.startsWith("bounce.")) return Promise.resolve([["v=spf1 include:amazonses.com ~all"]]);
      if (name.startsWith("_dmarc.")) return Promise.resolve([["v=DMARC1; p=none"]]);
      return Promise.resolve([]);
    }),
  },
}));

vi.mock("../../src/dns/dns-checker.js", () => ({
  checkDomain: vi.fn().mockResolvedValue([
    { name: "healthcheck.platform.email.rhosys.cloud", type: "MX", value: "10 mx.platform.email.rhosys.cloud", status: "verified" },
    { name: "mail._domainkey.healthcheck.platform.email.rhosys.cloud", type: "CNAME", value: "mail._domainkey.platform.email.rhosys.cloud", status: "verified" },
    { name: "bounce.healthcheck.platform.email.rhosys.cloud", type: "CNAME", value: "bounce.platform.email.rhosys.cloud", status: "verified" },
    { name: "_dmarc.healthcheck.platform.email.rhosys.cloud", type: "CNAME", value: "_dmarc.platform.email.rhosys.cloud", status: "verified" },
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
    sender: { address: "healthcheck@platform.email.rhosys.cloud" },
    recipientAddress: "healthcheck@platform.email.rhosys.cloud",
    subject: "Healthcheck 2026-07-08",
  };
}

function makeDeps(overrides: {
  threads?: ReturnType<typeof makeThread>[];
  listErr?: boolean;
  hasEmbedding?: boolean;
  hasEmbeddingResult?: Result<boolean, DbError>;
  ses?: { verified?: boolean; dkimEnabled?: boolean; accountSendingEnabled?: boolean };
  logger?: MockLogger;
} = {}): { deps: HealthcheckValidatorDeps; logger: MockLogger } {
  const logger = overrides.logger ?? createMockLogger();
  const listResult = overrides.listErr
    ? err({ kind: "db_error", message: "boom" })
    : ok(overrides.threads ?? [makeThread()]);

  const embeddingResult = overrides.hasEmbeddingResult ?? ok(overrides.hasEmbedding ?? true);

  const verified = overrides.ses?.verified ?? true;
  const dkimEnabled = overrides.ses?.dkimEnabled ?? true;
  const accountSendingEnabled = overrides.ses?.accountSendingEnabled ?? true;
  const sesResult = (verified && dkimEnabled && accountSendingEnabled)
    ? { verified, dkimEnabled, accountSendingEnabled }
    : { verified, dkimEnabled, accountSendingEnabled, detail: "SES configuration issue detected." };

  const deps: HealthcheckValidatorDeps = {
    threadDb: {
      listActiveThreadsSince: vi.fn().mockResolvedValue(listResult),
    } as unknown as HealthcheckValidatorDeps["threadDb"],
    searchDatabase: {
      hasEmbedding: vi.fn().mockResolvedValue(embeddingResult),
    },
    sesChecker: {
      canSendFrom: vi.fn().mockResolvedValue(sesResult),
    },
    dnsChecker: { checkDomain },
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
    expect(result.checks).toHaveLength(14);
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

  it("reports a schema-mismatch detail (not a vague miss) when the embedding write hit a missing column", async () => {
    const { deps, logger } = makeDeps({
      threads: [makeThread()],
      hasEmbeddingResult: err(dbError(new Error('column "signal_id" of relation "thread_embeddings" does not exist'))),
    });
    const result = await new HealthcheckValidator(deps).validate("2026-07-08");

    const embedding = checkById(result.checks, "embedding-indexed");
    expect(embedding.status).toBe("fail");
    expect(embedding.detail).toContain("schema mismatch");
    expect(embedding.detail).toContain("signal_id");
    const schemaLog = logger.calls.find(
      (c) => c.method === "error" && c.context?.["code"] === "healthcheck.embedding_check_schema_mismatch",
    );
    expect(schemaLog).toBeDefined();
    expect(schemaLog!.message).toContain("schema mismatch");
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

  it("tags every check with a valid section field", async () => {
    const { deps } = makeDeps({ threads: [makeThread()], hasEmbedding: true });
    const result = await new HealthcheckValidator(deps).validate("2026-07-08");
    const validSections = ["terminus", "delegation", "ses", "pipeline"];
    for (const check of result.checks) {
      expect(validSections).toContain(check.section);
    }
  });

  it("tags delegation checks with section delegation", async () => {
    const { deps } = makeDeps({ threads: [makeThread()], hasEmbedding: true });
    const result = await new HealthcheckValidator(deps).validate("2026-07-08");
    const delegationChecks = result.checks.filter(c => c.section === "delegation");
    expect(delegationChecks.length).toBe(4);
    expect(delegationChecks.every(c => c.id.startsWith("delegation-"))).toBe(true);
  });

  it("reports overall fail when delegation check returns a non-verified record", async () => {
    const { deps } = makeDeps({ threads: [makeThread()], hasEmbedding: true });
    deps.dnsChecker = {
      checkDomain: vi.fn().mockResolvedValue([
        { name: "healthcheck.platform.email.rhosys.cloud", type: "MX", value: "10 mx.platform.email.rhosys.cloud", status: "verified" },
        { name: "mail._domainkey.healthcheck.platform.email.rhosys.cloud", type: "CNAME", value: "mail._domainkey.platform.email.rhosys.cloud", status: "failing", currentValue: "wrong.example.com" },
        { name: "bounce.healthcheck.platform.email.rhosys.cloud", type: "CNAME", value: "bounce.platform.email.rhosys.cloud", status: "verified" },
        { name: "_dmarc.healthcheck.platform.email.rhosys.cloud", type: "CNAME", value: "_dmarc.platform.email.rhosys.cloud", status: "verified" },
      ]),
    };
    const result = await new HealthcheckValidator(deps).validate("2026-07-08");
    expect(result.status).toBe("fail");
    const failedCheck = result.checks.find(c => c.id.includes("delegation") && c.status === "fail");
    expect(failedCheck).toBeDefined();
    expect(failedCheck!.detail).toContain("wrong.example.com");
  });

  it("uses a custom dnsChecker dep when provided", async () => {
    const mockCheckDomain = vi.fn().mockResolvedValue([
      { name: "healthcheck.platform.email.rhosys.cloud", type: "MX", value: "10 mx.platform.email.rhosys.cloud", status: "verified" },
    ]);
    const { deps } = makeDeps({ threads: [makeThread()], hasEmbedding: true });
    deps.dnsChecker = { checkDomain: mockCheckDomain };
    await new HealthcheckValidator(deps).validate("2026-07-08");
    expect(mockCheckDomain).toHaveBeenCalledOnce();
    expect(mockCheckDomain.mock.calls[0]?.[0].domain).toBe("healthcheck.platform.email.rhosys.cloud");
  });

  it("fails ses-sending-enabled and overall status when account-level sending is disabled", async () => {
    const { deps } = makeDeps({ threads: [makeThread()], hasEmbedding: true, ses: { accountSendingEnabled: false } });
    const result = await new HealthcheckValidator(deps).validate("2026-07-08");

    const sending = checkById(result.checks, "ses-sending-enabled");
    expect(sending.status).toBe("fail");
    expect(sending.detail).toBeTruthy();
    expect(checkById(result.checks, "ses-identity-verified").status).toBe("pass");
    expect(checkById(result.checks, "ses-dkim").status).toBe("pass");
    expect(result.status).toBe("fail");
  });

  it("fails ses-dkim when DKIM signing is not enabled", async () => {
    const { deps } = makeDeps({ threads: [makeThread()], hasEmbedding: true, ses: { dkimEnabled: false } });
    const result = await new HealthcheckValidator(deps).validate("2026-07-08");

    const dkim = checkById(result.checks, "ses-dkim");
    expect(dkim.status).toBe("fail");
    expect(dkim.detail).toBeTruthy();
    expect(checkById(result.checks, "ses-identity-verified").status).toBe("pass");
    expect(checkById(result.checks, "ses-sending-enabled").status).toBe("pass");
    expect(result.status).toBe("fail");
  });

  it("fails ses-identity-verified when the SES identity is not verified", async () => {
    const { deps } = makeDeps({ threads: [makeThread()], hasEmbedding: true, ses: { verified: false } });
    const result = await new HealthcheckValidator(deps).validate("2026-07-08");

    const verifiedCheck = checkById(result.checks, "ses-identity-verified");
    expect(verifiedCheck.status).toBe("fail");
    expect(verifiedCheck.detail).toBeTruthy();
    expect(checkById(result.checks, "ses-dkim").status).toBe("pass");
    expect(checkById(result.checks, "ses-sending-enabled").status).toBe("pass");
    expect(result.status).toBe("fail");
  });
});
