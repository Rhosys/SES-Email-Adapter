import { describe, it, expect, vi } from "vitest"
import { DateTime } from "luxon"
import { ok } from "neverthrow"
import { DigestDispatcher } from "../../src/digest/digest-dispatcher.js"
import type { IAccountMetaRow, IDigestDispatcherDeps } from "../../src/digest/digest-dispatcher.js"
import { dbError } from "../../src/errors.js"
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js"

// Monday — daily dispatches, weekly does NOT, monthly does NOT (22nd)
const monday = DateTime.fromISO("2026-06-22")

interface TestDeps extends IDigestDispatcherDeps {
  mockSqsSend: ReturnType<typeof vi.fn>
  logger: MockLogger
}

function buildDeps(overrides?: Partial<IDigestDispatcherDeps>): TestDeps {
  const logger = createMockLogger()
  const mockSqsSend = vi.fn().mockResolvedValue({ Successful: [{ Id: "0" }], Failed: [] })
  const base: TestDeps = {
    accountDb: { queryAllAccountMetas: vi.fn().mockResolvedValue(ok([])) },
    sqsClient: { send: mockSqsSend } as unknown as IDigestDispatcherDeps["sqsClient"],
    queueUrl: "https://sqs.eu-central-1.amazonaws.com/123456789/signals",
    logger,
    mockSqsSend,
  }
  if (overrides) {
    Object.assign(base, overrides)
  }
  return base
}

describe("DigestDispatcher — REQ-1.3", () => {
  describe("filtering accounts by digest state", () => {
    it("only enqueues daily accounts on a Monday (weekly + null excluded)", async () => {
      const accounts: IAccountMetaRow[] = [
        { id: "acct_daily1", digest: { frequency: "daily", forwardingTargetId: "t1" } },
        { id: "acct_daily2", digest: { frequency: "daily", forwardingTargetId: "t2" } },
        { id: "acct_weekly", digest: { frequency: "weekly", forwardingTargetId: "t3" } },
        { id: "acct_monthly", digest: { frequency: "monthly", forwardingTargetId: "t4" } },
        { id: "acct_null", digest: null },
        { id: "acct_undef" },
      ]

      const deps = buildDeps({
        accountDb: { queryAllAccountMetas: vi.fn().mockResolvedValue(ok(accounts)) },
      })
      const dispatcher = new DigestDispatcher(deps)

      const result = await dispatcher.dispatch(monday)

      expect(result.isOk()).toBe(true)
      expect(deps.mockSqsSend).toHaveBeenCalledTimes(1)

      const command = deps.mockSqsSend.mock.calls[0]![0]
      const entries = command.input.Entries
      expect(entries).toHaveLength(2)
      expect(JSON.parse(entries[0].MessageBody)).toEqual({ accountId: "acct_daily1" })
      expect(JSON.parse(entries[1].MessageBody)).toEqual({ accountId: "acct_daily2" })
    })
  })

  describe("zero qualifying accounts", () => {
    it("returns ok without sending to SQS", async () => {
      const accounts: IAccountMetaRow[] = [
        { id: "acct_weekly", digest: { frequency: "weekly", forwardingTargetId: "t1" } },
        { id: "acct_null", digest: null },
      ]

      const deps = buildDeps({
        accountDb: { queryAllAccountMetas: vi.fn().mockResolvedValue(ok(accounts)) },
      })
      const dispatcher = new DigestDispatcher(deps)

      const result = await dispatcher.dispatch(monday)

      expect(result.isOk()).toBe(true)
      expect(deps.mockSqsSend).not.toHaveBeenCalled()
    })
  })

  describe("SQS batch send throws", () => {
    it("returns err when sqsClient.send throws", async () => {
      const accounts: IAccountMetaRow[] = [
        { id: "acct_daily", digest: { frequency: "daily", forwardingTargetId: "t1" } },
      ]

      const deps = buildDeps({
        accountDb: { queryAllAccountMetas: vi.fn().mockResolvedValue(ok(accounts)) },
      })
      deps.mockSqsSend.mockRejectedValueOnce(new Error("SQS unavailable"))
      const dispatcher = new DigestDispatcher(deps)

      const result = await dispatcher.dispatch(monday)

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().kind).toBe("db_error")
    })
  })

  describe("SQS batch partial failure", () => {
    it("returns err when result.Failed is non-empty", async () => {
      const accounts: IAccountMetaRow[] = [
        { id: "acct_daily", digest: { frequency: "daily", forwardingTargetId: "t1" } },
      ]

      const deps = buildDeps({
        accountDb: { queryAllAccountMetas: vi.fn().mockResolvedValue(ok(accounts)) },
      })
      deps.mockSqsSend.mockResolvedValueOnce({
        Successful: [],
        Failed: [{ Id: "0", Code: "InternalError", Message: "Something went wrong", SenderFault: false }],
      })
      const dispatcher = new DigestDispatcher(deps)

      const result = await dispatcher.dispatch(monday)

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().kind).toBe("db_error")
      expect(result._unsafeUnwrapErr().message).toContain("partial failure")
    })
  })

  describe("happy path — multiple accounts batched correctly", () => {
    it("enqueues correct messages with messageType attribute and accountId body", async () => {
      const accounts: IAccountMetaRow[] = Array.from({ length: 3 }, (_, i) => ({
        id: `acct_${i}`,
        digest: { frequency: "daily" as const, forwardingTargetId: `t${i}` },
      }))

      const deps = buildDeps({
        accountDb: { queryAllAccountMetas: vi.fn().mockResolvedValue(ok(accounts)) },
      })
      const dispatcher = new DigestDispatcher(deps)

      const result = await dispatcher.dispatch(monday)

      expect(result.isOk()).toBe(true)
      expect(deps.mockSqsSend).toHaveBeenCalledTimes(1)

      const command = deps.mockSqsSend.mock.calls[0]![0]
      const entries = command.input.Entries
      expect(entries).toHaveLength(3)

      for (let i = 0; i < 3; i++) {
        expect(entries[i].Id).toBe(`${i}`)
        expect(JSON.parse(entries[i].MessageBody)).toEqual({ accountId: `acct_${i}` })
        expect(entries[i].MessageAttributes.messageType).toEqual({
          DataType: "String",
          StringValue: "digest_send",
        })
      }
    })

    it("batches in groups of 10 when more than 10 qualifying accounts", async () => {
      const accounts: IAccountMetaRow[] = Array.from({ length: 12 }, (_, i) => ({
        id: `acct_${i}`,
        digest: { frequency: "daily" as const, forwardingTargetId: `t${i}` },
      }))

      const deps = buildDeps({
        accountDb: { queryAllAccountMetas: vi.fn().mockResolvedValue(ok(accounts)) },
      })
      const dispatcher = new DigestDispatcher(deps)

      const result = await dispatcher.dispatch(monday)

      expect(result.isOk()).toBe(true)
      expect(deps.mockSqsSend).toHaveBeenCalledTimes(2)

      const firstBatch = deps.mockSqsSend.mock.calls[0]![0].input.Entries
      const secondBatch = deps.mockSqsSend.mock.calls[1]![0].input.Entries
      expect(firstBatch).toHaveLength(10)
      expect(secondBatch).toHaveLength(2)
    })
  })

  describe("queryAllAccountMetas failure", () => {
    it("propagates db error from account query", async () => {
      const deps = buildDeps()
      const queryMock = vi.fn().mockResolvedValue({ isErr: () => true, isOk: () => false, error: dbError(new Error("DDB timeout")) })
      deps.accountDb = { queryAllAccountMetas: queryMock }
      const dispatcher = new DigestDispatcher(deps)

      const result = await dispatcher.dispatch(monday)

      expect(result.isErr()).toBe(true)
      expect(deps.mockSqsSend).not.toHaveBeenCalled()
    })
  })
})
