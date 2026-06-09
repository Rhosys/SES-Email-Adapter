import { describe, it, expect, vi, beforeEach } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { ExternalEmailSignalHandler } from "../../src/notifier/external-email-signal-handler.js";
import type { EmailService } from "../../src/email/email-service.js";
import { ok } from "../../src/errors.js";
import type { Logger } from "../../src/logger.js";
import { TAG_TYPE, TAG_ACCOUNT_ID, TAG_SIGNAL_ID, TAG_ARC_ID } from "../../src/email/ses-tags.js";

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
      accountId: "acct-test",
    });

    expect(emailService.send).toHaveBeenCalledWith({
      to: "recipient@example.com",
      fromOverride: "sender@example.com",
      subject: "Re: Original Subject",
      textBody: "Reply body text",
      accountId: "acct-test",
      headers: [
        { Name: "In-Reply-To", Value: "<original-id@mail.example.com>" },
        { Name: "References", Value: "<original-id@mail.example.com>" },
      ],
      tags: [
        { Name: "X-Numaeel-Type", Value: "reply" },
        { Name: "X-Numaeel-AccountId", Value: "acct-test" },
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
      accountId: "acct-test",
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
      accountId: "acct-42",
      tags: [
        { Name: "X-Numaeel-Type", Value: "forward" },
        { Name: "X-Numaeel-AccountId", Value: "acct-42" },
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

// ─── Tag Integration ─────────────────────────────────────────────────────────

describe("ExternalEmailSignalHandler tag integration", () => {
  let emailService: EmailService;
  let handler: ExternalEmailSignalHandler;

  beforeEach(() => {
    emailService = makeEmailService();
    const s3 = { send: vi.fn() } as unknown as S3Client;
    handler = new ExternalEmailSignalHandler(emailService, s3, makeLogger(), "test-bucket");
  });

  describe("sendReply tags", () => {
    it("without optional fields → tags = [Type:reply]", async () => {
      (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "m-1" }));

      await handler.sendReply({
        to: "a@b.com",
        from: "c@d.com",
        subject: "Hi",
        body: "Hello",
        inReplyTo: "<ref@x.com>",
        accountId: "acct-test",
      });

      const call = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.tags).toEqual([
        { Name: TAG_TYPE, Value: "reply" },
        { Name: TAG_ACCOUNT_ID, Value: "acct-test" },
      ]);
    });

    it("with all fields → tags include AccountId, SignalId, ArcId", async () => {
      (emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "m-2" }));

      await handler.sendReply({
        to: "a@b.com",
        from: "c@d.com",
        subject: "Hi",
        body: "Hello",
        inReplyTo: "<ref@x.com>",
        accountId: "acct-1",
        signalId: "sig-2",
        arcId: "arc-3",
      });

      const call = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.tags).toEqual([
        { Name: TAG_TYPE, Value: "reply" },
        { Name: TAG_ACCOUNT_ID, Value: "acct-1" },
        { Name: TAG_SIGNAL_ID, Value: "sig-2" },
        { Name: TAG_ARC_ID, Value: "arc-3" },
      ]);
    });
  });

  describe("forward tags", () => {
    it("without opts → tags = [Type:forward, AccountId:X]", async () => {
      const rawBytes = new Uint8Array([1, 2]);
      const s3 = { send: vi.fn() } as unknown as S3Client;
      const h = new ExternalEmailSignalHandler(emailService, s3, makeLogger(), "bucket");
      (s3.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        Body: { transformToByteArray: () => Promise.resolve(rawBytes) },
      });
      (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "f-1" }));

      await h.forward("key/1", "to@x.com", "acct-7");

      const call = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.tags).toEqual([
        { Name: TAG_TYPE, Value: "forward" },
        { Name: TAG_ACCOUNT_ID, Value: "acct-7" },
      ]);
    });

    it("with signalId + arcId → tags include all four", async () => {
      const rawBytes = new Uint8Array([3, 4]);
      const s3 = { send: vi.fn() } as unknown as S3Client;
      const h = new ExternalEmailSignalHandler(emailService, s3, makeLogger(), "bucket");
      (s3.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        Body: { transformToByteArray: () => Promise.resolve(rawBytes) },
      });
      (emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ messageId: "f-2" }));

      await h.forward("key/2", "to@y.com", "acct-8", { signalId: "sig-5", arcId: "arc-6" });

      const call = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.tags).toEqual([
        { Name: TAG_TYPE, Value: "forward" },
        { Name: TAG_ACCOUNT_ID, Value: "acct-8" },
        { Name: TAG_SIGNAL_ID, Value: "sig-5" },
        { Name: TAG_ARC_ID, Value: "arc-6" },
      ]);
    });
  });
});
