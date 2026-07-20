import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AccountDatabase } from "../../src/database/account-database.js";
import { SYSTEM_RULES } from "../../src/processor/system-rules.js";
import { createMockLogger } from "../helpers/mock-logger.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

describe("AccountDatabase — system rule priorityOrder overrides", () => {
  let db: AccountDatabase;

  beforeEach(() => {
    ddbMock.reset();
    db = new AccountDatabase(createMockLogger());
  });

  afterEach(() => {
    ddbMock.restore();
  });

  it("upsertSystemRuleOverride: a status-only update preserves the code-defined priorityOrder", async () => {
    const sr = SYSTEM_RULES.find((r) => r.id === "SR-02")!;
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const result = await db.upsertSystemRuleOverride("acct-1", "SR-02", { status: "disabled" });
    expect(result.isOk()).toBe(true);

    const putInput = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(putInput.Item?.status).toBe("disabled");
    expect(putInput.Item?.priorityOrder).toBe(sr.priorityOrder);
  });

  it("upsertSystemRuleOverride: a priorityOrder-only update does not clobber a previously-set status override", async () => {
    // Simulate a prior status-only override already sitting in DDB.
    ddbMock.on(GetCommand).resolves({
      Item: { ...SYSTEM_RULES.find((r) => r.id === "SR-02")!, accountId: "acct-1", status: "disabled" },
    });
    ddbMock.on(PutCommand).resolves({});

    const result = await db.upsertSystemRuleOverride("acct-1", "SR-02", { priorityOrder: 1850 });
    expect(result.isOk()).toBe(true);

    const putInput = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(putInput.Item?.status).toBe("disabled");
    expect(putInput.Item?.priorityOrder).toBe(1850);
  });

  it("upsertSystemRuleOverride: a status-only update does not clobber a previously-set priorityOrder override", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...SYSTEM_RULES.find((r) => r.id === "SR-02")!, accountId: "acct-1", priorityOrder: 1850 },
    });
    ddbMock.on(PutCommand).resolves({});

    const result = await db.upsertSystemRuleOverride("acct-1", "SR-02", { status: "enabled" });
    expect(result.isOk()).toBe(true);

    const putInput = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(putInput.Item?.status).toBe("enabled");
    expect(putInput.Item?.priorityOrder).toBe(1850);
  });

  it("upsertSystemRuleOverride: errors on an unknown system rule id", async () => {
    const result = await db.upsertSystemRuleOverride("acct-1", "SR-does-not-exist", { status: "disabled" });
    expect(result.isErr()).toBe(true);
  });

  it("listRules: merges both status and priorityOrder from the DDB override row into the code-defined system rule", async () => {
    const sr = SYSTEM_RULES.find((r) => r.id === "SR-02")!;
    ddbMock.on(QueryCommand).resolves({
      Items: [{ ...sr, accountId: "acct-1", status: "disabled", priorityOrder: 1850 }],
    });

    const result = await db.listRules("acct-1");
    expect(result.isOk()).toBe(true);
    const merged = result._unsafeUnwrap().find((r) => r.id === "SR-02")!;
    expect(merged.status).toBe("disabled");
    expect(merged.priorityOrder).toBe(1850);
  });

  it("listRules: a system rule with no override row keeps its code-defined status and priorityOrder", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await db.listRules("acct-1");
    expect(result.isOk()).toBe(true);
    const sr = SYSTEM_RULES.find((r) => r.id === "SR-02")!;
    const merged = result._unsafeUnwrap().find((r) => r.id === "SR-02")!;
    expect(merged.status).toBe(sr.status);
    expect(merged.priorityOrder).toBe(sr.priorityOrder);
  });
});
