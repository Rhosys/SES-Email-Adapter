import { describe, it, expect, vi, beforeEach } from "vitest"
import { DateTime } from "luxon"
import { ok } from "neverthrow"
import { err } from "../../src/errors.js"
import { DigestWorker } from "../../src/digest/digest-worker.js"
import type { IDigestWorkerDeps, IDigestSendMessage } from "../../src/digest/digest-worker.js"
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js"
import type { Account, Thread, ForwardingTarget } from "../../src/types/index.js"

vi.mock("../../src/email/template-renderer.js", () => ({
  renderTemplate: vi.fn().mockResolvedValue("<html>digest</html>"),
}))

// Sunday — daily + weekly dispatch; monthly does NOT (21st)
const sunday = DateTime.fromISO("2026-06-21")

function buildAccount(overrides?: Partial<Account>): Account {
  return {
    id: "acct_test1",
    name: "Test Account",
    timezone: "Europe/London",
    digest: { frequency: "daily", forwardingTargetId: "fwd_target1" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

function buildArc(id: string): Thread {
  return {
    id,
    accountId: "acct_test1",
    workflow: "conversation",
    labels: [],
    status: "active",
    summary: `Arc ${id}`,
    lastSignalAt: "2026-06-21T08:00:00Z",
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-21T08:00:00Z",
    sender: { address: "sender@example.com" },
    recipientAddress: "recipient@example.com",
    subject: `Subject for ${id}`,
  }
}

function buildTarget(overrides?: Partial<ForwardingTarget>): ForwardingTarget {
  return {
    id: "fwd_target1",
    accountId: "acct_test1",
    target: "user@example.com",
    type: "email",
    status: "verified",
    token: "tok_abc",
    createdAt: "2026-01-01T00:00:00Z",
    verifiedAt: "2026-01-02T00:00:00Z",
    ...overrides,
  }
}

interface TestDeps extends IDigestWorkerDeps {
  logger: MockLogger
  mockSend: ReturnType<typeof vi.fn>
}

function buildDeps(): TestDeps {
  const logger = createMockLogger()
  const mockSend = vi.fn().mockResolvedValue(ok({ messageId: "ses-msg-001" }))
  return {
    accountDb: {
      getAccount: vi.fn().mockResolvedValue(ok(buildAccount())),
      getForwardingTarget: vi.fn().mockResolvedValue(ok(buildTarget())),
    },
    threadDb: {
      listActiveThreads: vi.fn().mockResolvedValue(ok([buildArc("arc_1"), buildArc("arc_2")])),
    },
    signalDb: {
      countQuarantined: vi.fn().mockResolvedValue(ok(3)),
    },
    emailService: { send: mockSend } as unknown as IDigestWorkerDeps["emailService"],
    unsubscribeTokenGenerator: { generate: vi.fn().mockResolvedValue("tok") } as unknown as IDigestWorkerDeps["unsubscribeTokenGenerator"],
    logger,
    mockSend,
  }
}

const message: IDigestSendMessage = { accountId: "acct_test1" }

describe("DigestWorker — REQ-1.1, REQ-1.4, REQ-0.7", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("suppression: zero active arcs", () => {
    it("does not send email when account has zero arcs", async () => {
      const deps = buildDeps()
      vi.mocked(deps.threadDb.listActiveThreads).mockResolvedValue(ok([]))
      const worker = new DigestWorker(deps)

      const result = await worker.process(message, sunday)

      expect(result.isOk()).toBe(true)
      expect(deps.mockSend).not.toHaveBeenCalled()
      expect(deps.logger.calls.some(c => c.context?.code === "digest.worker.no_threads")).toBe(true)
    })
  })

  describe("account deleted between dispatch and send", () => {
    it("returns ok without sending (no-op)", async () => {
      const deps = buildDeps()
      vi.mocked(deps.accountDb.getAccount).mockResolvedValue(ok(null))
      const worker = new DigestWorker(deps)

      const result = await worker.process(message, sunday)

      expect(result.isOk()).toBe(true)
      expect(deps.mockSend).not.toHaveBeenCalled()
      expect(deps.logger.calls.some(c => c.context?.code === "digest.worker.account_not_found")).toBe(true)
    })
  })

  describe("digest disabled between dispatch and send", () => {
    it("suppresses when digest is null", async () => {
      const deps = buildDeps()
      vi.mocked(deps.accountDb.getAccount).mockResolvedValue(ok(buildAccount({ digest: null })))
      const worker = new DigestWorker(deps)

      const result = await worker.process(message, sunday)

      expect(result.isOk()).toBe(true)
      expect(deps.mockSend).not.toHaveBeenCalled()
      expect(deps.logger.calls.some(c => c.context?.code === "digest.worker.digest_disabled")).toBe(true)
    })

    it("suppresses when digest is absent (never configured)", async () => {
      const deps = buildDeps()
      const account = buildAccount()
      delete account.digest
      vi.mocked(deps.accountDb.getAccount).mockResolvedValue(ok(account))
      const worker = new DigestWorker(deps)

      const result = await worker.process(message, sunday)

      expect(result.isOk()).toBe(true)
      expect(deps.mockSend).not.toHaveBeenCalled()
    })
  })

  describe("frequency mismatch on stale retry", () => {
    it("suppresses weekly digest on a non-Sunday", async () => {
      const monday = DateTime.fromISO("2026-06-22")
      const deps = buildDeps()
      vi.mocked(deps.accountDb.getAccount).mockResolvedValue(ok(buildAccount({ digest: { frequency: "weekly", forwardingTargetId: "fwd_target1" } })))
      const worker = new DigestWorker(deps)

      const result = await worker.process(message, monday)

      expect(result.isOk()).toBe(true)
      expect(deps.mockSend).not.toHaveBeenCalled()
      expect(deps.logger.calls.some(c => c.context?.code === "digest.worker.frequency_mismatch")).toBe(true)
    })

    it("suppresses monthly digest on a non-1st day", async () => {
      const deps = buildDeps()
      vi.mocked(deps.accountDb.getAccount).mockResolvedValue(ok(buildAccount({ digest: { frequency: "monthly", forwardingTargetId: "fwd_target1" } })))
      const worker = new DigestWorker(deps)

      const result = await worker.process(message, sunday) // 21st

      expect(result.isOk()).toBe(true)
      expect(deps.mockSend).not.toHaveBeenCalled()
    })
  })

  describe("forwarding target not found", () => {
    it("suppresses with warning when target is null", async () => {
      const deps = buildDeps()
      vi.mocked(deps.accountDb.getForwardingTarget).mockResolvedValue(ok(null))
      const worker = new DigestWorker(deps)

      const result = await worker.process(message, sunday)

      expect(result.isOk()).toBe(true)
      expect(deps.mockSend).not.toHaveBeenCalled()
      expect(deps.logger.calls.some(c => c.method === "warn" && c.context?.code === "digest.worker.target_invalid")).toBe(true)
    })

    it("suppresses with warning when target is unverified", async () => {
      const deps = buildDeps()
      vi.mocked(deps.accountDb.getForwardingTarget).mockResolvedValue(ok(buildTarget({ status: "pending" })))
      const worker = new DigestWorker(deps)

      const result = await worker.process(message, sunday)

      expect(result.isOk()).toBe(true)
      expect(deps.mockSend).not.toHaveBeenCalled()
      expect(deps.logger.calls.some(c => c.method === "warn")).toBe(true)
    })
  })

  describe("permanent SES error", () => {
    it("returns ok and logs WARN on permanent SES error — no retry", async () => {
      const deps = buildDeps()
      deps.mockSend.mockResolvedValueOnce(err({ kind: "permanent_ses_error", errorName: "MessageRejected", httpStatus: 400, message: "Email address is not verified", cause: new Error("test") }))
      const worker = new DigestWorker(deps)

      const result = await worker.process(message, sunday)

      expect(result.isOk()).toBe(true)
      expect(deps.logger.calls.some(c => c.method === "warn" && c.context?.code === "digest.worker.send_permanent")).toBe(true)
    })
  })

  describe("happy path", () => {
    it("renders template, sends email with correct from/tags/headers", async () => {
      const deps = buildDeps()
      const worker = new DigestWorker(deps)

      const result = await worker.process(message, sunday)

      expect(result.isOk()).toBe(true)
      expect(deps.mockSend).toHaveBeenCalledTimes(1)

      const sendArgs = deps.mockSend.mock.calls[0]![0]
      // Correct recipient from forwarding target
      expect(sendArgs.to).toBe("user@example.com")
      // From override uses digest@ prefix
      expect(sendArgs.fromOverride).toMatch(/^"Numaeel Digest" <digest@/)
      // HTML body from template renderer mock
      expect(sendArgs.htmlBody).toBe("<html>digest</html>")
      // Tags include account ID (sanitized — underscore preserved by [a-z0-9_-])
      expect(sendArgs.tags).toEqual(expect.arrayContaining([
        expect.objectContaining({ Name: "X-Numaeel-AccountId", Value: "acct_test1" }),
      ]))
      // Headers include unsubscribe pair
      expect(sendArgs.headers).toEqual(expect.arrayContaining([
        expect.objectContaining({ Name: "List-Unsubscribe" }),
        expect.objectContaining({ Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" }),
      ]))
      // AccountId passed for SES TenantName
      expect(sendArgs.accountId).toBe("acct_test1")
    })

    it("logs success with messageId and arc count", async () => {
      const deps = buildDeps()
      const worker = new DigestWorker(deps)

      await worker.process(message, sunday)

      expect(deps.logger.calls.some(c =>
        c.context?.code === "digest.worker.sent" && c.context?.threadCount === 2 && c.context?.quarantineCount === 3,
      )).toBe(true)
    })
  })
})
