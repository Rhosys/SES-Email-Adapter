import { describe, it, expect, vi } from "vitest";
import { ok, err } from "../../src/errors.js";
import { ForwardingService } from "../../src/forwarding/forwarding-service.js";
import type { IForwardingTargetStore } from "../../src/forwarding/forwarding-service.js";
import type { IEmailSignalStore } from "../../src/database/email-signal-store.js";
import type { EmailService } from "../../src/email/email-service.js";
import type { ForwardingTarget } from "../../src/types/index.js";
import { createMockLogger } from "../helpers/mock-logger.js";

vi.mock("../../src/email/template-renderer.js", () => ({
  renderTemplate: vi.fn().mockResolvedValue("<html>verify</html>"),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmailService(): EmailService {
  return {
    send: vi.fn().mockResolvedValue(ok({ messageId: "ses-msg-001" })),
    sendRaw: vi.fn().mockResolvedValue(ok({ messageId: "ses-msg-002" })),
  } as unknown as EmailService;
}

function makeTarget(): ForwardingTarget {
  return {
    id: "user@example.com",
    accountId: "acct-test",
    target: "user@example.com",
    type: "email",
    status: "pending",
    token: "tok-abc",
    createdAt: "2025-01-01T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// sendVerification — permanent SES error
// ---------------------------------------------------------------------------

describe("ForwardingService.sendVerification — permanent SES error", () => {
  it("returns ok and logs WARN on permanent SES error — no retry", async () => {
    const emailService = makeEmailService();
    const logger = createMockLogger();
    vi.mocked(emailService.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(err({ kind: "permanent_ses_error", errorName: "MessageRejected", httpStatus: 400, message: "Email address is not verified", cause: new Error("test") }));
    const service = new ForwardingService(
      emailService,
      {} as IForwardingTargetStore,
      {} as IEmailSignalStore,
      "https://app.test",
      "mail.test.com",
      logger,
    );

    const result = await service.sendVerification("acct-test", makeTarget());

    expect(result.isOk()).toBe(true);
    expect(logger.calls.some(c => c.method === "warn" && c.context?.code === "forwarding.verify_send_permanent")).toBe(true);
  });
});
