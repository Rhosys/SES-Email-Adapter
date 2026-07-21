import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AccountDatabase } from "../../src/database/account-database.js";
import { SYSTEM_ACCOUNT_ID } from "../../src/database/system-account-db.js";
import { createMockLogger } from "../helpers/mock-logger.js";

/**
 * Property 5: SystemAccountDb delegation
 * Validates: Requirements 6.2, 6.9
 *
 * For any method on AccountDatabase that accepts an accountId parameter, calling
 * it with "SYSTEM" SHALL return the hardcoded response from SystemAccountDb
 * without performing any DynamoDB operation.
 */

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => { ddbMock.reset(); });
afterEach(() => { ddbMock.restore(); });

describe("AccountDatabase — SYSTEM delegation (Property 5)", () => {
  let db: AccountDatabase;
  beforeEach(() => { db = new AccountDatabase(createMockLogger()); });

  describe("SYSTEM accountId short-circuits without DynamoDB", () => {
    it("getAccount(SYSTEM) returns hardcoded account without DynamoDB call", async () => {
      const result = await db.getAccount(SYSTEM_ACCOUNT_ID);

      expect(result.isOk()).toBe(true);
      const account = result._unsafeUnwrap();
      expect(account).not.toBeNull();
      expect(account!.id).toBe(SYSTEM_ACCOUNT_ID);
      expect(account!.billingPlan).toBe("Free");
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    it("listEnabledRules(SYSTEM) returns system rules without DynamoDB call", async () => {
      const result = await db.listEnabledRules(SYSTEM_ACCOUNT_ID);

      expect(result.isOk()).toBe(true);
      const rules = result._unsafeUnwrap();
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every(r => r.status === "enabled")).toBe(true);
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    it("listDomains(SYSTEM) returns hardcoded domains without DynamoDB call", async () => {
      const result = await db.listDomains(SYSTEM_ACCOUNT_ID);

      expect(result.isOk()).toBe(true);
      const domains = result._unsafeUnwrap();
      expect(domains).toHaveLength(2);
      expect(domains[0]!.accountId).toBe(SYSTEM_ACCOUNT_ID);
      expect(domains[1]!.accountId).toBe(SYSTEM_ACCOUNT_ID);
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    it("getDomainByName(SYSTEM, mailDomain) returns domain without DynamoDB call", async () => {
      const result = await db.getDomainByName(SYSTEM_ACCOUNT_ID, "platform.email.rhosys.cloud");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).not.toBeNull();
      expect(result._unsafeUnwrap()!.domain).toBe("platform.email.rhosys.cloud");
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    it("getSender(SYSTEM, ...) returns null without DynamoDB call", async () => {
      const result = await db.getSender(SYSTEM_ACCOUNT_ID, "healthcheck@platform.email.rhosys.cloud", "example.com");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });
  });

  describe("getAliasByGlobalAddress — checks SystemAccountDb first, falls through to DynamoDB", () => {
    it("returns SYSTEM alias for healthcheck address without DynamoDB", async () => {
      const result = await db.getAliasByGlobalAddress("healthcheck@platform.email.rhosys.cloud");

      expect(result.isOk()).toBe(true);
      const alias = result._unsafeUnwrap();
      expect(alias).not.toBeNull();
      expect(alias!.accountId).toBe(SYSTEM_ACCOUNT_ID);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    it("falls through to DynamoDB for non-SYSTEM addresses", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [{ accountId: "acct-1", aliasAddress: "user@example.com" }] });

      const result = await db.getAliasByGlobalAddress("user@example.com");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()!.accountId).toBe("acct-1");
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    });
  });

  describe("getDomainOwner — checks SystemAccountDb first, falls through to DynamoDB", () => {
    it("returns SYSTEM domain for MAIL_DOMAIN without DynamoDB", async () => {
      const result = await db.getDomainOwner("platform.email.rhosys.cloud");

      expect(result.isOk()).toBe(true);
      const domain = result._unsafeUnwrap();
      expect(domain).not.toBeNull();
      expect(domain!.accountId).toBe(SYSTEM_ACCOUNT_ID);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    it("falls through to DynamoDB for non-SYSTEM domains", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [{ accountId: "acct-1", domain: "example.com", createdAt: "2024-01-01T00:00:00Z" }] });

      const result = await db.getDomainOwner("example.com");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()!.accountId).toBe("acct-1");
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    });
  });

  describe("non-SYSTEM accounts still use DynamoDB", () => {
    it("getAccount with regular accountId queries DynamoDB", async () => {
      const account = { id: "acct-123", name: "Regular" };
      ddbMock.on(GetCommand).resolves({ Item: account });

      const result = await db.getAccount("acct-123");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual(account);
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
    });

    it("listEnabledRules with regular accountId queries DynamoDB", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [{ id: "rule-1", status: "enabled", priorityOrder: 1 }] });

      const result = await db.listEnabledRules("acct-123");

      expect(result.isOk()).toBe(true);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    });

    it("listDomains with regular accountId queries DynamoDB", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [{ accountId: "acct-123", domain: "example.com" }] });

      const result = await db.listDomains("acct-123");

      expect(result.isOk()).toBe(true);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    });
  });
});
