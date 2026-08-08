import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok } from "neverthrow";
import { err } from "../../src/errors.js";
import { createApp } from "../../src/api/app.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import type { EmailService } from "../../src/email/email-service.js";

vi.mock("../../src/dns/mx-validator.js", () => ({
  validateRecipientMx: vi.fn().mockResolvedValue({ isOk: () => true, isErr: () => false, _unsafeUnwrap: () => undefined }),
}));

vi.mock("../../src/email/template-renderer.js", () => ({
  renderTemplate: vi.fn().mockResolvedValue("<html>team-invite-rendered</html>"),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-invite-test";

function makeAuth() {
  return { verify: vi.fn().mockResolvedValue(ok({ userId: "user-001" })) };
}

function makeAccess() {
  return {
    listUsers: vi.fn().mockResolvedValue(ok([])),
    getUserProfile: vi.fn().mockResolvedValue(ok({})),
    listAccountsForUser: vi.fn().mockResolvedValue(ok([])),
    addUser: vi.fn().mockResolvedValue(ok(undefined)),
    updateUserRole: vi.fn().mockResolvedValue(ok(undefined)),
    removeUser: vi.fn().mockResolvedValue(ok(undefined)),
    checkAccess: vi.fn().mockResolvedValue(undefined),
    createInvite: vi.fn().mockResolvedValue(ok({ inviteId: "inv-abc123" })),
    getLinkedIdentity: vi.fn().mockResolvedValue(ok(true)),
  };
}

function makeAccountDb() {
  return {
    getAccount: vi.fn().mockResolvedValue(ok({ id: TEST_ACCOUNT_ID, name: "Acme Corp" })),
  };
}

function createMockEmailService() {
  return {
    send: vi.fn().mockResolvedValue(ok({ messageId: "msg-invite-001" })),
    sendRaw: vi.fn().mockResolvedValue(ok({ messageId: "msg-raw" })),
  } as unknown as EmailService;
}

// ---------------------------------------------------------------------------
// Team invite email — REQ-3
// ---------------------------------------------------------------------------

describe("Team invite email", () => {
  let logger: ReturnType<typeof createMockLogger>;
  let emailService: ReturnType<typeof createMockEmailService>;
  let access: ReturnType<typeof makeAccess>;
  let accountDb: ReturnType<typeof makeAccountDb>;

  beforeEach(() => {
    logger = createMockLogger();
    emailService = createMockEmailService();
    access = makeAccess();
    accountDb = makeAccountDb();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
  });

  it("sends email with correct subject, from address, and template data", async () => {
    const { renderTemplate } = await import("../../src/email/template-renderer.js");
    const app = createApp(makeAppDeps({
      auth: makeAuth(),
      access: access as never,
      accountDb: accountDb as never,
      logger,
      emailService,
    }));

    const res = await app.request(`/accounts/${TEST_ACCOUNT_ID}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
      body: JSON.stringify({ email: "newuser@example.com", role: "member" }),
    });

    expect(res.status).toBe(201);

    const sendCall = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(sendCall).toBeDefined();
    expect(sendCall.to).toBe("newuser@example.com");
    expect(sendCall.subject).toBe("You've been invited to join Acme Corp on Numaeel");
    expect(sendCall.fromOverride).toMatch(/^"Numaeel" <noreply@/);
    expect(sendCall.htmlBody).toBe("<html>team-invite-rendered</html>");
    expect(sendCall.textBody).toContain("invited to join Acme Corp");
    expect(sendCall.textBody).toContain("inv-abc123");
    expect(sendCall.accountId).toBeUndefined();

    // Verify template rendered with expected data
    expect(renderTemplate).toHaveBeenCalledWith("team-invite", expect.objectContaining({
      accountName: "Acme Corp",
      inviteUrl: expect.stringContaining("inv-abc123"),
      emailType: "team-invite",
    }));
  });

  it("includes triggerId tag with invite pattern", async () => {
    const app = createApp(makeAppDeps({
      auth: makeAuth(),
      access: access as never,
      accountDb: accountDb as never,
      logger,
      emailService,
    }));

    const res = await app.request(`/accounts/${TEST_ACCOUNT_ID}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
      body: JSON.stringify({ email: "invited@example.com", role: "admin" }),
    });

    expect(res.status).toBe(201);

    const sendCall = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const triggerTag = sendCall.tags?.find((t: { Name: string }) => t.Name === "X-Numaeel-TriggerId");
    expect(triggerTag).toBeDefined();
    expect(triggerTag.Value).toBe("invite-inv-abc123");
  });

  it("returns ok and logs WARN on permanent SES error — no retry", async () => {
    vi.mocked(emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(err({ kind: "permanent_ses_error", errorName: "MessageRejected", httpStatus: 400, message: "Email address is not verified", cause: new Error("test") }));
    const app = createApp(makeAppDeps({
      auth: makeAuth(),
      access: access as never,
      accountDb: accountDb as never,
      logger,
      emailService,
    }));

    const res = await app.request(`/accounts/${TEST_ACCOUNT_ID}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
      body: JSON.stringify({ email: "bounce@example.com", role: "member" }),
    });

    expect(res.status).toBe(201);
    expect(logger.calls.some(c => c.method === "warn" && c.context?.code === "invite.email_send_permanent")).toBe(true);
  });
});
