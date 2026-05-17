import { describe, it, expect, vi, beforeEach } from "vitest";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { EmailService } from "../../src/email/email-service.js";

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

  beforeEach(() => {
    mockSend = vi.fn();
    sesClient = { send: mockSend } as unknown as SESv2Client;
    service = new EmailService(sesClient, { from: "noreply@example.com", configSet: "my-config-set" });
  });

  it("successful send returns Ok with messageId", async () => {
    mockSend.mockResolvedValueOnce({ MessageId: "ses-msg-001" });

    const result = await service.send({
      to: "user@example.com",
      subject: "Welcome",
      textBody: "Hello there",
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ messageId: "ses-msg-001" });

    const command = mockSend.mock.calls[0]![0] as SendEmailCommand;
    expect(command.input.FromEmailAddress).toBe("noreply@example.com");
    expect(command.input.Destination).toEqual({ ToAddresses: ["user@example.com"] });
    expect(command.input.Content?.Simple?.Subject).toEqual({ Data: "Welcome", Charset: "UTF-8" });
    expect(command.input.Content?.Simple?.Body?.Text).toEqual({ Data: "Hello there", Charset: "UTF-8" });
    expect(command.input.ConfigurationSetName).toBe("my-config-set");
  });

  it("SES error returns Err with DbError", async () => {
    mockSend.mockRejectedValueOnce(new Error("SES rate limit exceeded"));

    const result = await service.send({
      to: "user@example.com",
      subject: "Test",
      textBody: "Body",
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "db_error",
      cause: expect.any(Error),
    });
  });

  it("configSet omitted when empty string", async () => {
    const serviceNoConfig = new EmailService(sesClient, { from: "noreply@example.com", configSet: "" });
    mockSend.mockResolvedValueOnce({ MessageId: "ses-msg-002" });

    await serviceNoConfig.send({
      to: "user@example.com",
      subject: "No config set",
      textBody: "Body",
    });

    const command = mockSend.mock.calls[0]![0] as SendEmailCommand;
    expect(command.input).not.toHaveProperty("ConfigurationSetName");
  });

  it("fromOverride used when provided", async () => {
    mockSend.mockResolvedValueOnce({ MessageId: "ses-msg-003" });

    await service.send({
      to: "user@example.com",
      subject: "Reply",
      textBody: "Body",
      fromOverride: "custom-sender@example.com",
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
});

describe("EmailService.sendRaw()", () => {
  let mockSend: ReturnType<typeof vi.fn>;
  let sesClient: SESv2Client;
  let service: EmailService;

  beforeEach(() => {
    mockSend = vi.fn();
    sesClient = { send: mockSend } as unknown as SESv2Client;
    service = new EmailService(sesClient, { from: "noreply@example.com", configSet: "my-config-set" });
  });

  it("successful raw send returns Ok with messageId and uses Content.Raw.Data", async () => {
    mockSend.mockResolvedValueOnce({ MessageId: "ses-raw-001" });
    const rawData = new Uint8Array([77, 73, 77, 69, 45, 86, 101, 114, 115, 105, 111, 110]);

    const result = await service.sendRaw({
      to: "recipient@example.com",
      rawData,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ messageId: "ses-raw-001" });

    const command = mockSend.mock.calls[0]![0] as SendEmailCommand;
    expect(command.input.FromEmailAddress).toBe("noreply@example.com");
    expect(command.input.Destination).toEqual({ ToAddresses: ["recipient@example.com"] });
    expect(command.input.Content?.Raw?.Data).toBe(rawData);
    expect(command.input.ConfigurationSetName).toBe("my-config-set");
  });

  it("SES error returns Err with DbError", async () => {
    mockSend.mockRejectedValueOnce(new Error("SES service unavailable"));

    const result = await service.sendRaw({
      to: "recipient@example.com",
      rawData: new Uint8Array([1, 2, 3]),
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "db_error",
      cause: expect.any(Error),
    });
  });
});
