import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { DateTime } from "luxon";

import { ok, err, dbError } from "../../src/errors.js";
import { DigestDispatcher } from "../../src/digest/digest-dispatcher.js";
import type { IAccountMetaRow, IDigestDispatcherDeps } from "../../src/digest/digest-dispatcher.js";
import { createMockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const sqsMock = mockClient(SQSClient);

function makeDeps(accounts: IAccountMetaRow[]): IDigestDispatcherDeps {
  return {
    accountDb: { queryAllAccountMetas: async () => ok(accounts) },
    sqsClient: sqsMock as unknown as SQSClient,
    queueUrl: "https://sqs.eu-central-1.amazonaws.com/123456789/signals",
    logger: createMockLogger(),
  };
}

// Sunday 2026-06-21 — weekly dispatches on Sundays
const SUNDAY = DateTime.fromISO("2026-06-21", { zone: "utc" });
// Monday 2026-06-22 — NOT Sunday, NOT 1st
const MONDAY = DateTime.fromISO("2026-06-22", { zone: "utc" });
// 1st of month (Wednesday 2026-07-01)
const FIRST_OF_MONTH = DateTime.fromISO("2026-07-01", { zone: "utc" });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DigestDispatcher", () => {
  beforeEach(() => {
    sqsMock.reset();
    sqsMock.on(SendMessageBatchCommand).resolves({ Successful: [], Failed: [] });
  });

  it("enqueues only accounts with matching frequency on Sunday (daily + weekly qualify)", async () => {
    const accounts: IAccountMetaRow[] = [
      { id: "acct-daily", digest: { frequency: "daily", forwardingTargetId: "t1" } },
      { id: "acct-weekly", digest: { frequency: "weekly", forwardingTargetId: "t2" } },
      { id: "acct-monthly", digest: { frequency: "monthly", forwardingTargetId: "t3" } },
      { id: "acct-none", digest: null },
      { id: "acct-undefined" },
    ];

    const dispatcher = new DigestDispatcher(makeDeps(accounts));
    const result = await dispatcher.dispatch(SUNDAY);

    expect(result.isOk()).toBe(true);

    const calls = sqsMock.commandCalls(SendMessageBatchCommand);
    expect(calls).toHaveLength(1);

    const entries = calls[0]!.args[0].input.Entries!;
    expect(entries).toHaveLength(2);

    const bodies = entries.map((e) => JSON.parse(e.MessageBody!));
    expect(bodies).toEqual([
      { accountId: "acct-daily" },
      { accountId: "acct-weekly" },
    ]);
  });

  it("enqueues only daily accounts on a non-Sunday, non-1st day", async () => {
    const accounts: IAccountMetaRow[] = [
      { id: "acct-daily", digest: { frequency: "daily", forwardingTargetId: "t1" } },
      { id: "acct-weekly", digest: { frequency: "weekly", forwardingTargetId: "t2" } },
      { id: "acct-monthly", digest: { frequency: "monthly", forwardingTargetId: "t3" } },
    ];

    const dispatcher = new DigestDispatcher(makeDeps(accounts));
    const result = await dispatcher.dispatch(MONDAY);

    expect(result.isOk()).toBe(true);

    const calls = sqsMock.commandCalls(SendMessageBatchCommand);
    expect(calls).toHaveLength(1);

    const entries = calls[0]!.args[0].input.Entries!;
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]!.MessageBody!)).toEqual({ accountId: "acct-daily" });
  });

  it("enqueues daily + monthly on the 1st of month", async () => {
    const accounts: IAccountMetaRow[] = [
      { id: "acct-daily", digest: { frequency: "daily", forwardingTargetId: "t1" } },
      { id: "acct-weekly", digest: { frequency: "weekly", forwardingTargetId: "t2" } },
      { id: "acct-monthly", digest: { frequency: "monthly", forwardingTargetId: "t3" } },
    ];

    const dispatcher = new DigestDispatcher(makeDeps(accounts));
    const result = await dispatcher.dispatch(FIRST_OF_MONTH);

    expect(result.isOk()).toBe(true);

    const calls = sqsMock.commandCalls(SendMessageBatchCommand);
    expect(calls).toHaveLength(1);

    const entries = calls[0]!.args[0].input.Entries!;
    const bodies = entries.map((e) => JSON.parse(e.MessageBody!));
    expect(bodies).toEqual([
      { accountId: "acct-daily" },
      { accountId: "acct-monthly" },
    ]);
  });

  it("returns ok and makes no SQS calls when no accounts qualify", async () => {
    const accounts: IAccountMetaRow[] = [
      { id: "acct-none", digest: null },
      { id: "acct-undefined" },
      { id: "acct-weekly", digest: { frequency: "weekly", forwardingTargetId: "t1" } },
    ];

    const dispatcher = new DigestDispatcher(makeDeps(accounts));
    // Monday — weekly doesn't qualify
    const result = await dispatcher.dispatch(MONDAY);

    expect(result.isOk()).toBe(true);
    expect(sqsMock.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
  });

  it("returns err when SQS batch send throws", async () => {
    sqsMock.reset();
    sqsMock.on(SendMessageBatchCommand).rejects(new Error("SQS unavailable"));

    const accounts: IAccountMetaRow[] = [
      { id: "acct-daily", digest: { frequency: "daily", forwardingTargetId: "t1" } },
    ];

    const dispatcher = new DigestDispatcher(makeDeps(accounts));
    const result = await dispatcher.dispatch(SUNDAY);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("db_error");
  });

  it("returns err when SQS batch has partial failures", async () => {
    sqsMock.reset();
    sqsMock.on(SendMessageBatchCommand).resolves({
      Successful: [{ Id: "0", MessageId: "msg-0", MD5OfMessageBody: "abc" }],
      Failed: [{ Id: "1", Code: "InternalError", SenderFault: false, Message: "Something went wrong" }],
    });

    const accounts: IAccountMetaRow[] = [
      { id: "acct-1", digest: { frequency: "daily", forwardingTargetId: "t1" } },
      { id: "acct-2", digest: { frequency: "daily", forwardingTargetId: "t2" } },
    ];

    const dispatcher = new DigestDispatcher(makeDeps(accounts));
    const result = await dispatcher.dispatch(SUNDAY);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("db_error");
    expect(result._unsafeUnwrapErr().message).toContain("partial failure");
  });

  it("returns err when accountDb query fails", async () => {
    const deps: IDigestDispatcherDeps = {
      accountDb: { queryAllAccountMetas: async () => err(dbError("connection timeout")) },
      sqsClient: sqsMock as unknown as SQSClient,
      queueUrl: "https://sqs.eu-central-1.amazonaws.com/123456789/signals",
      logger: createMockLogger(),
    };

    const dispatcher = new DigestDispatcher(deps);
    const result = await dispatcher.dispatch(SUNDAY);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("db_error");
  });

  it("batches accounts into groups of 10 for SQS", async () => {
    const accounts: IAccountMetaRow[] = Array.from({ length: 12 }, (_, i) => ({
      id: `acct-${i}`,
      digest: { frequency: "daily" as const, forwardingTargetId: `t${i}` },
    }));

    const dispatcher = new DigestDispatcher(makeDeps(accounts));
    const result = await dispatcher.dispatch(SUNDAY);

    expect(result.isOk()).toBe(true);

    const calls = sqsMock.commandCalls(SendMessageBatchCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args[0].input.Entries!).toHaveLength(10);
    expect(calls[1]!.args[0].input.Entries!).toHaveLength(2);
  });

  it("sets messageType attribute to digest_send on enqueued messages", async () => {
    const accounts: IAccountMetaRow[] = [
      { id: "acct-daily", digest: { frequency: "daily", forwardingTargetId: "t1" } },
    ];

    const dispatcher = new DigestDispatcher(makeDeps(accounts));
    await dispatcher.dispatch(SUNDAY);

    const calls = sqsMock.commandCalls(SendMessageBatchCommand);
    const entry = calls[0]!.args[0].input.Entries![0]!;
    expect(entry.MessageAttributes).toEqual({
      messageType: { DataType: "String", StringValue: "digest_send" },
    });
  });
});
