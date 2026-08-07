// OAuth (Gmail/Outlook) mailbox connection — identity resolution.
//
// The caller's Authress userId comes from the verified access token, and their identity at
// the provider comes from Authress. Neither is taken from the request body: a caller that
// could name either could bind an identity it does not hold to its own account.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApp } from "../../src/api/app.js";
import { ok } from "../../src/errors.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import type { MockLogger } from "../helpers/mock-logger.js";

async function req(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<Response> {
  const { body, token = "valid-token" } = options;
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

const A = "/accounts/acct-1";
const CALLER_USER_ID = "authress-user-9";
const LINKED_GOOGLE_ID = "google-sub-12345";

function makeAccountDb() {
  return {
    listExternalExchanges: vi.fn().mockResolvedValue(ok([])),
    getAliasByGlobalAddress: vi.fn().mockResolvedValue(ok(null)),
    createExternalExchange: vi.fn().mockImplementation((accountId: string, data: Record<string, unknown>) =>
      Promise.resolve(ok({ id: "emx-1", accountId, ...data, createdAt: "", updatedAt: "" }))),
    updateExternalExchange: vi.fn().mockResolvedValue(ok({ id: "emx-1", accountId: "acct-1", platform: "gmail", emailAddress: "user@gmail.com", status: "active", createdAt: "", updatedAt: "" })),
    ensureAlias: vi.fn().mockResolvedValue(ok({ alias: { aliasAddress: "user@gmail.com" }, created: true })),
    setAliasExchange: vi.fn().mockResolvedValue(ok({ aliasAddress: "user@gmail.com" })),
  };
}

function makeGmailAdapter() {
  return {
    activate: vi.fn().mockResolvedValue(ok({ syncCursor: "1", expiresAt: "2026-09-01T00:00:00Z", providerSubscriptionId: "watch" })),
    renew: vi.fn(), deactivate: vi.fn(), fetchMessage: vi.fn(),
    fetchMailboxAddress: vi.fn().mockResolvedValue(ok("user@gmail.com")),
    sendMessage: vi.fn(),
  };
}

function build(overrides: { linkedIdentity?: unknown } = {}) {
  const accountDb = makeAccountDb();
  const logger = createMockLogger();
  const getLinkedIdentity = vi.fn().mockResolvedValue(
    overrides.linkedIdentity === undefined ? ok({ connectionUserId: LINKED_GOOGLE_ID }) : overrides.linkedIdentity,
  );
  const app = createApp(makeAppDeps({
    accountDb: accountDb as never,
    auth: { verify: vi.fn().mockResolvedValue(ok({ userId: CALLER_USER_ID })) },
    access: { checkAccess: async () => {}, getLinkedIdentity } as never,
    logger,
    adapters: { gmail: makeGmailAdapter() },
    getProviderToken: async () => "provider-token",
  }));
  return { app, accountDb, logger: logger as MockLogger, getLinkedIdentity };
}

describe("POST /accounts/:accountId/external-exchanges (OAuth)", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("stores the caller's own userId from the verified token, ignoring any the body names", async () => {
    const res = await req(ctx.app, "POST", `${A}/external-exchanges`, {
      // A caller naming someone else's identity must not get it persisted.
      body: { platform: "gmail", connectionId: "google", userId: "someone-else", connectionUserId: LINKED_GOOGLE_ID },
    });

    expect(res.status).toBe(201);
    const stored = ctx.accountDb.createExternalExchange.mock.calls[0]![1];
    expect(stored.userId).toBe(CALLER_USER_ID);
    expect(ctx.getLinkedIdentity).toHaveBeenCalledWith(CALLER_USER_ID, "google");
  });

  it("persists the provider identity Authress holds, not the one the body claims", async () => {
    const res = await req(ctx.app, "POST", `${A}/external-exchanges`, {
      body: { platform: "gmail", connectionId: "google", connectionUserId: "attacker-controlled-id" },
    });

    expect(res.status).toBe(201);
    expect(ctx.accountDb.createExternalExchange.mock.calls[0]![1].connectionUserId).toBe(LINKED_GOOGLE_ID);
  });

  it("emits a TRACK when the client's claimed provider identity disagrees with Authress", async () => {
    await req(ctx.app, "POST", `${A}/external-exchanges`, {
      body: { platform: "gmail", connectionId: "google", connectionUserId: "stale-or-forged" },
    });

    expect(ctx.logger.calls.some(c => c.method === "track" && c.context?.code === "api.emx.create.connection_user_mismatch")).toBe(true);
  });

  it("stays quiet when the client's claim matches", async () => {
    await req(ctx.app, "POST", `${A}/external-exchanges`, {
      body: { platform: "gmail", connectionId: "google", connectionUserId: LINKED_GOOGLE_ID },
    });

    expect(ctx.logger.calls.some(c => c.context?.code === "api.emx.create.connection_user_mismatch")).toBe(false);
  });

  it("resolves the identity even when the client claims nothing", async () => {
    const res = await req(ctx.app, "POST", `${A}/external-exchanges`, {
      body: { platform: "gmail", connectionId: "google" },
    });

    expect(res.status).toBe(201);
    expect(ctx.accountDb.createExternalExchange.mock.calls[0]![1].connectionUserId).toBe(LINKED_GOOGLE_ID);
  });

  it("refuses to connect a mailbox for a connection the caller has not linked", async () => {
    const unlinked = build({ linkedIdentity: ok(null) });

    const res = await req(unlinked.app, "POST", `${A}/external-exchanges`, {
      body: { platform: "gmail", connectionId: "google", connectionUserId: "made-up" },
    });

    expect(res.status).toBe(422);
    expect(unlinked.accountDb.createExternalExchange).not.toHaveBeenCalled();
  });

  it("fails closed when the identity provider cannot be reached", async () => {
    const unreachable = build({ linkedIdentity: { isErr: () => true, isOk: () => false, error: { kind: "authress_service_error" } } });

    const res = await req(unreachable.app, "POST", `${A}/external-exchanges`, {
      body: { platform: "gmail", connectionId: "google" },
    });

    expect(res.status).toBe(503);
    expect(unreachable.accountDb.createExternalExchange).not.toHaveBeenCalled();
  });
});
