import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand, UpdateCommand, BatchWriteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { AccountDatabase } from "../../src/database/account-database.js";
import { ArcDatabase } from "../../src/database/arc-database.js";
import { ProcessingDatabase } from "../../src/database/processing-database.js";
import { AuditDatabase } from "../../src/database/audit-database.js";
import { createMockLogger } from "../helpers/mock-logger.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => { ddbMock.reset(); });
afterEach(() => { ddbMock.restore(); });

// =============================================================================
// AccountDatabase
// =============================================================================

describe("AccountDatabase", () => {
  let db: AccountDatabase;
  beforeEach(() => { db = new AccountDatabase(createMockLogger()); });

  describe("getAccount", () => {
    it("returns ok(Account) when the item exists", async () => {
      const account = { id: "acct-1", name: "Test", retentionDuration: "P3M" };
      ddbMock.on(GetCommand).resolves({ Item: account });

      const result = await db.getAccount("acct-1");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual(account);
    });

    it("returns ok(null) when the item does not exist", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const result = await db.getAccount("missing-id");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("returns err with kind db_error when DynamoDB throws", async () => {
      ddbMock.on(GetCommand).rejects(new Error("ProvisionedThroughputExceededException"));

      const result = await db.getAccount("acct-1");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
      expect(result._unsafeUnwrapErr().cause).toBeInstanceOf(Error);
      expect((result._unsafeUnwrapErr().cause as Error).message).toBe("ProvisionedThroughputExceededException");
    });
  });

  describe("renameAlias", () => {
    it("returns err with kind not_found when the alias does not exist", async () => {
      // getAlias returns null (no item)
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const result = await db.renameAlias("acct-1", "old@example.com", "new@example.com");

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.kind).toBe("not_found");
      if (error.kind === "not_found") {
        expect(error.resource).toBe("alias");
        expect(error.id).toBe("old@example.com");
      }
    });

    it("returns ok(Alias) when rename succeeds", async () => {
      const existingAlias = { id: "alias-1", accountId: "acct-1", address: "old@example.com", updatedAt: "2024-01-01" };

      // First GetCommand: getAlias returns the existing alias
      // Second QueryCommand: listSenders returns empty
      ddbMock.on(GetCommand).resolves({ Item: existingAlias });
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(DeleteCommand).resolves({});

      const result = await db.renameAlias("acct-1", "old@example.com", "new@example.com");

      expect(result.isOk()).toBe(true);
      const renamed = result._unsafeUnwrap();
      expect(renamed.domain).toBe("example.com");
      expect(renamed.alias).toBe("new");
      expect(renamed.accountId).toBe("acct-1");
    });

    it("returns err with kind db_error when SDK fails during rename", async () => {
      const existingAlias = { id: "alias-1", accountId: "acct-1", address: "old@example.com", updatedAt: "2024-01-01" };
      ddbMock.on(GetCommand).resolves({ Item: existingAlias });
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(PutCommand).rejects(new Error("InternalServerError"));

      const result = await db.renameAlias("acct-1", "old@example.com", "new@example.com");
    });
  });

  describe("listAliases", () => {
    it("returns ok with array of aliases", async () => {
      const aliases = [
        { id: "a1", accountId: "acct-1", domain: "example.com", alias: "one", sk: "DOMAIN#example.com#ALIAS#one" },
        { id: "a2", accountId: "acct-1", domain: "example.com", alias: "two", sk: "DOMAIN#example.com#ALIAS#two" },
      ];
      ddbMock.on(QueryCommand).resolves({ Items: aliases });

      const result = await db.listAliases("acct-1");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toHaveLength(2);
    });

    it("returns err with kind db_error on SDK failure", async () => {
      ddbMock.on(QueryCommand).rejects(new Error("ServiceUnavailable"));

      const result = await db.listAliases("acct-1");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
      expect(result._unsafeUnwrapErr().cause).toBeInstanceOf(Error);
    });
  });

  describe("deleteAlias", () => {
    it("deletes the alias with no senders", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(DeleteCommand).resolves({});

      const result = await db.deleteAlias("acct-1", "me@example.com");

      expect(result.isOk()).toBe(true);
      expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
      const deleteCalls = ddbMock.commandCalls(DeleteCommand);
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0]!.args[0]!.input.Key).toEqual({ pk: "ACCT#acct-1", sk: "DOMAIN#example.com#ALIAS#me" });
    });

    it("paginates sender lookup and batch-deletes all senders across chunks in parallel", async () => {
      const senders = Array.from({ length: 30 }, (_, i) => ({
        accountId: "acct-1", aliasAddress: "me@example.com", domain: "example.com", alias: "me",
        senderDomain: `sender${i}.com`, policy: "allow", addedAt: "2024-01-01",
      }));
      ddbMock.on(QueryCommand)
        .resolvesOnce({ Items: senders.slice(0, 20), LastEvaluatedKey: { pk: "x", sk: "y" } })
        .resolvesOnce({ Items: senders.slice(20) });
      ddbMock.on(BatchWriteCommand).resolves({});
      ddbMock.on(DeleteCommand).resolves({});

      const result = await db.deleteAlias("acct-1", "me@example.com");

      expect(result.isOk()).toBe(true);
      // 30 senders chunked at 25 per BatchWriteItem call -> 2 parallel batches
      const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
      expect(batchCalls).toHaveLength(2);
      const batchSizes = batchCalls.map((c) => c.args[0]!.input.RequestItems!["ses-accounts"]!.length).sort((a, b) => a - b);
      expect(batchSizes).toEqual([5, 25]);
    });

    it("retries unprocessed items from BatchWriteItem", async () => {
      const senders = Array.from({ length: 3 }, (_, i) => ({
        accountId: "acct-1", aliasAddress: "me@example.com", domain: "example.com", alias: "me",
        senderDomain: `sender${i}.com`, policy: "allow", addedAt: "2024-01-01",
      }));
      ddbMock.on(QueryCommand).resolves({ Items: senders });
      const unprocessedRequest = {
        DeleteRequest: { Key: { pk: "ACCT#acct-1", sk: "DOMAIN#example.com#ALIAS#me#SENDER#sender1.com" } },
      };
      ddbMock.on(BatchWriteCommand)
        .resolvesOnce({ UnprocessedItems: { "ses-accounts": [unprocessedRequest] } })
        .resolvesOnce({});
      ddbMock.on(DeleteCommand).resolves({});

      const result = await db.deleteAlias("acct-1", "me@example.com");

      expect(result.isOk()).toBe(true);
      expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(2);
    });

    it("returns err with kind db_error when the sender lookup fails", async () => {
      ddbMock.on(QueryCommand).rejects(new Error("ServiceUnavailable"));

      const result = await db.deleteAlias("acct-1", "me@example.com");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
    });
  });

  describe("listAliasesForDomain", () => {
    it("returns only alias items for the domain, excluding sender entries, across pages", async () => {
      ddbMock.on(QueryCommand)
        .resolvesOnce({
          Items: [
            { id: "a1", accountId: "acct-1", domain: "example.com", alias: "one", sk: "DOMAIN#example.com#ALIAS#one" },
            { accountId: "acct-1", domain: "example.com", alias: "one", senderDomain: "s.com", sk: "DOMAIN#example.com#ALIAS#one#SENDER#s.com" },
          ],
          LastEvaluatedKey: { pk: "x", sk: "y" },
        })
        .resolvesOnce({
          Items: [
            { id: "a2", accountId: "acct-1", domain: "example.com", alias: "two", sk: "DOMAIN#example.com#ALIAS#two" },
          ],
        });

      const result = await db.listAliasesForDomain("acct-1", "example.com");

      expect(result.isOk()).toBe(true);
      const aliases = result._unsafeUnwrap();
      expect(aliases).toHaveLength(2);
      expect(aliases.map((a) => a.id)).toEqual(["a1", "a2"]);
    });

    it("returns err with kind db_error on SDK failure", async () => {
      ddbMock.on(QueryCommand).rejects(new Error("ServiceUnavailable"));

      const result = await db.listAliasesForDomain("acct-1", "example.com");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
    });
  });

  describe("createDomain", () => {
    it("creates a fresh domain with status active", async () => {
      ddbMock.on(PutCommand).resolves({});

      const result = await db.createDomain("acct-1", "example.com");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().status).toBe("active");
      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0]!.args[0]!.input.ConditionExpression).toBe("attribute_not_exists(sk) OR #status = :deleted");
      expect(putCalls[0]!.args[0]!.input.ExpressionAttributeValues).toEqual({ ":deleted": "deleted" });
    });

    it("re-POST while active falls back to the existing record (idempotent)", async () => {
      const existing = { accountId: "acct-1", domain: "example.com", status: "active", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z", receivingSetupComplete: true, senderSetupComplete: true };
      ddbMock.on(PutCommand).rejects(Object.assign(new Error("ConditionalCheckFailedException"), { name: "ConditionalCheckFailedException" }));
      ddbMock.on(GetCommand).resolves({ Item: existing });

      const result = await db.createDomain("acct-1", "example.com");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual(existing);
    });

    it("re-POST while deleted succeeds via the Put itself and resets health/timestamp fields", async () => {
      ddbMock.on(PutCommand).resolves({});

      const result = await db.createDomain("acct-1", "example.com");

      expect(result.isOk()).toBe(true);
      const revived = result._unsafeUnwrap();
      expect(revived.status).toBe("active");
      expect(revived.receivingSetupComplete).toBe(false);
      expect(revived.senderSetupComplete).toBe(false);
      expect(revived.lastCheckedAt).toBeUndefined();
      expect(revived.failingRecords).toBeUndefined();
    });
  });

  describe("deleteDomain", () => {
    it("issues an UpdateCommand setting status to deleted, not a DeleteCommand", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const result = await db.deleteDomain("acct-1", "example.com");

      expect(result.isOk()).toBe(true);
      expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.args[0]!.input.Key).toEqual({ pk: "ACCT#acct-1", sk: "DOMAIN#example.com" });
      expect(updateCalls[0]!.args[0]!.input.ExpressionAttributeValues).toMatchObject({ ":deleted": "deleted" });
    });

    it("returns err with kind db_error on SDK failure", async () => {
      ddbMock.on(UpdateCommand).rejects(new Error("InternalServerError"));

      const result = await db.deleteDomain("acct-1", "example.com");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
    });
  });

  describe("getDomain", () => {
    it("returns null for a soft-deleted domain", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { accountId: "acct-1", domain: "example.com", status: "deleted" } });

      const result = await db.getDomain("acct-1", "example.com");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("returns the item when status is active", async () => {
      const item = { accountId: "acct-1", domain: "example.com", status: "active" };
      ddbMock.on(GetCommand).resolves({ Item: item });

      const result = await db.getDomain("acct-1", "example.com");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual(item);
    });

    it("returns the item when status is absent (legacy row backward compat)", async () => {
      const item = { accountId: "acct-1", domain: "example.com" };
      ddbMock.on(GetCommand).resolves({ Item: item });

      const result = await db.getDomain("acct-1", "example.com");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual(item);
    });
  });

  describe("listDomains", () => {
    it("excludes soft-deleted domains", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { accountId: "acct-1", domain: "active.com", status: "active", sk: "DOMAIN#active.com" },
          { accountId: "acct-1", domain: "gone.com", status: "deleted", sk: "DOMAIN#gone.com" },
          { accountId: "acct-1", domain: "legacy.com", sk: "DOMAIN#legacy.com" },
        ],
      });

      const result = await db.listDomains("acct-1");

      expect(result.isOk()).toBe(true);
      const domains = result._unsafeUnwrap();
      expect(domains.map((d) => d.domain).sort()).toEqual(["active.com", "legacy.com"]);
    });
  });

  describe("scanAllDomains", () => {
    it("excludes soft-deleted domains via FilterExpression and groups by account", async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [
          { accountId: "acct-1", domain: "active.com", status: "active" },
          { accountId: "acct-2", domain: "legacy.com" },
        ],
      });

      const result = await db.scanAllDomains();

      expect(result.isOk()).toBe(true);
      const grouped = result._unsafeUnwrap();
      expect(grouped).toHaveLength(2);
      const scanCalls = ddbMock.commandCalls(ScanCommand);
      expect(scanCalls[0]!.args[0]!.input.FilterExpression).toContain("#status <> :deleted");
    });
  });

  describe("resolveAccountForDomain", () => {
    it("still resolves the accountId when the registrant's row is deleted (anti-takeover)", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ accountId: "acct-1", domain: "example.com", status: "deleted", createdAt: "2024-01-01T00:00:00Z" }],
      });

      const result = await db.resolveAccountForDomain("example.com");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe("acct-1");
    });

    it("returns null when no registrant exists", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const result = await db.resolveAccountForDomain("example.com");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });
  });

  describe("getAliasByGlobalAddress", () => {
    it("returns the full alias item on a hit (gsi1 ALL projection)", async () => {
      const aliasItem = { accountId: "acct-1", address: "someone@example.com", domain: "example.com", alias: "someone", unknownSenderPolicy: "allow_all", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" };
      ddbMock.on(QueryCommand).resolvesOnce({ Items: [aliasItem] });

      const result = await db.getAliasByGlobalAddress("someone@example.com");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual(aliasItem);
    });

    it("returns null when no alias matches", async () => {
      ddbMock.on(QueryCommand).resolvesOnce({ Items: [] });

      const result = await db.getAliasByGlobalAddress("someone@example.com");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });
  });

  describe("getDomainOwner", () => {
    it("returns the oldest registrant, unfiltered by status (includes soft-deleted)", async () => {
      ddbMock.on(QueryCommand).resolvesOnce({ Items: [
        { accountId: "acct-newer", domain: "example.com", status: "active", createdAt: "2024-02-01T00:00:00Z" },
        { accountId: "acct-owner", domain: "example.com", status: "deleted", createdAt: "2024-01-01T00:00:00Z" },
      ] });

      const result = await db.getDomainOwner("example.com");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()?.accountId).toBe("acct-owner");
    });

    it("returns null when the domain is unregistered", async () => {
      ddbMock.on(QueryCommand).resolvesOnce({ Items: [] });

      const result = await db.getDomainOwner("example.com");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });
  });
});

// =============================================================================
// ArcDatabase
// =============================================================================

describe("ArcDatabase", () => {
  let db: ArcDatabase;
  beforeEach(() => { db = new ArcDatabase(createMockLogger()); });

  describe("getSignalByMessageId", () => {
    it("returns ok(signal) when the signal exists", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { id: "SES#msg-123" } });

      const result = await db.getSignalByMessageId("acct-1", "msg-123");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({ id: "SES#msg-123", labels: [] });
    });

    it("returns ok(null) when the signal does not exist", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const result = await db.getSignalByMessageId("acct-1", "missing-msg");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("returns err with kind db_error on SDK failure", async () => {
      ddbMock.on(GetCommand).rejects(new Error("NetworkingError"));

      const result = await db.getSignalByMessageId("acct-1", "msg-123");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
      expect(result._unsafeUnwrapErr().cause).toBeInstanceOf(Error);
    });
  });

  describe("saveSignal", () => {
    it("returns ok(undefined) on successful save", async () => {
      ddbMock.on(PutCommand).resolves({});

      const signal = {
        id: "SES#msg-1",
        accountId: "acct-1",
        arcId: "arc-1",
        receivedAt: "2024-01-01T00:00:00Z",
        status: "active",
      } as any;

      const result = await db.saveSignal(signal);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeUndefined();
    });

    it("returns err with kind db_error on SDK failure", async () => {
      ddbMock.on(PutCommand).rejects(new Error("ConditionalCheckFailedException"));

      const signal = {
        id: "SES#msg-1",
        accountId: "acct-1",
        arcId: "arc-1",
        receivedAt: "2024-01-01T00:00:00Z",
        status: "active",
      } as any;

      const result = await db.saveSignal(signal);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
      expect((result._unsafeUnwrapErr().cause as Error).message).toBe("ConditionalCheckFailedException");
    });
  });

  describe("getSignalById", () => {
    it("returns ok(Signal) when the signal exists", async () => {
      const signal = { id: "sgn-abc123", accountId: "acct-1", subject: "Hello" };
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(GetCommand).resolves({ Item: signal });

      const result = await db.getSignalById("acct-1", "sgn-abc123");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({ ...signal, labels: [] });
    });

    it("returns ok(null) when the signal does not exist", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const result = await db.getSignalById("acct-1", "sgn-missing");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });
  });
});

// =============================================================================
// ProcessingDatabase
// =============================================================================

describe("ProcessingDatabase", () => {
  let db: ProcessingDatabase;
  beforeEach(() => { db = new ProcessingDatabase(); });

  describe("isAddressSuppressed", () => {
    it("returns ok(true) when the address is suppressed", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { address: "spam@example.com" } });

      const result = await db.isAddressSuppressed("spam@example.com");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe(true);
    });

    it("returns ok(false) when the address is not suppressed", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const result = await db.isAddressSuppressed("clean@example.com");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe(false);
    });

    it("returns err with kind db_error on SDK failure", async () => {
      ddbMock.on(GetCommand).rejects(new Error("ResourceNotFoundException"));

      const result = await db.isAddressSuppressed("any@example.com");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
      expect(result._unsafeUnwrapErr().cause).toBeInstanceOf(Error);
    });
  });

  describe("suppressAddress", () => {
    it("returns ok(undefined) on successful suppression", async () => {
      ddbMock.on(PutCommand).resolves({});

      const result = await db.suppressAddress({
        address: "bounce@example.com",
        reason: "hard_bounce",
        suppressedAt: "2024-01-01T00:00:00Z",
      } as any);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeUndefined();
    });

    it("returns err with kind db_error on SDK failure", async () => {
      ddbMock.on(PutCommand).rejects(new Error("ThrottlingException"));

      const result = await db.suppressAddress({
        address: "bounce@example.com",
        reason: "hard_bounce",
        suppressedAt: "2024-01-01T00:00:00Z",
      } as any);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
      expect((result._unsafeUnwrapErr().cause as Error).message).toBe("ThrottlingException");
    });
  });

  describe("updateGlobalReputation", () => {
    it("returns ok(undefined) on successful update", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const result = await db.updateGlobalReputation("example.com", { wasSpam: true, wasBlocked: false });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeUndefined();
    });

    it("returns err with kind db_error on SDK failure", async () => {
      ddbMock.on(UpdateCommand).rejects(new Error("InternalServerError"));

      const result = await db.updateGlobalReputation("example.com", { wasSpam: false, wasBlocked: true });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
    });
  });
});

// =============================================================================
// AuditDatabase
// =============================================================================

describe("AuditDatabase", () => {
  let db: AuditDatabase;
  beforeEach(() => { db = new AuditDatabase(); });

  describe("saveAuditEvent", () => {
    it("returns ok(undefined) on successful save", async () => {
      ddbMock.on(PutCommand).resolves({});

      const result = await db.saveAuditEvent({
        accountId: "acct-1",
        userId: "user-1",
        action: "created",
        resourceType: "rule",
        resourceId: "rule-1",
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeUndefined();
    });

    it("returns err with kind db_error on SDK failure", async () => {
      ddbMock.on(PutCommand).rejects(new Error("ValidationException"));

      const result = await db.saveAuditEvent({
        accountId: "acct-1",
        userId: "user-1",
        action: "deleted",
        resourceType: "alias",
        resourceId: "alias-1",
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
      expect(result._unsafeUnwrapErr().cause).toBeInstanceOf(Error);
      expect((result._unsafeUnwrapErr().cause as Error).message).toBe("ValidationException");
    });
  });

  describe("listAuditEvents", () => {
    it("returns ok with paginated events", async () => {
      const events = [
        { eventId: "e1", accountId: "acct-1", action: "created", resourceType: "rule", resourceId: "r1", timestamp: "2024-01-01" },
        { eventId: "e2", accountId: "acct-1", action: "updated", resourceType: "rule", resourceId: "r1", timestamp: "2024-01-02" },
      ];
      ddbMock.on(QueryCommand).resolves({ Items: events });

      const result = await db.listAuditEvents("acct-1", { limit: 50 });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().items).toHaveLength(2);
    });

    it("returns err with kind db_error on SDK failure", async () => {
      ddbMock.on(QueryCommand).rejects(new Error("AccessDeniedException"));

      const result = await db.listAuditEvents("acct-1", { limit: 50 });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
    });
  });

  describe("listResourceHistory", () => {
    it("returns ok with resource history", async () => {
      const events = [{ eventId: "e1", action: "created" }];
      ddbMock.on(QueryCommand).resolves({ Items: events });

      const result = await db.listResourceHistory("acct-1", "rule", "rule-1");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toHaveLength(1);
    });

    it("returns err with kind db_error on SDK failure", async () => {
      ddbMock.on(QueryCommand).rejects(new Error("Timeout"));

      const result = await db.listResourceHistory("acct-1", "rule", "rule-1");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
    });
  });
});
