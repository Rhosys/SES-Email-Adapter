import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "neverthrow";
import { createApp } from "../../src/api/app.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ACCOUNT_ID = "acct-webhook-001";
const EMX_ID = "emx_jmap-webhook-test";
const COMPOUND_DEVICE_CLIENT_ID = `${ACCOUNT_ID}:${EMX_ID}`;
const VALID_TOKEN = "valid-hmac-token";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJmapAdapter() {
  return {
    handleWebhook: vi.fn().mockResolvedValue(ok(undefined)),
  };
}

async function webhookReq(
  app: ReturnType<typeof createApp>,
  options: { token?: string; body?: unknown; rawBody?: string } = {},
): Promise<Response> {
  const { token, body, rawBody } = options;
  const url = `http://localhost/external-exchanges/jmap/target${token !== undefined ? `?token=${token}` : ""}`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (rawBody !== undefined) {
    return app.fetch(new Request(url, { method: "POST", headers, body: rawBody }));
  }
  if (body !== undefined) {
    return app.fetch(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }));
  }
  return app.fetch(new Request(url, { method: "POST", headers }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("JMAP webhook endpoint", () => {
  let logger: MockLogger;
  let jmapAdapter: ReturnType<typeof makeJmapAdapter>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
    jmapAdapter = makeJmapAdapter();

    app = createApp(makeAppDeps({
      auth: { verify: vi.fn().mockResolvedValue(ok({ userId: "user-1" })) },
      access: { checkAccess: async () => {} } as never,
      logger,
      jmapAdapter: jmapAdapter as never,
    }));
  });

  it("valid body → delegates to jmapAdapter.handleWebhook, returns 200", async () => {
    const res = await webhookReq(app, {
      token: VALID_TOKEN,
      body: { "@type": "StateChange", deviceClientId: COMPOUND_DEVICE_CLIENT_ID, changed: { Email: { state: "new-state" } } },
    });

    expect(res.status).toBe(200);
    expect(jmapAdapter.handleWebhook).toHaveBeenCalledWith(
      { "@type": "StateChange", deviceClientId: COMPOUND_DEVICE_CLIENT_ID, changed: { Email: { state: "new-state" } } },
      VALID_TOKEN,
    );
  });

  it("malformed body (not JSON) → 400 without calling adapter", async () => {
    const res = await webhookReq(app, {
      token: VALID_TOKEN,
      rawBody: "not json at all",
    });

    expect(res.status).toBe(400);
    expect(jmapAdapter.handleWebhook).not.toHaveBeenCalled();
  });

  it("missing token → delegates with empty string token", async () => {
    const res = await webhookReq(app, {
      body: { "@type": "StateChange", deviceClientId: COMPOUND_DEVICE_CLIENT_ID },
    });

    expect(res.status).toBe(200);
    expect(jmapAdapter.handleWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ "@type": "StateChange" }),
      "",
    );
  });

  it("adapter returns err → returns 400", async () => {
    jmapAdapter.handleWebhook.mockResolvedValue(err({ kind: "malformed_body" }));

    const res = await webhookReq(app, {
      token: VALID_TOKEN,
      body: { "@type": "StateChange", deviceClientId: COMPOUND_DEVICE_CLIENT_ID },
    });

    expect(res.status).toBe(400);
  });
});
