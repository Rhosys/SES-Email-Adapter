import { describe, it, expect, vi } from "vitest"
import { DateTime } from "luxon"
import { ok } from "neverthrow"
import { DigestDispatcher } from "../../src/digest/digest-dispatcher.js"
import type { IAccountMetaRow, IDigestDispatcherDeps } from "../../src/digest/digest-dispatcher.js"
import { dbError } from "../../src/errors.js"
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js"
import type { SignalQueue } from "../../src/messaging/signal-queue.js"

// Monday — daily dispatches, weekly does NOT, monthly does NOT (22nd)
const monday = DateTime.fromISO("2026-06-22")

interface TestDeps extends IDigestDispatcherDeps {
  mockSendBatch: ReturnType<typeof vi.fn>
  logger: MockLogger
}

function buildDeps(overrides?: Partial<IDigestDispatcherDeps>): TestDeps {
  const logger = createMockLogger()
  const mockSendBatch = vi.fn().mockResolvedValue(ok(undefined))
  const base: TestDeps = {
    accountDb: { queryAllAccountMetas: vi.fn().mockResolvedValue(ok([])) },
    signalQueue: { send: vi.fn().mockResolvedValue(ok(undefined)), sendBatch: mockSendBatch } as unknown as SignalQueue,
    logger,
    mockSendBatch,
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
      expect(deps.mockSendBatch).toHaveBeenCalledTimes(1)

      const call = deps.mockSendBatch.mock.calls[0]!
      const entries = call[1] as Array<{ id: string; payload: unknown }>
      expect(entries).toHaveLength(2)
      expect(entries[0]!.payload).toEqual({ accountId: "acct_daily1" })
      expect(entries[1]!.payload).toEqual({ accountId: "acct_daily2" })
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
      expect(deps.mockSendBatch).not.toHaveBeenCalled()
    })
  })

  describe("SQS batch send throws", () => {
    it("returns err when signalQueue.sendBatch returns err", async () => {
      const accounts: IAccountMetaRow[] = [
        { id: "acct_daily", digest: { frequency: "daily", forwardingTargetId: "t1" } },
      ]

      const deps = buildDeps({
        accountDb: { queryAllAccountMetas: vi.fn().mockResolvedValue(ok(accounts)) },
      })
      const { err: neverthrowErr } = await import("neverthrow")
      deps.mockSendBatch.mockResolvedValueOnce(neverthrowErr(dbError(new Error("SQS unavailable"))))
      const dispatcher = new DigestDispatcher(deps)

      const result = await dispatcher.dispatch(monday)

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().kind).toBe("db_error")
    })
  })

  describe("SQS batch partial failure", () => {
    it("returns err when sendBatch returns err", async () => {
      const accounts: IAccountMetaRow[] = [
        { id: "acct_daily", digest: { frequency: "daily", forwardingTargetId: "t1" } },
      ]

      const deps = buildDeps({
        accountDb: { queryAllAccountMetas: vi.fn().mockResolvedValue(ok(accounts)) },
      })
      const { err: neverthrowErr } = await import("neverthrow")
      deps.mockSendBatch.mockResolvedValueOnce(neverthrowErr(dbError(new Error("SQS batch send partial failure: 1 messages failed"))))
      const dispatcher = new DigestDispatcher(deps)

      const result = await dispatcher.dispatch(monday)

      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().kind).toBe("db_error")
    })
  })

  describe("happy path — multiple accounts batched correctly", () => {
    it("enqueues correct messages with messageType and accountId body", async () => {
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
      expect(deps.mockSendBatch).toHaveBeenCalledTimes(1)

      const call = deps.mockSendBatch.mock.calls[0]!
      // sendBatch is called with (messageType, entries)
      expect(call[0]).toBe("digest_send")
      const entries = call[1] as Array<{ id: string; payload: unknown }>
      expect(entries).toHaveLength(3)

      for (let i = 0; i < 3; i++) {
        expect(entries[i]!.id).toBe(`${i}`)
        expect(entries[i]!.payload).toEqual({ accountId: `acct_${i}` })
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
      expect(deps.mockSendBatch).toHaveBeenCalledTimes(2)

      const firstBatch = deps.mockSendBatch.mock.calls[0]![1] as Array<{ id: string; payload: unknown }>
      const secondBatch = deps.mockSendBatch.mock.calls[1]![1] as Array<{ id: string; payload: unknown }>
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
      expect(deps.mockSendBatch).not.toHaveBeenCalled()
    })
  })
})
