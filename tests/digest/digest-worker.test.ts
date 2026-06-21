import { describe, it, expect, vi, beforeEach } from "vitest";
import { DateTime } from "luxon";

// ---------------------------------------------------------------------------
// Env vars must be set before module import (captured at module-load time)
// vi.hoisted runs before vi.mock factories, ensuring env is available.
// ---------------------------------------------------------------------------
vi.hoisted(() => {
  process.env["MAIL_DOMAIN"] = "mail.numaeel.com";
  process.env["APP_BASE_URL"] = "https://app.numaeel.com";
  process.env["API_DOMAIN"] = "api.numaeel.com";
});

import { ok, err, dbError } from "../../src/errors.js";
import { DigestWorker } from "../../src/digest/digest-worker.js";
import type { IDigestWorkerDeps, IDigestSendMessage } from "../../src/digest/digest-worker.js";
import type { Account, Arc, VerifiedForwardingAddress } from "../../src/types/index.js";
import { createMockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/email/unsubscribe-token.js", () => ({
  generateUnsubscribeToken: vi.fn(async () => "mock-jwt-token"),
}));

vi.mock("../../src/email/template-renderer.js", () => ({
  renderTemplate: vi.fn(async () => "<html>rendered</html>"),
}));

// Sunday 2026-06-21 — weekly dispatches qualify
const SUNDAY = DateTime.fromISO("2026-06-21", { zone: "utc" });
// Monday 2026-06-22 — NOT Sunday, NOT 1st
const MONDAY = DateTime.fromISO("2026-06-22", { zone: "utc" });

const ACCOUNT_ID = "acct_test123";
const FORWARDING_TARGET_ID = "ft_target1";
const MESSAGE: IDigestSendMessage = { accountId: ACCOUNT_ID };

function makeAccount(overrides?: Partial<Account>): Account {
  return {
    id: ACCOUNT_ID,
    name: "Test Account",
    digest: { frequency: "daily", forwardingTargetId: FORWARDING_TARGET_ID },
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-06-01T00:00:00Z",
    ...overrides,
  };
}

function makeTarget(overrides?: Partial<VerifiedForwardingAddress>): VerifiedForwardingAddress {
  return {
    id: FORWARDING_TARGET_ID,
    accountId: ACCOUNT_ID,
    address: "user@example.com",
    status: "verified",
    token: "verify-token",
    createdAt: "2025-01-01T00:00:00Z",
    verifiedAt: "2025-01-02T00:00:00Z",
    ...overrides,
  };
}

function makeArc(overrides?: Partial<Arc>): Arc {
  return {
    id: "arc_1",
    accountId: ACCOUNT_ID,
    workflow: "conversation",
    labels: ["inbox"],
    status: "active",
    summary: "Test conversation",
    lastSignalAt: "2026-06-20T10:00:00Z",
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-20T10:00:00Z",
    senderAddress: "sender@example.com",
    recipientAddress: "me@example.com",
    subject: "Hello",
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<IDigestWorkerDeps>): IDigestWorkerDeps {
  return {
    accountDb: {
      getAccount: vi.fn(async () => ok(makeAccount())),
      getVerifiedForwardingAddress: vi.fn(async () => ok(makeTarget())),
    },
    arcDb: {
      listActiveArcs: vi.fn(async () => ok([makeArc()])),
    },
    signalDb: {
      countQuarantined: vi.fn(async () => ok(3)),
    },
    emailService: {
      send: vi.fn(async () => ok({ messageId: "ses-msg-001" })),
    } as unknown as IDigestWorkerDeps["emailService"],
    logger: createMockLogger(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DigestWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("suppresses when account not found (deleted)", async () => {
    const deps = makeDeps({
      accountDb: {
        getAccount: vi.fn(async () => ok(null)),
        getVerifiedForwardingAddress: vi.fn(async () => ok(null)),
      },
    });
    const worker = new DigestWorker(deps);
    const result = await worker.process(MESSAGE, SUNDAY);

    expect(result.isOk()).toBe(true);
    expect(deps.emailService.send).not.toHaveBeenCalled();
  });

  it("suppresses when digest disabled (null)", async () => {
    const deps = makeDeps({
      accountDb: {
        getAccount: vi.fn(async () => ok(makeAccount({ digest: null }))),
        getVerifiedForwardingAddress: vi.fn(async () => ok(makeTarget())),
      },
    });
    const worker = new DigestWorker(deps);
    const result = await worker.process(MESSAGE, SUNDAY);

    expect(result.isOk()).toBe(true);
    expect(deps.emailService.send).not.toHaveBeenCalled();
  });

  it("suppresses when digest never configured (undefined)", async () => {
    const account = makeAccount();
    delete (account as unknown as Record<string, unknown>).digest;
    const deps = makeDeps({
      accountDb: {
        getAccount: vi.fn(async () => ok(account)),
        getVerifiedForwardingAddress: vi.fn(async () => ok(makeTarget())),
      },
    });
    const worker = new DigestWorker(deps);
    const result = await worker.process(MESSAGE, SUNDAY);

    expect(result.isOk()).toBe(true);
    expect(deps.emailService.send).not.toHaveBeenCalled();
  });

  it("suppresses on frequency mismatch (weekly account on Monday = stale retry)", async () => {
    const deps = makeDeps({
      accountDb: {
        getAccount: vi.fn(async () => ok(makeAccount({ digest: { frequency: "weekly", forwardingTargetId: FORWARDING_TARGET_ID } }))),
        getVerifiedForwardingAddress: vi.fn(async () => ok(makeTarget())),
      },
    });
    const worker = new DigestWorker(deps);
    const result = await worker.process(MESSAGE, MONDAY);

    expect(result.isOk()).toBe(true);
    expect(deps.emailService.send).not.toHaveBeenCalled();
  });

  it("suppresses with warning when forwarding target not found", async () => {
    const deps = makeDeps({
      accountDb: {
        getAccount: vi.fn(async () => ok(makeAccount())),
        getVerifiedForwardingAddress: vi.fn(async () => ok(null)),
      },
    });
    const worker = new DigestWorker(deps);
    const result = await worker.process(MESSAGE, SUNDAY);

    expect(result.isOk()).toBe(true);
    expect(deps.emailService.send).not.toHaveBeenCalled();
    const logger = deps.logger as ReturnType<typeof createMockLogger>;
    expect(logger.calls.some((c) => c.method === "warn")).toBe(true);
  });

  it("suppresses with warning when forwarding target is unverified", async () => {
    const deps = makeDeps({
      accountDb: {
        getAccount: vi.fn(async () => ok(makeAccount())),
        getVerifiedForwardingAddress: vi.fn(async () => ok(makeTarget({ status: "pending" }))),
      },
    });
    const worker = new DigestWorker(deps);
    const result = await worker.process(MESSAGE, SUNDAY);

    expect(result.isOk()).toBe(true);
    expect(deps.emailService.send).not.toHaveBeenCalled();
  });

  it("suppresses when zero active arcs", async () => {
    const deps = makeDeps({
      arcDb: { listActiveArcs: vi.fn(async () => ok([])) },
    });
    const worker = new DigestWorker(deps);
    const result = await worker.process(MESSAGE, SUNDAY);

    expect(result.isOk()).toBe(true);
    expect(deps.emailService.send).not.toHaveBeenCalled();
  });

  it("happy path: sends email with correct to, subject, from, tags, and headers", async () => {
    const deps = makeDeps();
    const worker = new DigestWorker(deps);
    const result = await worker.process(MESSAGE, SUNDAY);

    expect(result.isOk()).toBe(true);
    expect(deps.emailService.send).toHaveBeenCalledTimes(1);

    const sendCall = vi.mocked(deps.emailService.send).mock.calls[0]![0];

    // Correct recipient (from forwarding target)
    expect(sendCall.to).toBe("user@example.com");
    // Correct from override (digest from address)
    expect(sendCall.fromOverride).toBe(`"Numaeel Digest" <digest@mail.numaeel.com>`);
    // Subject matches daily format for Sunday
    expect(sendCall.subject).toBe("Daily Numaeel Digest for Sunday");
    // Tags include the trigger ID
    expect(sendCall.tags).toEqual(expect.arrayContaining([
      expect.objectContaining({ Name: "X-Numaeel-AccountId", Value: ACCOUNT_ID.replace(/[^a-z0-9_-]/gi, "").slice(0, 255) }),
      expect.objectContaining({ Name: "X-Numaeel-TriggerId", Value: `digest-${ACCOUNT_ID}-2026-06-21` }),
    ]));
    // Headers include unsubscribe
    expect(sendCall.headers).toEqual(expect.arrayContaining([
      expect.objectContaining({ Name: "List-Unsubscribe" }),
      expect.objectContaining({ Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" }),
    ]));
    // AccountId is passed through
    expect(sendCall.accountId).toBe(ACCOUNT_ID);
  });

  it("propagates DB error from getAccount", async () => {
    const deps = makeDeps({
      accountDb: {
        getAccount: vi.fn(async () => err(dbError("connection failed"))),
        getVerifiedForwardingAddress: vi.fn(async () => ok(null)),
      },
    });
    const worker = new DigestWorker(deps);
    const result = await worker.process(MESSAGE, SUNDAY);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("db_error");
  });

  it("propagates DB error from listActiveArcs", async () => {
    const deps = makeDeps({
      arcDb: { listActiveArcs: vi.fn(async () => err(dbError("timeout"))) },
    });
    const worker = new DigestWorker(deps);
    const result = await worker.process(MESSAGE, SUNDAY);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("db_error");
  });
});
