import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
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
  beforeEach(() => { db = new AccountDatabase(); });

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
      expect(result._unsafeUnwrap()).toEqual({ id: "SES#msg-123" });
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
      expect(result._unsafeUnwrap()).toEqual(signal);
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
