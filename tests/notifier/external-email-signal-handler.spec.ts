import { describe, it, expect, vi, beforeEach } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { ExternalEmailSignalHandler } from "../../src/notifier/external-email-signal-handler.js";
import type { EmailService } from "../../src/email/email-service.js";
import { ok } from "../../src/errors.js";
import type { Logger } from "../../src/logger.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEmailService(overrides: Partial<EmailService> = {}): EmailService {
  return {
    send: vi.fn(),
    sendRaw: vi.fn(),
    ...overrides,
  } as unknown as EmailService;
}

function makeLogger(): Logger {
  return { track: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Logger;
}

// ─── sendReply ───────────────────────────────────────────────────────────────

describe("ExternalEmailSignalHandler.sendReply()", () => {
  let emailService: EmailService;
  let handler: ExternalEmailSignalHandler;

  beforeEach(() => {
    emailService = makeEmailService();
    const s3 = {} as S3Client;
    handler = new ExternalEmailSignalHandler(emailService, s3, makeLogger(), "test-bucket");
  });

  it("calls emailService.send with correct options", async () => {
    (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "msg-123" }));

    await handler.sendReply({
      to: "recipient@example.com",
      from: "sender@example.com",
      subject: "Original Subject",
      body: "Reply body text",
      inReplyTo: "<original-id@mail.example.com>",
    });

    expect(emailService.send).toHaveBeenCalledWith({
      to: "recipient@example.com",
      fromOverride: "sender@example.com",
      subject: "Re: Original Subject",
      textBody: "Reply body text",
      headers: [
        { Name: "In-Reply-To", Value: "<original-id@mail.example.com>" },
        { Name: "References", Value: "<original-id@mail.example.com>" },
      ],
      tags: [
        { Name: "type", Value: "reply" },
      ],
    });
  });

  it("returns the messageId from emailService", async () => {
    (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "ses-reply-456" }));

    const result = await handler.sendReply({
      to: "user@test.com",
      from: "noreply@test.com",
      subject: "Test",
      body: "Content",
      inReplyTo: "<abc@test.com>",
    });

    expect(result).toEqual({ messageId: "ses-reply-456" });
  });
});

// ─── forward ─────────────────────────────────────────────────────────────────

describe("ExternalEmailSignalHandler.forward()", () => {
  let emailService: EmailService;
  let s3: S3Client;
  let handler: ExternalEmailSignalHandler;

  beforeEach(() => {
    emailService = makeEmailService();
    s3 = { send: vi.fn() } as unknown as S3Client;
    handler = new ExternalEmailSignalHandler(emailService, s3, makeLogger(), "my-email-bucket");
  });

  it("fetches from S3 with correct bucket/key and calls emailService.sendRaw with raw bytes and tags", async () => {
    const rawBytes = new Uint8Array([72, 101, 108, 108, 111]);
    (s3.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      Body: { transformToByteArray: () => Promise.resolve(rawBytes) },
    });
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "fwd-001" }));

    await handler.forward("emails/abc-123", "dest@example.com", "acct-42");

    expect(s3.send).toHaveBeenCalledWith(
      expect.objectContaining({ input: { Bucket: "my-email-bucket", Key: "emails/abc-123" } }),
    );
    expect(emailService.sendRaw).toHaveBeenCalledWith({
      to: "dest@example.com",
      rawData: rawBytes,
      tags: [
        { Name: "type", Value: "forward" },
        { Name: "accountId", Value: "acct-42" },
      ],
    });
  });

  it("returns Ok on success", async () => {
    const rawBytes = new Uint8Array([1, 2, 3]);
    (s3.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      Body: { transformToByteArray: () => Promise.resolve(rawBytes) },
    });
    (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "fwd-002" }));

    const result = await handler.forward("emails/xyz-789", "user@test.com", "acct-99");

    expect(result.isOk()).toBe(true);
  });
});
