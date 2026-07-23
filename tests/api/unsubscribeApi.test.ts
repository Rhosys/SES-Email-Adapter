import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "neverthrow";
import { createApp } from "../../src/api/app.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import { createMockLogger } from "../helpers/mock-logger.js";

const TEST_ACCOUNT_ID = "acct-unsub-test";

function makeAccountDb() {
  return {
    updateAccount: vi.fn().mockResolvedValue(ok({ id: TEST_ACCOUNT_ID, name: "Test" })),
  };
}

function makeTokenGenerator(verifyResult: unknown) {
  return { generate: vi.fn().mockResolvedValue("tok"), verify: vi.fn().mockResolvedValue(verifyResult) };
}

describe("Unsubscribe API", () => {
  let logger: ReturnType<typeof createMockLogger>;
  let accountDb: ReturnType<typeof makeAccountDb>;

  beforeEach(() => {
    logger = createMockLogger();
    accountDb = makeAccountDb();
  });

  it("disables the digest and returns 200 for a valid code", async () => {
    const tokenGenerator = makeTokenGenerator(ok({ accountId: TEST_ACCOUNT_ID, emailType: "digest" }));
    const app = createApp(makeAppDeps({
      accountDb: accountDb as never,
      logger,
      unsubscribeTokenGenerator: tokenGenerator as never,
    }));

    const res = await app.request(`/accounts/${TEST_ACCOUNT_ID}/unsubscribe?code=valid-token`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "unsubscribed" });
    expect(accountDb.updateAccount).toHaveBeenCalledWith(TEST_ACCOUNT_ID, { digest: null });
    expect(logger.calls.some(c => c.context?.code === "api.unsubscribe.digest_disabled")).toBe(true);
  });

  it("returns 400 when the token fails verification", async () => {
    const tokenGenerator = makeTokenGenerator(err({ kind: "invalid_signature" }));
    const app = createApp(makeAppDeps({
      accountDb: accountDb as never,
      logger,
      unsubscribeTokenGenerator: tokenGenerator as never,
    }));

    const res = await app.request(`/accounts/${TEST_ACCOUNT_ID}/unsubscribe?code=bad-token`, {
      method: "POST",
    });

    expect(res.status).toBe(400);
    expect(accountDb.updateAccount).not.toHaveBeenCalled();
    expect(logger.calls.some(c => c.context?.code === "api.unsubscribe.verify_failed")).toBe(true);
  });

  it("returns 400 when the token account does not match the path", async () => {
    const tokenGenerator = makeTokenGenerator(ok({ accountId: "some-other-account", emailType: "digest" }));
    const app = createApp(makeAppDeps({
      accountDb: accountDb as never,
      logger,
      unsubscribeTokenGenerator: tokenGenerator as never,
    }));

    const res = await app.request(`/accounts/${TEST_ACCOUNT_ID}/unsubscribe?code=other-token`, {
      method: "POST",
    });

    expect(res.status).toBe(400);
    expect(accountDb.updateAccount).not.toHaveBeenCalled();
    expect(logger.calls.some(c => c.context?.code === "api.unsubscribe.account_mismatch")).toBe(true);
  });
});
