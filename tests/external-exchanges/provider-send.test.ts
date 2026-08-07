import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { GmailProvider } from "../../src/external-exchanges/gmail-provider.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import type { SignalQueue } from "../../src/messaging/signal-queue.js";
import type { ExternalMailExchange } from "../../src/types/index.js";
import { createMockLogger } from "../helpers/mock-logger.js";

// OutlookProvider.activate reads an RSA private key via KMS to build the notification
// encryption certificate Graph requires. Mocked here with a real (test-generated) keypair so
// createPublicKey/export in the adapter run against genuine key material, not a fixture that
// merely looks like one.
const { privateKey: TEST_PRIVATE_KEY_PEM } = generateKeyPairSync("rsa", { modulusLength: 2048 });
vi.mock("node:fs/promises", () => ({ readFile: vi.fn().mockResolvedValue(Buffer.from("encrypted-placeholder")) }));
vi.mock("@aws-sdk/client-kms", () => ({
  KMSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Plaintext: Buffer.from(TEST_PRIVATE_KEY_PEM.export({ type: "pkcs1", format: "pem" })) }),
  })),
  DecryptCommand: vi.fn(),
}));

const { OutlookProvider } = await import("../../src/external-exchanges/outlook-provider.js");

const RAW_MIME = new Uint8Array(Buffer.from("From: user@example.com\r\nSubject: Hi\r\n\r\nBody"));

const EMX: ExternalMailExchange = {
  id: "emx-1",
  accountId: "acct-1",
  platform: "gmail",
  emailAddress: "user@example.com",
  status: "active",
  userId: "authress-user-9",
  connectionUserId: "google-sub-12345",
  connectionId: "google",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

// No userId/connectionId — an exchange that predates connection tracking, or one whose
// linked identity was removed. Every method past activate() has to refuse cleanly on this.
const EMX_NO_IDENTITY: ExternalMailExchange = (() => {
  const { userId: _userId, connectionId: _connectionId, ...rest } = EMX;
  return rest;
})();

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function errorResponse(status: number, text: string): Response {
  return { ok: false, status, json: async () => ({}), text: async () => text } as Response;
}

function deps(getProviderToken: () => Promise<string> = async () => "token") {
  return {
    db: {} as AccountDatabase,
    signalQueue: {} as SignalQueue,
    logger: createMockLogger(),
    getProviderToken,
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

// ---------------------------------------------------------------------------
// Credential resolution
//
// Every ProviderAdapter method past activate() resolves its own token from the identity
// coordinates recorded on `emx`, rather than trusting a token the caller fetched. This is
// the behavior that replaces what used to be duplicated at every call site (dispatch worker,
// inbound worker, reply-sender, the API's delete handler).
// ---------------------------------------------------------------------------

describe("credential resolution — shared by renew/deactivate/fetchMessage/sendMessage", () => {
  it("Gmail.renew refuses cleanly when the exchange has no linked identity recorded", async () => {
    const result = await new GmailProvider(deps()).renew(EMX_NO_IDENTITY);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("provider_renewal_failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Gmail.sendMessage refuses cleanly when the exchange has no linked identity recorded", async () => {
    const result = await new GmailProvider(deps()).sendMessage(RAW_MIME, EMX_NO_IDENTITY);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("provider_send_failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Gmail.renew maps a token-fetch failure to a renewal failure, not an unhandled throw", async () => {
    const provider = new GmailProvider(deps(() => { throw new Error("credentials revoked"); }));
    const result = await provider.renew(EMX);
    expect(result._unsafeUnwrapErr()).toEqual({ kind: "provider_renewal_failed", cause: expect.any(Error) });
  });

  it("Outlook.deactivate refuses cleanly when the exchange has no linked identity recorded", async () => {
    const result = await new OutlookProvider(deps()).deactivate(EMX_NO_IDENTITY);
    expect(result.isErr()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the token the resolved credentials produced, on the outgoing request", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { id: "gmail-1" }))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    await new GmailProvider(deps(async () => "resolved-token")).sendMessage(RAW_MIME, EMX);
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe("Bearer resolved-token");
  });
});

// ---------------------------------------------------------------------------
// activate() — owns its own credential fetch and reports the verified mailbox address
// ---------------------------------------------------------------------------

describe("GmailProvider.activate", () => {
  const IDENTITY = { userId: "authress-user-9", connectionId: "google" };

  it("fetches its own token from the supplied identity, subscribes, and resolves the address", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { historyId: "100", expiration: String(Date.now() + 3600_000) }))
      .mockResolvedValueOnce(jsonResponse(200, { emailAddress: "user@gmail.com" }));

    const getProviderToken = vi.fn().mockResolvedValue("token-xyz");
    const result = await new GmailProvider(deps(getProviderToken)).activate(EMX, IDENTITY);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ syncCursor: "100", providerSubscriptionId: "watch", emailAddress: "user@gmail.com" });
    expect(getProviderToken).toHaveBeenCalledWith("authress-user-9", "google");
  });

  it("fails without making a request when no identity is supplied", async () => {
    const result = await new GmailProvider(deps()).activate(EMX);
    expect(result.isErr()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails when the address cannot be resolved after a successful subscription", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { historyId: "100", expiration: String(Date.now() + 3600_000) }))
      .mockResolvedValueOnce(errorResponse(500, "boom"));

    const result = await new GmailProvider(deps()).activate(EMX, IDENTITY);
    expect(result.isErr()).toBe(true);
  });
});

describe("OutlookProvider.activate", () => {
  const IDENTITY = { userId: "authress-user-9", connectionId: "microsoft" };
  const outlookEmx = { ...EMX, platform: "outlook" as const };

  it("fetches its own token, walks delta pages, subscribes, and resolves the address", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { "@odata.deltaLink": "https://graph/delta?token=abc" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "sub-1", expirationDateTime: "2026-09-01T00:00:00Z" }))
      .mockResolvedValueOnce(jsonResponse(200, { mail: "user@contoso.com" }));

    const getProviderToken = vi.fn().mockResolvedValue("token-xyz");
    const result = await new OutlookProvider(deps(getProviderToken)).activate(outlookEmx, IDENTITY);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ providerSubscriptionId: "sub-1", emailAddress: "user@contoso.com" });
    expect(getProviderToken).toHaveBeenCalledWith("authress-user-9", "microsoft");
  });

  it("fails without making a request when no identity is supplied", async () => {
    const result = await new OutlookProvider(deps()).activate(outlookEmx);
    expect(result.isErr()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// IMAP/JMAP already know their own address from the configured username — activate() reports
// it directly, with no provider round-trip and no identity argument.
// ---------------------------------------------------------------------------

describe("mailbox address on IMAP/JMAP is read from config, not resolved from a provider", () => {
  it("Outlook prefers the routable mail address over the sign-in name", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { "@odata.deltaLink": "https://graph/delta?token=abc" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "sub-1", expirationDateTime: "2026-09-01T00:00:00Z" }))
      .mockResolvedValueOnce(jsonResponse(200, { mail: "user@contoso.com", userPrincipalName: "user@contoso.onmicrosoft.com" }));

    const result = await new OutlookProvider(deps()).activate({ ...EMX, platform: "outlook" }, { userId: "u", connectionId: "microsoft" });
    expect(result._unsafeUnwrap().emailAddress).toBe("user@contoso.com");
  });

  it("Outlook falls back to the sign-in name when no mail address is set", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { "@odata.deltaLink": "https://graph/delta?token=abc" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "sub-1", expirationDateTime: "2026-09-01T00:00:00Z" }))
      .mockResolvedValueOnce(jsonResponse(200, { mail: null, userPrincipalName: "user@contoso.onmicrosoft.com" }));

    const result = await new OutlookProvider(deps()).activate({ ...EMX, platform: "outlook" }, { userId: "u", connectionId: "microsoft" });
    expect(result._unsafeUnwrap().emailAddress).toBe("user@contoso.onmicrosoft.com");
  });
});

describe("GmailProvider.sendMessage", () => {
  it("posts the message base64url-encoded and reports the ids", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { id: "gmail-1" }))
      .mockResolvedValueOnce(jsonResponse(200, { payload: { headers: [{ name: "Message-ID", value: "<abc@mail.gmail.com>" }] } }));

    const result = await new GmailProvider(deps()).sendMessage(RAW_MIME, EMX);

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

    const result = await new GmailProvider(deps()).sendMessage(RAW_MIME, EMX);

    expect(result._unsafeUnwrap()).toEqual({ providerMessageId: "gmail-1" });
  });

  it("maps 403 to a missing send scope", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(403, "insufficient permissions"));
    const result = await new GmailProvider(deps()).sendMessage(RAW_MIME, EMX);
    expect(result._unsafeUnwrapErr().kind).toBe("provider_send_scope_missing");
  });

  it("maps 401 to an expired token", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(401, "unauthorized"));
    const result = await new GmailProvider(deps()).sendMessage(RAW_MIME, EMX);
    expect(result._unsafeUnwrapErr().kind).toBe("provider_token_expired");
  });

  it("maps other 4xx to a rejection, which is not retried", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(400, "invalid recipient"));
    const result = await new GmailProvider(deps()).sendMessage(RAW_MIME, EMX);
    expect(result._unsafeUnwrapErr().kind).toBe("provider_send_rejected");
  });

  it("maps 5xx to a retryable failure", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(503, "unavailable"));
    const result = await new GmailProvider(deps()).sendMessage(RAW_MIME, EMX);
    expect(result._unsafeUnwrapErr().kind).toBe("provider_send_failed");
  });
});

describe("OutlookProvider.sendMessage", () => {
  const outlookEmx = { ...EMX, platform: "outlook" as const };

  it("creates the draft from MIME then sends it, reporting both ids", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, { id: "graph-1", internetMessageId: "<abc@outlook.com>" }))
      .mockResolvedValueOnce(jsonResponse(202, {}));

    const result = await new OutlookProvider(deps()).sendMessage(RAW_MIME, outlookEmx);

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
    const result = await new OutlookProvider(deps()).sendMessage(RAW_MIME, outlookEmx);
    expect(result._unsafeUnwrapErr().kind).toBe("provider_send_scope_missing");
  });

  it("maps 403 on the send call to a missing send scope", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, { id: "graph-1" }))
      .mockResolvedValueOnce(errorResponse(403, "Access denied"));
    const result = await new OutlookProvider(deps()).sendMessage(RAW_MIME, outlookEmx);
    expect(result._unsafeUnwrapErr().kind).toBe("provider_send_scope_missing");
  });

  it("maps 5xx to a retryable failure", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(503, "unavailable"));
    const result = await new OutlookProvider(deps()).sendMessage(RAW_MIME, outlookEmx);
    expect(result._unsafeUnwrapErr().kind).toBe("provider_send_failed");
  });
});
