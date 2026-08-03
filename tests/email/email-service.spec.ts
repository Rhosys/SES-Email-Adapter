import { describe, it, expect, vi, beforeEach } from "vitest";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { EmailService } from "../../src/email/email-service.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

// ─── Mock SESv2Client ────────────────────────────────────────────────────────

vi.mock("@aws-sdk/client-sesv2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-sesv2")>();
  return {
    ...actual,
    SESv2Client: vi.fn().mockImplementation(() => ({
      send: vi.fn(),
    })),
  };
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("EmailService.send()", () => {
  let mockSend: ReturnType<typeof vi.fn>;
  let sesClient: SESv2Client;
  let service: EmailService;
  let logger: MockLogger;

  beforeEach(() => {
    mockSend = vi.fn();
    sesClient = { send: mockSend } as unknown as SESv2Client;
    logger = createMockLogger();
    service = new EmailService(sesClient, { from: "noreply@example.com", configSetName: "my-config-set", platformTenantName: "test-platform", mailDomain: "example.com" }, logger);
  });

  it("successful send returns Ok with messageId and logs info", async () => {
    mockSend.mockResolvedValueOnce({ MessageId: "ses-123" });

    const result = await service.send({
      to: "user@example.com",
      subject: "Welcome",
      textBody: "Hello there",
      accountId: "test-platform",
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ messageId: "ses-123" });

    const infoCalls = logger.calls.filter(c => c.method === "info");
    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0]!.context).toEqual(expect.objectContaining({ messageId: "ses-123" }));
  });

  it("MessageRejected with 'Email address is not verified' classified as permanent — returns err with permanent_ses_error and logs error", async () => {
    const sesError = Object.assign(new Error("Email address is not verified. The following identities failed the check in region EU-CENTRAL-1: user@example.com"), {
      name: "MessageRejected",
      $metadata: { httpStatusCode: 400 },
    });
    mockSend.mockRejectedValueOnce(sesError);

    const opts = { to: "user@example.com", subject: "Test", textBody: "Body", accountId: "test-platform" };
    const result = await service.send(opts);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(expect.objectContaining({ kind: "permanent_ses_error", errorName: "MessageRejected", httpStatus: 400 }));

    const errorCalls = logger.calls.filter(c => c.method === "error");
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]!.context).toEqual(expect.objectContaining({ errorName: "MessageRejected", httpStatus: 400, opts }));
  });

  it("MessageRejected without 'Email address is not verified' classified as transient", async () => {
    const sesError = Object.assign(new Error("Email rejected for other reason"), {
      name: "MessageRejected",
      $metadata: { httpStatusCode: 400 },
    });
    mockSend.mockRejectedValueOnce(sesError);

    const result = await service.send({ to: "u@e.com", subject: "S", textBody: "B", accountId: "test-platform" });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("transient_ses_error");
    expect(logger.calls.filter(c => c.method === "warn")).toHaveLength(1);
  });

  it("AccountSendingPausedException classified as transient — returns err", async () => {
    const sesError = Object.assign(new Error("Account paused"), {
      name: "AccountSendingPausedException",
      $metadata: { httpStatusCode: 400 },
    });
    mockSend.mockRejectedValueOnce(sesError);

    const result = await service.send({ to: "u@e.com", subject: "S", textBody: "B", accountId: "test-platform" });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("transient_ses_error");
    expect(logger.calls.filter(c => c.method === "warn")).toHaveLength(1);
  });

  it("4xx HTTP status classified as transient — returns err", async () => {
    const sesError = Object.assign(new Error("Bad request"), {
      name: "SomeOtherError",
      $metadata: { httpStatusCode: 429 },
    });
    mockSend.mockRejectedValueOnce(sesError);

    const result = await service.send({ to: "u@e.com", subject: "S", textBody: "B", accountId: "test-platform" });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("transient_ses_error");
    expect(logger.calls.filter(c => c.method === "warn")).toHaveLength(1);
  });

  it("5xx HTTP status classified as transient — returns err and logs warn", async () => {
    const sesError = Object.assign(new Error("Internal error"), {
      name: "ServiceUnavailable",
      $metadata: { httpStatusCode: 500 },
    });
    mockSend.mockRejectedValueOnce(sesError);

    const opts = { to: "u@e.com", subject: "S", textBody: "B", accountId: "test-platform" };
    const result = await service.send(opts);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toEqual({
      kind: "transient_ses_error",
      errorName: "ServiceUnavailable",
      httpStatus: 500,
      cause: sesError,
    });

    const warnCalls = logger.calls.filter(c => c.method === "warn");
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]!.context).toEqual(expect.objectContaining({ errorName: "ServiceUnavailable", httpStatus: 500, opts }));
  });

  it("network error (no httpStatus) classified as transient — httpStatus is 0", async () => {
    const networkError = new Error("ECONNRESET");
    mockSend.mockRejectedValueOnce(networkError);

    const result = await service.send({ to: "u@e.com", subject: "S", textBody: "B", accountId: "test-platform" });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe("transient_ses_error");
    if (error.kind !== "transient_ses_error") throw new Error("unexpected error kind");
    expect(error.httpStatus).toBe(0);
    expect(error.cause).toBe(networkError);

    expect(logger.calls.filter(c => c.method === "warn")).toHaveLength(1);
  });

  it("only 'Email address is not verified' MessageRejected is permanent — other MessageRejected errors are transient", async () => {
    const sesError = Object.assign(new Error("Email address is not verified. The following identities failed the check in region EU-CENTRAL-1: x@x.com"), {
      name: "MessageRejected",
      $metadata: { httpStatusCode: 400 },
    });
    mockSend.mockRejectedValueOnce(sesError);

    const result = await service.send({ to: "u@e.com", subject: "S", textBody: "B", accountId: "test-platform" });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(expect.objectContaining({ kind: "permanent_ses_error", errorName: "MessageRejected", httpStatus: 400 }));
  });

  it("fromOverride used when provided", async () => {
    mockSend.mockResolvedValueOnce({ MessageId: "ses-msg-003" });

    await service.send({
      to: "user@example.com",
      subject: "Reply",
      textBody: "Body",
      fromOverride: "custom-sender@example.com",
      accountId: "test-platform",
    });

    const command = mockSend.mock.calls[0]![0] as SendEmailCommand;
    expect(command.input.FromEmailAddress).toBe("custom-sender@example.com");
  });

  it("headers included when provided", async () => {
    mockSend.mockResolvedValueOnce({ MessageId: "ses-msg-004" });

    await service.send({
      to: "user@example.com",
      subject: "With headers",
      textBody: "Body",
      accountId: "test-platform",
      headers: [
        { Name: "In-Reply-To", Value: "<original-msg-id@example.com>" },
        { Name: "References", Value: "<ref-1@example.com>" },
      ],
    });

    const command = mockSend.mock.calls[0]![0] as SendEmailCommand;
    expect(command.input.Content?.Simple?.Headers).toEqual([
      { Name: "In-Reply-To", Value: "<original-msg-id@example.com>" },
      { Name: "References", Value: "<ref-1@example.com>" },
    ]);
  });

  it("sanitizes SES message tags — strips invalid chars, truncates, drops empties", async () => {
    mockSend.mockResolvedValueOnce({ MessageId: "ses-tag-001" });

    await service.send({
      to: "user@example.com",
      subject: "Tagged",
      textBody: "Body",
      accountId: "test-platform",
      tags: [
        // '@' and '.' are invalid in tag values and get stripped
        { Name: "X-Numaeel-Healthcheck-Id", Value: "healthcheck-2026-07-08@platform.email.rhosys.cloud" },
        { Name: "purpose", Value: "healthcheck" },
        // sanitizes to a non-empty name but an empty value → dropped entirely
        { Name: "Bad Name!", Value: "@@@" },
        // over-long value is truncated to 255 chars
        { Name: "Long", Value: "x".repeat(300) },
      ],
    });

    const command = mockSend.mock.calls[0]![0] as SendEmailCommand;
    const tags = command.input.EmailTags!;
    expect(tags).toContainEqual({ Name: "X-Numaeel-Healthcheck-Id", Value: "healthcheck-2026-07-08platformemailrhosyscloud" });
    expect(tags).toContainEqual({ Name: "purpose", Value: "healthcheck" });
    expect(tags.find(t => t.Name === "BadName")).toBeUndefined();
    expect(tags.find(t => t.Name === "Long")!.Value).toHaveLength(255);
    expect(tags).toHaveLength(3);
  });
});

describe("EmailService.sendRaw()", () => {
  let mockSend: ReturnType<typeof vi.fn>;
  let sesClient: SESv2Client;
  let service: EmailService;
  let logger: MockLogger;

  beforeEach(() => {
    mockSend = vi.fn();
    sesClient = { send: mockSend } as unknown as SESv2Client;
    logger = createMockLogger();
    service = new EmailService(sesClient, { from: "noreply@example.com", configSetName: "my-config-set", platformTenantName: "test-platform", mailDomain: "example.com" }, logger);
  });

  it("successful raw send returns Ok with messageId and logs info", async () => {
    mockSend.mockResolvedValueOnce({ MessageId: "ses-raw-001" });
    const rawData = new Uint8Array([77, 73, 77, 69]);

    const result = await service.sendRaw({ to: "r@e.com", rawData, accountId: "acct-test" });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ messageId: "ses-raw-001" });

    const infoCalls = logger.calls.filter(c => c.method === "info");
    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0]!.context).toEqual(expect.objectContaining({ messageId: "ses-raw-001" }));
  });

  it("5xx error returns transient err and logs warn", async () => {
    const sesError = Object.assign(new Error("Service unavailable"), {
      name: "ServiceUnavailable",
      $metadata: { httpStatusCode: 503 },
    });
    mockSend.mockRejectedValueOnce(sesError);

    const result = await service.sendRaw({ to: "r@e.com", rawData: new Uint8Array([1]), accountId: "acct-test" });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("transient_ses_error");
    expect(logger.calls.filter(c => c.method === "warn")).toHaveLength(1);
  });

  it("unverified identity error returns err with permanent_ses_error", async () => {
    const sesError = Object.assign(new Error("Email address is not verified. The following identities failed the check in region EU-CENTRAL-1: x@x.com"), {
      name: "MessageRejected",
      $metadata: { httpStatusCode: 400 },
    });
    mockSend.mockRejectedValueOnce(sesError);

    const result = await service.sendRaw({ to: "r@e.com", rawData: new Uint8Array([1]), accountId: "acct-test" });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(expect.objectContaining({ kind: "permanent_ses_error", errorName: "MessageRejected", httpStatus: 400 }));
    expect(logger.calls.filter(c => c.method === "error")).toHaveLength(1);
  });
});
