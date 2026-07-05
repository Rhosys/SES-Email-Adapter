import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AccountDatabase } from "../../src/database/account-database.js";
import { createMockLogger } from "../helpers/mock-logger.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => { ddbMock.reset(); });
afterEach(() => { ddbMock.restore(); });

describe("AccountDatabase.updateAccount – digest PATCH semantics", () => {
  let db: AccountDatabase;
  beforeEach(() => { db = new AccountDatabase(createMockLogger()); });

  it("digest undefined → no-op (digest field unchanged)", async () => {
    const returned = { id: "acct-1", name: "Test", digest: { frequency: "daily", forwardingTargetId: "fwd-1" } };
    ddbMock.on(UpdateCommand).resolves({ Attributes: returned });

    const result = await db.updateAccount("acct-1", { name: "Test" });

    expect(result.isOk()).toBe(true);
    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    // UpdateExpression should NOT mention digest at all
    expect(input.UpdateExpression).not.toContain("digest");
    expect(input.ExpressionAttributeValues).not.toHaveProperty(":digest");
  });

  it("digest null → REMOVE attribute (digest disabled)", async () => {
    const returned = { id: "acct-1", name: "Test" };
    ddbMock.on(UpdateCommand).resolves({ Attributes: returned });

    const result = await db.updateAccount("acct-1", { digest: null });

    expect(result.isOk()).toBe(true);
    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.UpdateExpression).toContain("REMOVE digest");
    expect(input.ExpressionAttributeValues).not.toHaveProperty(":digest");
  });

  it("digest object → SET attribute (digest enabled)", async () => {
    const digestValue = { frequency: "weekly" as const, forwardingTargetId: "fwd-abc" };
    const returned = { id: "acct-1", name: "Test", digest: digestValue };
    ddbMock.on(UpdateCommand).resolves({ Attributes: returned });

    const result = await db.updateAccount("acct-1", { digest: digestValue });

    expect(result.isOk()).toBe(true);
    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.UpdateExpression).toContain("digest = :digest");
    expect(input.ExpressionAttributeValues![":digest"]).toEqual(digestValue);
  });
});


// ---------------------------------------------------------------------------
// API-level: 422 when forwardingTargetId references unverified/missing target
// ---------------------------------------------------------------------------

import { vi } from "vitest";
import { ok } from "neverthrow";
import { createApp } from "../../src/api/app.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import type { AuthService, AccessService } from "../../src/api/app.js";
import type { ThreadDatabase } from "../../src/database/thread-database.js";
import type { AccountDatabase as AccountDatabaseType } from "../../src/database/account-database.js";
import type { AuditDatabase } from "../../src/database/audit-database.js";
import type { EmailService } from "../../src/email/email-service.js";
import type { sendRsvp } from "../../src/processor/calendar/rsvp-composer.js";
import type { PostApprovalCalendarHandlerDeps } from "../../src/processor/calendar/post-approval-handler.js";
import { BillingHandler } from "../../src/billing/billing-handler.js";

vi.mock("../../src/dns/mx-validator.js", () => ({
  validateRecipientMx: vi.fn().mockResolvedValue({ isOk: () => true, isErr: () => false, _unsafeUnwrap: () => undefined }),
}));

const TEST_ACCOUNT_ID = "acct-digest-001";

function makeAccountDbMock() {
  return {
    listViews: vi.fn().mockResolvedValue(ok([])),
    getView: vi.fn().mockResolvedValue(ok(null)),
    createView: vi.fn().mockResolvedValue(ok({})),
    updateView: vi.fn().mockResolvedValue(ok({})),
    deleteView: vi.fn().mockResolvedValue(ok(undefined)),
    listLabels: vi.fn().mockResolvedValue(ok([])),
    createLabel: vi.fn().mockResolvedValue(ok({})),
    updateLabel: vi.fn().mockResolvedValue(ok({})),
    deleteLabel: vi.fn().mockResolvedValue(ok(undefined)),
    listRules: vi.fn().mockResolvedValue(ok([])),
    createRule: vi.fn().mockResolvedValue(ok({})),
    updateRule: vi.fn().mockResolvedValue(ok({})),
    deleteRule: vi.fn().mockResolvedValue(ok(undefined)),
    upsertSystemRuleStatus: vi.fn().mockResolvedValue(ok(undefined)),
    listDomains: vi.fn().mockResolvedValue(ok([])),
    getDomain: vi.fn().mockResolvedValue(ok(null)),
    createDomain: vi.fn().mockResolvedValue(ok({})),
    resolveAccountForDomain: vi.fn().mockResolvedValue(ok(null)),
    deleteDomain: vi.fn().mockResolvedValue(ok(undefined)),
    getAccount: vi.fn().mockResolvedValue(ok(null)),
    createAccount: vi.fn().mockImplementation((a: unknown) => Promise.resolve(ok(a))),
    updateAccount: vi.fn().mockResolvedValue(ok({ id: TEST_ACCOUNT_ID, name: "Test" })),
    listAliases: vi.fn().mockResolvedValue(ok([])),
    getAlias: vi.fn().mockResolvedValue(ok(null)),
    createAlias: vi.fn().mockResolvedValue(ok({})),
    saveAlias: vi.fn().mockResolvedValue(ok({})),
    ensureAlias: vi.fn().mockResolvedValue(ok({})),
    upsertAlias: vi.fn().mockResolvedValue(ok({})),
    deleteAlias: vi.fn().mockResolvedValue(ok(undefined)),
    getAccountFilteringConfig: vi.fn().mockResolvedValue(ok(null)),
    listForwardingTargets: vi.fn().mockResolvedValue(ok([])),
    getForwardingTarget: vi.fn().mockResolvedValue(ok(null)),
    saveForwardingTarget: vi.fn().mockResolvedValue(ok(undefined)),
    deleteForwardingTarget: vi.fn().mockResolvedValue(ok(undefined)),
    updateDomainHealth: vi.fn().mockResolvedValue(ok(undefined)),
    renameAlias: vi.fn().mockResolvedValue(ok({})),
    saveSender: vi.fn().mockResolvedValue(ok(undefined)),
    removeSender: vi.fn().mockResolvedValue(ok(undefined)),
    listSenders: vi.fn().mockResolvedValue(ok([])),
    createTemplate: vi.fn().mockResolvedValue(ok(undefined)),
    getTemplate: vi.fn().mockResolvedValue(ok(null)),
    updateTemplate: vi.fn().mockResolvedValue(ok(undefined)),
    deleteTemplate: vi.fn().mockResolvedValue(ok(undefined)),
    listTemplates: vi.fn().mockResolvedValue(ok([])),
    getStats: vi.fn().mockResolvedValue(ok(null)),
  };
}

describe("PATCH /accounts/:id – digest forwardingTargetId validation", () => {
  it("returns 422 when forwardingTargetId references unverified target", async () => {
    const accountDb = makeAccountDbMock();
    // getForwardingTarget returns a pending (unverified) target
    accountDb.getForwardingTarget.mockResolvedValueOnce(ok({ status: "pending", address: "x@y.com" }));

    const auth: AuthService = { verify: vi.fn().mockResolvedValue(ok({ userId: "usr-1" })) };
    const access: AccessService = {
      listUsers: vi.fn().mockResolvedValue(ok([])),
      getUserProfile: vi.fn().mockResolvedValue(ok({})),
      listAccountsForUser: vi.fn().mockResolvedValue(ok([])),
      addUser: vi.fn().mockResolvedValue(ok(undefined)),
      updateUserRole: vi.fn().mockResolvedValue(ok(undefined)),
      removeUser: vi.fn().mockResolvedValue(ok(undefined)),
      checkAccess: vi.fn().mockResolvedValue(undefined),
      createInvite: vi.fn().mockResolvedValue(ok({ inviteId: "inv" })),
    };

    const app = createApp(makeAppDeps({
      threadDb: {} as unknown as ThreadDatabase,
      accountDb: accountDb as unknown as AccountDatabaseType,
      auditDb: {} as unknown as AuditDatabase,
      auth,
      access,
      logger: createMockLogger(),
      forwardingService: { sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)), forward: vi.fn().mockResolvedValue(ok(undefined)) },
      billingHandler: new BillingHandler(),
      emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "m" })), sendRaw: vi.fn() } as unknown as EmailService,
      domainIdentityService: { register: vi.fn().mockResolvedValue(ok(undefined)), deregister: vi.fn().mockResolvedValue(ok(undefined)) },
      rsvpComposer: vi.fn().mockResolvedValue(ok(undefined)) as unknown as typeof sendRsvp,
      postApprovalCalendarDeps: { accountDb: {} as never, emailService: {} as never, serviceDomain: "platform.email.rhosys.cloud" } as unknown as PostApprovalCalendarHandlerDeps,
      schedulerClient: { scheduleMessage: vi.fn().mockResolvedValue(ok(undefined)), deleteSchedule: vi.fn().mockResolvedValue(ok(undefined)) } as never,
    }));

    const res = await app.fetch(new Request(`http://localhost/accounts/${TEST_ACCOUNT_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
      body: JSON.stringify({ digest: { frequency: "daily", forwardingTargetId: "fwd-nonexistent" } }),
    }));

    expect(res.status).toBe(422);
    const body = await res.json() as { errorCode?: string };
    expect(body.errorCode).toBe("UNVERIFIED_FORWARD_TARGET");
  });

  it("returns 422 when forwardingTargetId references non-existent target", async () => {
    const accountDb = makeAccountDbMock();
    // getForwardingTarget returns null (target doesn't exist)
    accountDb.getForwardingTarget.mockResolvedValueOnce(ok(null));

    const auth: AuthService = { verify: vi.fn().mockResolvedValue(ok({ userId: "usr-1" })) };
    const access: AccessService = {
      listUsers: vi.fn().mockResolvedValue(ok([])),
      getUserProfile: vi.fn().mockResolvedValue(ok({})),
      listAccountsForUser: vi.fn().mockResolvedValue(ok([])),
      addUser: vi.fn().mockResolvedValue(ok(undefined)),
      updateUserRole: vi.fn().mockResolvedValue(ok(undefined)),
      removeUser: vi.fn().mockResolvedValue(ok(undefined)),
      checkAccess: vi.fn().mockResolvedValue(undefined),
      createInvite: vi.fn().mockResolvedValue(ok({ inviteId: "inv" })),
    };

    const app = createApp(makeAppDeps({
      threadDb: {} as unknown as ThreadDatabase,
      accountDb: accountDb as unknown as AccountDatabaseType,
      auditDb: {} as unknown as AuditDatabase,
      auth,
      access,
      logger: createMockLogger(),
      forwardingService: { sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)), forward: vi.fn().mockResolvedValue(ok(undefined)) },
      billingHandler: new BillingHandler(),
      emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "m" })), sendRaw: vi.fn() } as unknown as EmailService,
      domainIdentityService: { register: vi.fn().mockResolvedValue(ok(undefined)), deregister: vi.fn().mockResolvedValue(ok(undefined)) },
      rsvpComposer: vi.fn().mockResolvedValue(ok(undefined)) as unknown as typeof sendRsvp,
      postApprovalCalendarDeps: { accountDb: {} as never, emailService: {} as never, serviceDomain: "platform.email.rhosys.cloud" } as unknown as PostApprovalCalendarHandlerDeps,
      schedulerClient: { scheduleMessage: vi.fn().mockResolvedValue(ok(undefined)), deleteSchedule: vi.fn().mockResolvedValue(ok(undefined)) } as never,
    }));

    const res = await app.fetch(new Request(`http://localhost/accounts/${TEST_ACCOUNT_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
      body: JSON.stringify({ digest: { frequency: "monthly", forwardingTargetId: "fwd-ghost" } }),
    }));

    expect(res.status).toBe(422);
  });
});
