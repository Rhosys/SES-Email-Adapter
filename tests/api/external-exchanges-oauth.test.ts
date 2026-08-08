// OAuth (Gmail/Outlook) mailbox connection — identity resolution.
//
// The caller's Authress userId comes from the verified access token, never the request body: a
// caller that could name it could bind an identity it does not hold to its own account. The
// caller's provider identity (connectionUserId) is resolved entirely server-side, from
// Authress' own record of linked identities — never named by the client at all. A connection
// can carry more than one linked identity, but Authress reports a `linkedTime` per identity, and
// the one an in-flight OAuth redirect just linked is always the most recent for its
// connectionId, so that is the one the server resolves to.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApp } from "../../src/api/app.js";
import { ok, err } from "../../src/errors.js";
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
    updateAlias: vi.fn().mockResolvedValue(ok({ aliasAddress: "user@gmail.com" })),
  };
}

// activate() is now the single credential+address gate — the API makes exactly this one call
// and trusts whatever it reports, the same way it will trust renew/fetchMessage/sendMessage
// later. No separate token or address fetch happens at the API layer anymore.
function makeGmailAdapter(activateResult: unknown = ok({ syncCursor: "1", expiresAt: "2026-09-01T00:00:00Z", providerSubscriptionId: "watch", emailAddress: "user@gmail.com" })) {
  return {
    activate: vi.fn().mockResolvedValue(activateResult),
    renew: vi.fn(), deactivate: vi.fn(), fetchMessage: vi.fn(), sendMessage: vi.fn(),
  };
}

function build(overrides: { linkedIdentity?: unknown; activateResult?: unknown } = {}) {
  const accountDb = makeAccountDb();
  const logger = createMockLogger();
  const adapter = makeGmailAdapter(overrides.activateResult);
  const getLinkedIdentity = vi.fn().mockResolvedValue(
    overrides.linkedIdentity === undefined ? ok({ connectionUserId: LINKED_GOOGLE_ID }) : overrides.linkedIdentity,
  );
  const app = createApp(makeAppDeps({
    accountDb: accountDb as never,
    auth: { verify: vi.fn().mockResolvedValue(ok({ userId: CALLER_USER_ID })) },
    access: { checkAccess: async () => {}, getLinkedIdentity } as never,
    logger,
    adapters: { gmail: adapter },
  }));
  return { app, accountDb, adapter, logger: logger as MockLogger, getLinkedIdentity };
}

describe("POST /accounts/:accountId/external-exchanges (OAuth)", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("stores the caller's own userId from the verified token, ignoring any the body names", async () => {
    const res = await req(ctx.app, "POST", `${A}/external-exchanges`, {
      // A caller naming someone else's identity must not get it persisted.
      body: { platform: "gmail", connectionId: "google", userId: "someone-else" },
    });

    expect(res.status).toBe(201);
    const stored = ctx.accountDb.createExternalExchange.mock.calls[0]![1];
    expect(stored.userId).toBe(CALLER_USER_ID);
    expect(ctx.getLinkedIdentity).toHaveBeenCalledWith(CALLER_USER_ID, "google");
  });

  it("persists the connectionUserId Authress resolves, ignoring any the body claims", async () => {
    const res = await req(ctx.app, "POST", `${A}/external-exchanges`, {
      body: { platform: "gmail", connectionId: "google", connectionUserId: "attacker-controlled-id" },
    });

    expect(res.status).toBe(201);
    expect(ctx.accountDb.createExternalExchange.mock.calls[0]![1].connectionUserId).toBe(LINKED_GOOGLE_ID);
  });

  it("refuses the connection when the caller has no identity linked under this connection", async () => {
    const unlinked = build({ linkedIdentity: ok(null) });

    const res = await req(unlinked.app, "POST", `${A}/external-exchanges`, {
      body: { platform: "gmail", connectionId: "google" },
    });

    expect(res.status).toBe(422);
    expect(unlinked.accountDb.createExternalExchange).not.toHaveBeenCalled();
  });

  // activate() resolving its own credentials is the real test of whether this connection is
  // usable — not a separate existence check that could pass while the real thing fails.
  it("refuses the connection when activate() cannot obtain usable credentials", async () => {
    const noCredentials = build({ activateResult: err({ kind: "provider_activation_failed", cause: "credentials revoked" }) });

    const res = await req(noCredentials.app, "POST", `${A}/external-exchanges`, {
      body: { platform: "gmail", connectionId: "google" },
    });

    expect(res.status).toBe(422);
    expect(noCredentials.accountDb.createExternalExchange).not.toHaveBeenCalled();
  });

  it("passes the caller's identity to activate() and persists the address activate() reports, never the request's", async () => {
    const res = await req(ctx.app, "POST", `${A}/external-exchanges`, {
      // A caller naming a mailbox it does not own must not get an exchange — or the alias
      // that routes outbound mail — pointed at it.
      body: { platform: "gmail", connectionId: "google", emailAddress: "victim@gmail.com" },
    });

    expect(res.status).toBe(201);
    expect(ctx.adapter.activate.mock.calls[0]![1]).toEqual({ userId: CALLER_USER_ID, connectionId: "google", connectionUserId: LINKED_GOOGLE_ID });
    expect(ctx.accountDb.createExternalExchange.mock.calls[0]![1].emailAddress).toBe("user@gmail.com");
    expect(ctx.accountDb.ensureAlias.mock.calls[0]![1]).toBe("user@gmail.com");
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
