import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GmailProvider } from "../../src/external-exchanges/gmail-provider.js";
import { OutlookProvider } from "../../src/external-exchanges/outlook-provider.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import type { SignalQueue } from "../../src/messaging/signal-queue.js";
import type { ExternalMailExchange } from "../../src/types/index.js";
import { createMockLogger } from "../helpers/mock-logger.js";

const RAW_MIME = new Uint8Array(Buffer.from("From: user@example.com\r\nSubject: Hi\r\n\r\nBody"));

const EMX: ExternalMailExchange = {
  id: "emx-1",
  accountId: "acct-1",
  platform: "gmail",
  emailAddress: "user@example.com",
  status: "active",
  connectionUserId: "authress-user-9",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function errorResponse(status: number, text: string): Response {
  return { ok: false, status, json: async () => ({}), text: async () => text } as Response;
}

function deps() {
  return {
    db: {} as AccountDatabase,
    signalQueue: {} as SignalQueue,
    logger: createMockLogger(),
    getProviderToken: async () => "token",
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GmailProvider.sendMessage", () => {
  it("posts the message base64url-encoded and reports the ids", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { id: "gmail-1" }))
      .mockResolvedValueOnce(jsonResponse(200, { payload: { headers: [{ name: "Message-ID", value: "<abc@mail.gmail.com>" }] } }));

    const result = await new GmailProvider(deps()).sendMessage("token", RAW_MIME, EMX);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ providerMessageId: "gmail-1", messageId: "abc@mail.gmail.com" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/messages/send");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).raw).toBe(Buffer.from(RAW_MIME).toString("base64url"));
  });

  it("still reports success when the Message-ID read-back fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { id: "gmail-1" }))
      .mockResolvedValueOnce(errorResponse(500, "boom"));

    const result = await new GmailProvider(deps()).sendMessage("token", RAW_MIME, EMX);

    expect(result._unsafeUnwrap()).toEqual({ providerMessageId: "gmail-1" });
  });

  it("maps 403 to a missing send scope", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(403, "insufficient permissions"));
    const result = await new GmailProvider(deps()).sendMessage("token", RAW_MIME, EMX);
    expect(result._unsafeUnwrapErr().kind).toBe("provider_send_scope_missing");
  });

  it("maps 401 to an expired token", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(401, "unauthorized"));
    const result = await new GmailProvider(deps()).sendMessage("token", RAW_MIME, EMX);
    expect(result._unsafeUnwrapErr().kind).toBe("provider_token_expired");
  });

  it("maps other 4xx to a rejection, which is not retried", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(400, "invalid recipient"));
    const result = await new GmailProvider(deps()).sendMessage("token", RAW_MIME, EMX);
    expect(result._unsafeUnwrapErr().kind).toBe("provider_send_rejected");
  });

  it("maps 5xx to a retryable failure", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(503, "unavailable"));
    const result = await new GmailProvider(deps()).sendMessage("token", RAW_MIME, EMX);
    expect(result._unsafeUnwrapErr().kind).toBe("provider_send_failed");
  });
});

describe("OutlookProvider.sendMessage", () => {
  const outlookEmx = { ...EMX, platform: "outlook" as const };

  it("creates the draft from MIME then sends it, reporting both ids", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, { id: "graph-1", internetMessageId: "<abc@outlook.com>" }))
      .mockResolvedValueOnce(jsonResponse(202, {}));

    const result = await new OutlookProvider(deps()).sendMessage("token", RAW_MIME, outlookEmx);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ providerMessageId: "graph-1", messageId: "abc@outlook.com" });

    const [createUrl, createInit] = fetchMock.mock.calls[0]!;
    expect(createUrl).toContain("/me/messages");
    expect(createInit.headers["Content-Type"]).toBe("text/plain");
    expect(createInit.body).toBe(Buffer.from(RAW_MIME).toString("base64"));

    expect(fetchMock.mock.calls[1]![0]).toContain("/me/messages/graph-1/send");
  });

  it("maps 403 on draft creation to a missing send scope", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(403, "Access denied"));
    const result = await new OutlookProvider(deps()).sendMessage("token", RAW_MIME, outlookEmx);
    expect(result._unsafeUnwrapErr().kind).toBe("provider_send_scope_missing");
  });

  it("maps 403 on the send call to a missing send scope", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, { id: "graph-1" }))
      .mockResolvedValueOnce(errorResponse(403, "Access denied"));
    const result = await new OutlookProvider(deps()).sendMessage("token", RAW_MIME, outlookEmx);
    expect(result._unsafeUnwrapErr().kind).toBe("provider_send_scope_missing");
  });

  it("maps 5xx to a retryable failure", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(503, "unavailable"));
    const result = await new OutlookProvider(deps()).sendMessage("token", RAW_MIME, outlookEmx);
    expect(result._unsafeUnwrapErr().kind).toBe("provider_send_failed");
  });
});
