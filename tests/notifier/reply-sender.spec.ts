import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReplySenderService } from "../../src/notifier/reply-sender.js";
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

describe("ReplySenderService.sendReply()", () => {
  let emailService: EmailService;
  let handler: ReplySenderService;

  beforeEach(() => {
    emailService = makeEmailService();
    handler = new ReplySenderService(emailService, makeLogger());
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

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ messageId: "ses-reply-456" });
  });
});



// ─── Tag Integration ─────────────────────────────────────────────────────────

describe("ReplySenderService tag integration", () => {
  let emailService: EmailService;
  let handler: ReplySenderService;

  beforeEach(() => {
    emailService = makeEmailService();
    handler = new ReplySenderService(emailService, makeLogger());
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
        threadId: "arc-3",
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

});
