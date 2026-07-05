import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ThreadDatabase } from "../../src/database/thread-database.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import type { Thread, Signal } from "../../src/types/index.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => { ddbMock.reset(); });
afterEach(() => { ddbMock.restore(); });

// =============================================================================
// Invariant 5: threadId is persisted correctly on new writes (no arcId written)
// For any thread or signal carrying a threadId, the persisted item SHALL carry
// threadId, SHALL NOT carry arcId, and pk uses ACCT#{accountId}#ARC#{id} format.
// **Validates: Requirements 9.1, 9.2, 9.3, 9.10, 10.6, 10.7**
// =============================================================================

describe("Invariant 5: threadId-only write — no arcId persisted on new writes", () => {
  let db: ThreadDatabase;
  beforeEach(() => { db = new ThreadDatabase(createMockLogger()); });

  describe("saveThread", () => {
    it.each([
      { desc: "thread with groupingKey", threadId: "thr-1", accountId: "acct-1", groupingKey: "order-123" as string | undefined },
      { desc: "thread without groupingKey", threadId: "thr-2", accountId: "acct-2", groupingKey: undefined as string | undefined },
    ])("$desc — writes threadId, no arcId, pk = ACCT#...#ARC#...", async ({ threadId, accountId, groupingKey }) => {
      ddbMock.on(PutCommand).resolves({});

      const arc: Thread = {
        id: threadId, accountId,
        ...(groupingKey !== undefined ? { groupingKey } : {}),
        workflow: "conversation", labels: [], status: "active",
        summary: "Test", lastSignalAt: "2024-01-01T00:00:00Z",
        createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
        senderAddress: "a@b.com", recipientAddress: "c@d.com", subject: "Hi",
      };

      await db.saveThread(arc);

      const calls = ddbMock.commandCalls(PutCommand);
      expect(calls).toHaveLength(1);
      const item = calls[0]!.args[0]!.input.Item!;

      expect(item.threadId).toBe(threadId);
      expect(item.arcId).toBeUndefined();
      expect(item.pk).toBe(`ACCT#${accountId}#ARC#${threadId}`);
    });
  });

  describe("saveSignal", () => {
    it.each([
      { desc: "signal with threadId", threadId: "thr-5", accountId: "acct-1" },
      { desc: "signal without threadId (quarantined)", threadId: undefined, accountId: "acct-1" },
    ])("$desc — writes threadId when present, never arcId", async ({ threadId, accountId }) => {
      ddbMock.on(PutCommand).resolves({});

      const signal = {
        id: "sgn-abc", signalLookupId: "ses-msg1", threadId,
        accountId, source: "email", type: "email",
        status: threadId ? "active" : "quarantine_visible",
        labels: [], createdAt: "2024-01-01T00:00:00Z",
        data: { subject: "Test", from: "a@b.com", to: "c@d.com", textBody: "" },
      } as unknown as Signal;

      await db.saveSignal(signal);

      const calls = ddbMock.commandCalls(PutCommand);
      expect(calls).toHaveLength(1);
      const item = calls[0]!.args[0]!.input.Item!;

      if (threadId) {
        expect(item.threadId).toBe(threadId);
      }
      expect(item.arcId).toBeUndefined();
    });
  });

  describe("unblockSignal", () => {
    it("writes threadId attribute, never arcId", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      await db.unblockSignal("acct-1", "ses-msg1", "thr-9");

      const calls = ddbMock.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0]!.input;

      // UpdateExpression sets threadId
      expect(input.UpdateExpression).toContain("threadId");
      expect(input.ExpressionAttributeValues![":threadId"]).toBe("thr-9");
      // arcId is never set
      expect(input.UpdateExpression).not.toContain("arcId");
    });
  });

  describe("updateThread", () => {
    it("writes threadId attribute, never arcId", async () => {
      ddbMock.on(UpdateCommand).resolves({ Attributes: { id: "thr-1", accountId: "acct-1", threadId: "thr-1" } });

      await db.updateThread("acct-1", "thr-1", "active", "2024-01-01T00:00:00Z", {});

      const calls = ddbMock.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0]!.input;

      expect(input.UpdateExpression).toContain("threadId");
      expect(input.ExpressionAttributeValues![":threadId"]).toBe("thr-1");
      expect(input.UpdateExpression).not.toContain("arcId");
      expect(input.Key).toEqual({ pk: "ACCT#acct-1#ARC#thr-1", sk: "#" });
    });
  });

  describe("updateSignalSendStatus", () => {
    it("writes threadId when provided, never arcId", async () => {
      ddbMock.on(UpdateCommand).resolves({ Attributes: { id: "sgn-1", accountId: "acct-1", threadId: "thr-3" } });

      await db.updateSignalSendStatus("acct-1", "ses-msg1", {
        status: "sent",
        threadId: "thr-3",
        gsi3pk: "ACCT#acct-1#MSGID#<abc@x>",
      });

      const calls = ddbMock.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0]!.input;

      expect(input.UpdateExpression).toContain("threadId");
      expect(input.ExpressionAttributeValues![":threadId"]).toBe("thr-3");
      expect(input.UpdateExpression).not.toContain("arcId");
    });
  });
});

// =============================================================================
// Invariant 6: Universal read fallback resolves threadId ?? arcId
// For any stored record shape, resolveThreadId/hydrateThreadObject correctly
// resolves the identifier. Tested through the public DB methods that apply
// the hydration.
// **Validates: Requirements 9.5, 9.6, 9.7, 9.8, 9.9, 10.8**
// =============================================================================

describe("Invariant 6: Universal read fallback resolves threadId ?? arcId", () => {
  let db: ThreadDatabase;
  beforeEach(() => { db = new ThreadDatabase(createMockLogger()); });

  describe("getThread — hydrates threadId from record shape", () => {
    it.each([
      { desc: "threadId only (post-migration)", record: { id: "thr-1", threadId: "thr-1", accountId: "acct-1" }, expected: "thr-1" },
      { desc: "arcId only (pre-migration)", record: { id: "thr-2", arcId: "thr-2", accountId: "acct-1" }, expected: "thr-2" },
      { desc: "both present (threadId wins)", record: { id: "thr-3", threadId: "thr-3", arcId: "old-id", accountId: "acct-1" }, expected: "thr-3" },
      { desc: "neither (unassigned)", record: { id: "thr-4", accountId: "acct-1" }, expected: undefined },
    ])("$desc → threadId=$expected", async ({ record, expected }) => {
      const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
      ddbMock.on(GetCommand).resolves({ Item: record });

      const result = await db.getThread("acct-1", record.id);

      expect(result.isOk()).toBe(true);
      const thread = result._unsafeUnwrap();
      expect(thread).not.toBeNull();
      expect((thread as unknown as Record<string, unknown>).threadId).toBe(expected);
    });
  });

  describe("getSignalById — hydrates threadId on signals", () => {
    it.each([
      { desc: "threadId only", record: { id: "sgn-1", signalLookupId: "ses-1", threadId: "thr-1", accountId: "acct-1" }, expected: "thr-1" },
      { desc: "arcId only (legacy)", record: { id: "sgn-2", signalLookupId: "ses-2", arcId: "thr-2", accountId: "acct-1" }, expected: "thr-2" },
      { desc: "both (threadId preferred)", record: { id: "sgn-3", signalLookupId: "ses-3", threadId: "thr-3", arcId: "old", accountId: "acct-1" }, expected: "thr-3" },
      { desc: "neither (blocked signal)", record: { id: "sgn-4", signalLookupId: "ses-4", accountId: "acct-1" }, expected: undefined },
    ])("$desc → threadId=$expected", async ({ record, expected }) => {
      const { QueryCommand } = await import("@aws-sdk/lib-dynamodb");
      // getSignalById queries gsi1 using the threadId partition
      ddbMock.on(QueryCommand).resolves({ Items: [record] });

      const result = await db.getSignalById("acct-1", record.id, expected ?? "QUARANTINED");

      expect(result.isOk()).toBe(true);
      const signal = result._unsafeUnwrap();
      expect(signal).not.toBeNull();
      expect(signal!.threadId).toBe(expected);
    });
  });
});

// =============================================================================
// Invariant 7: Key attributes unchanged after boundary writes threadId and gsi3pk
// For any write that adds threadId/gsi3pk, the pk/sk/gsi1pk/gsi1sk attributes
// SHALL NOT be altered — they retain their computed values based on ACCT#...#ARC#...
// **Validates: Requirements 9.4, 10.6**
// =============================================================================

describe("Invariant 7: Key attributes unchanged after persistence boundary writes", () => {
  let db: ThreadDatabase;
  beforeEach(() => { db = new ThreadDatabase(createMockLogger()); });

  describe("saveThread — key attributes retain ACCT#...#ARC#... format", () => {
    it.each([
      { accountId: "acct-1", threadId: "thr-1", groupingKey: "gk-1" as string | undefined },
      { accountId: "acct-2", threadId: "thr-2", groupingKey: undefined as string | undefined },
    ])("accountId=$accountId threadId=$threadId — pk, sk, gsi1pk, gsi1sk unaltered", async ({ accountId, threadId, groupingKey }) => {
      ddbMock.on(PutCommand).resolves({});

      const arc: Thread = {
        id: threadId, accountId,
        ...(groupingKey !== undefined ? { groupingKey } : {}),
        workflow: "conversation", labels: [], status: "active",
        summary: "Test", lastSignalAt: "2024-06-01T12:00:00Z",
        createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
        senderAddress: "a@b.com", recipientAddress: "c@d.com", subject: "Hi",
      };

      await db.saveThread(arc);

      const calls = ddbMock.commandCalls(PutCommand);
      const item = calls[0]!.args[0]!.input.Item!;

      expect(item.pk).toBe(`ACCT#${accountId}#ARC#${threadId}`);
      expect(item.sk).toBe("#");
      expect(item.gsi1pk).toBe(`ACCT#${accountId}`);
      expect(item.gsi1sk).toBe(`LASTACT#active#2024-06-01T12:00:00Z#${threadId}`);
    });
  });

  describe("updateThread — key attributes use ACCT#...#ARC#... pk format", () => {
    it.each([
      { accountId: "acct-1", threadId: "thr-1" },
      { accountId: "acct-3", threadId: "thr-99" },
    ])("accountId=$accountId threadId=$threadId — Key.pk retains format", async ({ accountId, threadId }) => {
      ddbMock.on(UpdateCommand).resolves({ Attributes: { id: threadId, accountId, threadId } });

      await db.updateThread(accountId, threadId, "active", "2024-01-01T00:00:00Z", {});

      const calls = ddbMock.commandCalls(UpdateCommand);
      const input = calls[0]!.args[0]!.input;

      expect(input.Key).toEqual({ pk: `ACCT#${accountId}#ARC#${threadId}`, sk: "#" });
      // gsi1sk is updated but retains the expected format
      expect(input.ExpressionAttributeValues![":gsi1sk"]).toBe(`LASTACT#active#2024-01-01T00:00:00Z#${threadId}`);
    });
  });

  describe("saveSignal — key attributes retain proper format", () => {
    it.each([
      { accountId: "acct-1", threadId: "thr-7", signalLookupId: "ses-msg1" },
      { accountId: "acct-2", threadId: "thr-8", signalLookupId: "sgn-abc" },
    ])("accountId=$accountId — pk uses SIG format, gsi1pk uses ARC format", async ({ accountId, threadId, signalLookupId }) => {
      ddbMock.on(PutCommand).resolves({});

      const signal = {
        id: "sgn-x", signalLookupId, threadId,
        accountId, source: "email", type: "email", status: "active",
        labels: [], createdAt: "2024-01-01T00:00:00Z",
        data: { subject: "Test", from: "a@b.com", to: "c@d.com", textBody: "" },
      } as unknown as Signal;

      await db.saveSignal(signal);

      const calls = ddbMock.commandCalls(PutCommand);
      const item = calls[0]!.args[0]!.input.Item!;

      expect(item.pk).toBe(`ACCT#${accountId}#SIG#${signalLookupId}`);
      expect(item.sk).toBe("#");
      expect(item.gsi1pk).toBe(`ACCT#${accountId}#ARC#${threadId}`);
    });
  });
});

// =============================================================================
// Invariant 8: gsi3pk format at write sites; no gsi2pk present
// Signal ingestion, send, and thread-save write gsi3pk with correct format.
// No gsi2pk attribute is written anywhere.
// **Validates: Requirements 12.4, 12.5, 12.6, 12.7, 12.8**
// =============================================================================

describe("Invariant 8: gsi3pk written at correct write sites, no gsi2pk", () => {
  let db: ThreadDatabase;
  beforeEach(() => { db = new ThreadDatabase(createMockLogger()); });

  describe("saveThread — writes gsi3pk = ACCT#...#GKEY#... when groupingKey present", () => {
    it.each([
      { accountId: "acct-1", threadId: "thr-1", groupingKey: "order-456", expectedGsi3pk: "ACCT#acct-1#GKEY#order-456" },
      { accountId: "acct-2", threadId: "thr-2", groupingKey: "sub:xyz", expectedGsi3pk: "ACCT#acct-2#GKEY#sub:xyz" },
    ])("groupingKey=$groupingKey → gsi3pk=$expectedGsi3pk, no gsi2pk", async ({ accountId, threadId, groupingKey, expectedGsi3pk }) => {
      ddbMock.on(PutCommand).resolves({});

      const arc: Thread = {
        id: threadId, accountId, groupingKey,
        workflow: "conversation", labels: [], status: "active",
        summary: "Test", lastSignalAt: "2024-01-01T00:00:00Z",
        createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
        senderAddress: "a@b.com", recipientAddress: "c@d.com", subject: "Hi",
      };

      await db.saveThread(arc);

      const calls = ddbMock.commandCalls(PutCommand);
      const item = calls[0]!.args[0]!.input.Item!;

      expect(item.gsi3pk).toBe(expectedGsi3pk);
      expect(item.gsi2pk).toBeUndefined();
    });

    it("no groupingKey → no gsi3pk, no gsi2pk", async () => {
      ddbMock.on(PutCommand).resolves({});

      const arc: Thread = {
        id: "thr-no-gk", accountId: "acct-1",
        workflow: "conversation", labels: [], status: "active",
        summary: "Test", lastSignalAt: "2024-01-01T00:00:00Z",
        createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
        senderAddress: "a@b.com", recipientAddress: "c@d.com", subject: "Hi",
      };

      await db.saveThread(arc);

      const calls = ddbMock.commandCalls(PutCommand);
      const item = calls[0]!.args[0]!.input.Item!;

      expect(item.gsi3pk).toBeUndefined();
      expect(item.gsi2pk).toBeUndefined();
    });
  });

  describe("updateSignalSendStatus — writes gsi3pk = ACCT#...#MSGID#..., no gsi2pk", () => {
    it.each([
      { accountId: "acct-1", msgId: "<abc@example.com>", expectedGsi3pk: "ACCT#acct-1#MSGID#<abc@example.com>" },
      { accountId: "acct-2", msgId: "<def@mail.org>", expectedGsi3pk: "ACCT#acct-2#MSGID#<def@mail.org>" },
    ])("msgId=$msgId → gsi3pk=$expectedGsi3pk, no gsi2pk", async ({ accountId, msgId, expectedGsi3pk }) => {
      ddbMock.on(UpdateCommand).resolves({ Attributes: { id: "sgn-1", accountId } });

      await db.updateSignalSendStatus(accountId, "ses-msg1", {
        status: "sent",
        gsi3pk: expectedGsi3pk,
        threadId: "thr-1",
      });

      const calls = ddbMock.commandCalls(UpdateCommand);
      const input = calls[0]!.args[0]!.input;

      expect(input.ExpressionAttributeValues![":gsi3pk"]).toBe(expectedGsi3pk);
      expect(input.UpdateExpression).toContain("gsi3pk");
      expect(input.UpdateExpression).not.toContain("gsi2pk");
      // No gsi2pk in values
      expect(input.ExpressionAttributeValues![":gsi2pk"]).toBeUndefined();
    });
  });

  describe("saveSignal — carries gsi3pk from signal object when present, no gsi2pk", () => {
    it.each([
      { accountId: "acct-1", gsi3pk: "ACCT#acct-1#MSGID#<msg@x.com>", desc: "with gsi3pk" },
      { accountId: "acct-2", gsi3pk: undefined, desc: "without gsi3pk" },
    ])("$desc — never writes gsi2pk", async ({ accountId, gsi3pk }) => {
      ddbMock.on(PutCommand).resolves({});

      const signal = {
        id: "sgn-x", signalLookupId: "ses-msg1", threadId: "thr-1",
        accountId, source: "email", type: "email", status: "active",
        labels: [], createdAt: "2024-01-01T00:00:00Z",
        ...(gsi3pk ? { gsi3pk } : {}),
        data: { subject: "Test", from: "a@b.com", to: "c@d.com", textBody: "" },
      } as unknown as Signal;

      await db.saveSignal(signal);

      const calls = ddbMock.commandCalls(PutCommand);
      const item = calls[0]!.args[0]!.input.Item!;

      if (gsi3pk) {
        expect(item.gsi3pk).toBe(gsi3pk);
      }
      expect(item.gsi2pk).toBeUndefined();
    });
  });
});
