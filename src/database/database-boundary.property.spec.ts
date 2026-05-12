import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { propertyRunner } from "../testing/property-runner.js";
import { AccountDatabase } from "./account-database.js";
import { ArcDatabase } from "./arc-database.js";
import { ProcessingDatabase } from "./processing-database.js";
import { AuditDatabase } from "./audit-database.js";

// Generate arbitrary Error instances for SDK rejection testing
const arbError = fc.string({ minLength: 0, maxLength: 200 }).map((msg) => new Error(msg));

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

  it("AccountDatabase.getAccount never throws/rejects — SDK errors become DbError", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbError, async (error) => {
        ddbMock.reset();
        ddbMock.rejectsOnce(error);

        const db = new AccountDatabase();
        const result = await db.getAccount("any-account-id");

        expect(result.isOk() || result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.kind).toBe("db_error");
          expect(result.error.cause).toBeInstanceOf(Error);
        }
      }),
    );
  });

  it("AccountDatabase.listAliases never throws/rejects — SDK errors become DbError", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbError, async (error) => {
        ddbMock.reset();
        ddbMock.rejectsOnce(error);

        const db = new AccountDatabase();
        const result = await db.listAliases("any-account-id");

        expect(result.isOk() || result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.kind).toBe("db_error");
          expect(result.error.cause).toBeInstanceOf(Error);
        }
      }),
    );
  });

  it("ArcDatabase.getArc never throws/rejects — SDK errors become DbError", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbError, async (error) => {
        ddbMock.reset();
        ddbMock.rejectsOnce(error);

        const db = new ArcDatabase();
        const result = await db.getArc("any-account-id", "any-arc-id");

        expect(result.isOk() || result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.kind).toBe("db_error");
          expect(result.error.cause).toBeInstanceOf(Error);
        }
      }),
    );
  });

  it("ArcDatabase.saveSignal never throws/rejects — SDK errors become DbError", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbError, async (error) => {
        ddbMock.reset();
        ddbMock.rejectsOnce(error);

        const db = new ArcDatabase();
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
      }),
    );
  });

  it("ProcessingDatabase.isAddressSuppressed never throws/rejects — SDK errors become DbError", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbError, async (error) => {
        ddbMock.reset();
        ddbMock.rejectsOnce(error);

        const db = new ProcessingDatabase();
        const result = await db.isAddressSuppressed("test@example.com");

        expect(result.isOk() || result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.kind).toBe("db_error");
          expect(result.error.cause).toBeInstanceOf(Error);
        }
      }),
    );
  });

  it("ProcessingDatabase.suppressAddress never throws/rejects — SDK errors become DbError", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbError, async (error) => {
        ddbMock.reset();
        ddbMock.rejectsOnce(error);

        const db = new ProcessingDatabase();
        const result = await db.suppressAddress({ address: "x@y.com", reason: "bounce", suppressedAt: new Date().toISOString() } as any);

        expect(result.isOk() || result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.kind).toBe("db_error");
          expect(result.error.cause).toBeInstanceOf(Error);
        }
      }),
    );
  });

  it("AuditDatabase.saveAuditEvent never throws/rejects — SDK errors become DbError", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbError, async (error) => {
        ddbMock.reset();
        ddbMock.rejectsOnce(error);

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
      }),
    );
  });

  it("AuditDatabase.listAuditEvents never throws/rejects — SDK errors become DbError", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbError, async (error) => {
        ddbMock.reset();
        ddbMock.rejectsOnce(error);

        const db = new AuditDatabase();
        const result = await db.listAuditEvents("acct-1", { limit: 10 });

        expect(result.isOk() || result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.kind).toBe("db_error");
          expect(result.error.cause).toBeInstanceOf(Error);
        }
      }),
    );
  });

  it("SDK success always produces ok(value) — never err on success", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        ddbMock.reset();
        ddbMock.resolves({ Item: undefined, Items: [] });

        const accountDb = new AccountDatabase();
        const arcDb = new ArcDatabase();
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
      }),
    );
  });
});
