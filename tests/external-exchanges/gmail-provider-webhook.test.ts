import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok } from "neverthrow";
import { Hono } from "hono";
import { GmailProvider } from "../../src/external-exchanges/gmail-provider.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import type { ExternalMailExchange } from "../../src/types/index.js";

// GmailProvider always JWT-verifies the webhook's Authorization header (Pub/Sub push auth) —
// stub the verifier so tests exercise the handler's own logic, not Google's JWKS endpoint.
vi.mock("../../src/external-exchanges/jwks-verifier.js", () => ({
  createVerifier: () => ({ verify: vi.fn().mockResolvedValue(ok({})) }),
}));

function makeEmx(overrides?: Partial<ExternalMailExchange>): ExternalMailExchange {
  return {
    id: "emx_gmail1",
    accountId: "acct-1",
    platform: "gmail",
    emailAddress: "user@example.com",
    status: "active",
    syncCursor: "1000",
    userId: "u1",
    connectionId: "c1",
    connectionUserId: "cu1",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function pubsubBody(emailAddress: string, historyId: string): { message: { data: string } } {
  const data = Buffer.from(JSON.stringify({ emailAddress, historyId })).toString("base64");
  return { message: { data } };
}

describe("GmailProvider webhook — lastSyncAt", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-06-15T12:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("updates lastSyncAt on every processed push, even when history.list finds no new messages", async () => {
    const emx = makeEmx();
    const db = {
      listExchangesDue: vi.fn().mockResolvedValue(ok([emx])),
      updateExternalExchange: vi.fn().mockResolvedValue(ok(emx)),
    };
    const signalQueue = { sendBatch: vi.fn().mockResolvedValue(ok(undefined)) };
    const provider = new GmailProvider({
      db: db as never,
      signalQueue: signalQueue as never,
      logger: createMockLogger(),
      getProviderToken: vi.fn().mockResolvedValue("token-abc"),
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ history: [], historyId: "1001" }), { status: 200 }),
    ));

    const app = new Hono();
    app.post("/target", (c) => provider.handle(c));

    const res = await app.request("/target", {
      method: "POST",
      headers: { authorization: "Bearer fake-jwt", "content-type": "application/json" },
      body: JSON.stringify(pubsubBody("user@example.com", "1001")),
    });

    expect(res.status).toBe(200);
    expect(signalQueue.sendBatch).toHaveBeenCalledWith("emx_inbound", []);
    expect(db.updateExternalExchange).toHaveBeenCalledWith(
      "acct-1",
      "emx_gmail1",
      expect.objectContaining({ lastSyncAt: "2026-06-15T12:00:00.000Z" }),
    );
  });
});
