import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok } from "neverthrow";
import { Hono } from "hono";
import { OutlookProvider } from "../../src/external-exchanges/outlook-provider.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import type { ExternalMailExchange } from "../../src/types/index.js";

function makeEmx(overrides?: Partial<ExternalMailExchange>): ExternalMailExchange {
  return {
    id: "emx_outlook1",
    accountId: "acct-1",
    platform: "outlook",
    emailAddress: "user@example.com",
    status: "active",
    providerSubscriptionId: "sub-1",
    userId: "u1",
    connectionId: "c1",
    connectionUserId: "cu1",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("OutlookProvider webhook — lastSyncAt", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-06-15T12:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("updates lastSyncAt for every distinct exchange touched by a notification batch — Graph can batch notifications for different subscriptions into one call", async () => {
    const emx1 = makeEmx({ id: "emx_outlook1", providerSubscriptionId: "sub-1" });
    const emx2 = makeEmx({ id: "emx_outlook2", accountId: "acct-2", providerSubscriptionId: "sub-2" });
    const db = {
      findExternalExchangeBySubscriptionId: vi.fn().mockImplementation((subId: string) =>
        Promise.resolve(ok(subId === "sub-1" ? emx1 : subId === "sub-2" ? emx2 : null)),
      ),
      updateExternalExchange: vi.fn().mockResolvedValue(ok(emx1)),
    };
    const signalQueue = { sendBatch: vi.fn().mockResolvedValue(ok(undefined)) };
    const provider = new OutlookProvider({
      db: db as never,
      signalQueue: signalQueue as never,
      logger: createMockLogger(),
      getProviderToken: vi.fn().mockResolvedValue("token-abc"),
    });

    const app = new Hono();
    app.post("/target", (c) => provider.handle(c));

    // No validationTokens — skips JWT verification, isolating the notification-processing path.
    const res = await app.request("/target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        value: [
          { subscriptionId: "sub-1", changeType: "created", resource: "Users/x/Messages/msg-1", resourceData: { id: "msg-1" } },
          { subscriptionId: "sub-2", changeType: "created", resource: "Users/y/Messages/msg-2", resourceData: { id: "msg-2" } },
        ],
      }),
    });

    expect(res.status).toBe(202);
    expect(db.updateExternalExchange).toHaveBeenCalledTimes(2);
    expect(db.updateExternalExchange).toHaveBeenCalledWith("acct-1", "emx_outlook1", { lastSyncAt: "2026-06-15T12:00:00.000Z" });
    expect(db.updateExternalExchange).toHaveBeenCalledWith("acct-2", "emx_outlook2", { lastSyncAt: "2026-06-15T12:00:00.000Z" });
  });

  it("updates lastSyncAt only once when a batch carries several notifications for the same subscription", async () => {
    const emx = makeEmx();
    const db = {
      findExternalExchangeBySubscriptionId: vi.fn().mockResolvedValue(ok(emx)),
      updateExternalExchange: vi.fn().mockResolvedValue(ok(emx)),
    };
    const signalQueue = { sendBatch: vi.fn().mockResolvedValue(ok(undefined)) };
    const provider = new OutlookProvider({
      db: db as never,
      signalQueue: signalQueue as never,
      logger: createMockLogger(),
      getProviderToken: vi.fn().mockResolvedValue("token-abc"),
    });

    const app = new Hono();
    app.post("/target", (c) => provider.handle(c));

    const res = await app.request("/target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        value: [
          { subscriptionId: "sub-1", changeType: "created", resource: "Users/x/Messages/msg-1", resourceData: { id: "msg-1" } },
          { subscriptionId: "sub-1", changeType: "created", resource: "Users/x/Messages/msg-2", resourceData: { id: "msg-2" } },
        ],
      }),
    });

    expect(res.status).toBe(202);
    expect(db.updateExternalExchange).toHaveBeenCalledTimes(1);
    expect(db.updateExternalExchange).toHaveBeenCalledWith("acct-1", "emx_outlook1", { lastSyncAt: "2026-06-15T12:00:00.000Z" });
  });

  it("does not touch the database when the batch carries no processable notification", async () => {
    const db = {
      findExternalExchangeBySubscriptionId: vi.fn(),
      updateExternalExchange: vi.fn(),
    };
    const signalQueue = { sendBatch: vi.fn().mockResolvedValue(ok(undefined)) };
    const provider = new OutlookProvider({
      db: db as never,
      signalQueue: signalQueue as never,
      logger: createMockLogger(),
      getProviderToken: vi.fn().mockResolvedValue("token-abc"),
    });

    const app = new Hono();
    app.post("/target", (c) => provider.handle(c));

    const res = await app.request("/target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: [] }),
    });

    expect(res.status).toBe(202);
    expect(db.updateExternalExchange).not.toHaveBeenCalled();
  });
});
