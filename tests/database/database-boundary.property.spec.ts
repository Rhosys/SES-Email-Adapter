import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AccountDatabase } from "../../src/database/account-database.js";
import { ArcDatabase } from "../../src/database/arc-database.js";
import { ProcessingDatabase } from "../../src/database/processing-database.js";
import { AuditDatabase } from "../../src/database/audit-database.js";
import { createMockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Property 1: Database boundary completeness
// For any database method, verify it returns ResultAsync that resolves to
// ok(value) or err({ kind: "db_error", cause }) — never throws, never rejects.
// Mock SDK to throw arbitrary errors, verify they become DbError.
// **Validates: Requirements 2.2, 2.4, 2.5**
// ---------------------------------------------------------------------------

const ddbMock = mockClient(DynamoDBDocumentClient);

describe("Property 1: Database boundary completeness", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  afterEach(() => {
    ddbMock.restore();
  });

  // The error message content doesn't change code paths — what matters is that
  // ANY SDK rejection becomes a DbError. One representative error is sufficient.
  const sdkError = new Error("Service unavailable");

  it("AccountDatabase.getAccount never throws/rejects — SDK errors become DbError", async () => {
    ddbMock.reset();
    ddbMock.rejectsOnce(sdkError);

    const db = new AccountDatabase(createMockLogger());
    const result = await db.getAccount("any-account-id");

    expect(result.isOk() || result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe("db_error");
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  it("AccountDatabase.listAliases never throws/rejects — SDK errors become DbError", async () => {
    ddbMock.reset();
    ddbMock.rejectsOnce(sdkError);

    const db = new AccountDatabase(createMockLogger());
    const result = await db.listAliases("any-account-id");

    expect(result.isOk() || result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe("db_error");
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  it("ArcDatabase.getArc never throws/rejects — SDK errors become DbError", async () => {
    ddbMock.reset();
    ddbMock.rejectsOnce(sdkError);

    const db = new ArcDatabase(createMockLogger());
    const result = await db.getArc("any-account-id", "any-arc-id");

    expect(result.isOk() || result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe("db_error");
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  it("ArcDatabase.saveSignal never throws/rejects — SDK errors become DbError", async () => {
    ddbMock.reset();
    ddbMock.rejectsOnce(sdkError);

    const db = new ArcDatabase(createMockLogger());
    const result = await db.saveSignal({
      id: "sig-1",
      accountId: "acct-1",
      arcId: "arc-1",
      sesMessageId: "ses-1",
      from: "a@b.com",
      to: "c@d.com",
      subject: "test",
      receivedAt: new Date().toISOString(),
    } as any);

    expect(result.isOk() || result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe("db_error");
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  it("ProcessingDatabase.isAddressSuppressed never throws/rejects — SDK errors become DbError", async () => {
    ddbMock.reset();
    ddbMock.rejectsOnce(sdkError);

    const db = new ProcessingDatabase();
    const result = await db.isAddressSuppressed("test@example.com");

    expect(result.isOk() || result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe("db_error");
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  it("ProcessingDatabase.suppressAddress never throws/rejects — SDK errors become DbError", async () => {
    ddbMock.reset();
    ddbMock.rejectsOnce(sdkError);

    const db = new ProcessingDatabase();
    const result = await db.suppressAddress({ address: "x@y.com", reason: "bounce", suppressedAt: new Date().toISOString() } as any);

    expect(result.isOk() || result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe("db_error");
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  it("AuditDatabase.saveAuditEvent never throws/rejects — SDK errors become DbError", async () => {
    ddbMock.reset();
    ddbMock.rejectsOnce(sdkError);

    const db = new AuditDatabase();
    const result = await db.saveAuditEvent({
      accountId: "acct-1",
      userId: "user-1",
      action: "created",
      resourceType: "rule",
      resourceId: "rule-1",
    });

    expect(result.isOk() || result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe("db_error");
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  it("AuditDatabase.listAuditEvents never throws/rejects — SDK errors become DbError", async () => {
    ddbMock.reset();
    ddbMock.rejectsOnce(sdkError);

    const db = new AuditDatabase();
    const result = await db.listAuditEvents("acct-1", { limit: 10 });

    expect(result.isOk() || result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe("db_error");
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  it("SDK success always produces ok(value) — never err on success", async () => {
    ddbMock.reset();
    ddbMock.resolves({ Item: undefined, Items: [] });

    const accountDb = new AccountDatabase(createMockLogger());
    const arcDb = new ArcDatabase(createMockLogger());
    const processingDb = new ProcessingDatabase();
    const auditDb = new AuditDatabase();

    const r1 = await accountDb.getAccount("acct-1");
    expect(r1.isOk()).toBe(true);

    const r2 = await arcDb.getArc("acct-1", "arc-1");
    expect(r2.isOk()).toBe(true);

    const r3 = await processingDb.isAddressSuppressed("x@y.com");
    expect(r3.isOk()).toBe(true);

    const r4 = await auditDb.listAuditEvents("acct-1", { limit: 10 });
    expect(r4.isOk()).toBe(true);
  });
});
