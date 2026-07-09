import { describe, it, expect, vi } from "vitest";
import { DateTime } from "luxon";
import { createMockLogger } from "../helpers/mock-logger.js";
import { ok } from "../../src/errors.js";

vi.mock("../../src/email/template-renderer.js", () => ({
  renderTemplate: vi.fn().mockResolvedValue("<html>mock</html>"),
}));

import { HealthcheckJob, type HealthcheckJobDeps } from "../../src/jobs/healthcheck-job.js";

/**
 * Property 2: Deterministic per-day healthcheck identity
 *
 * SES does not allow setting a custom Message-ID header, so the healthcheck's
 * deterministic per-day identity is carried by its subject, `Healthcheck
 * YYYY-MM-DD` (UTC). For any two invocations on the same UTC date (regardless of
 * time of day) the subject is identical, and the message-id shown in the email
 * body follows the same deterministic date.
 *
 * **Validates: Requirements 5.1, 5.3**
 */

const MAIL_DOMAIN = "platform.email.rhosys.cloud";

function createMockDeps(overrides: Partial<HealthcheckJobDeps> = {}): HealthcheckJobDeps {
  return {
    threadDb: { listThreads: vi.fn().mockResolvedValue(ok({ items: [] })) } as unknown as HealthcheckJobDeps["threadDb"],
    emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-123" })) } as unknown as HealthcheckJobDeps["emailService"],
    searchDatabase: { hasEmbedding: vi.fn().mockResolvedValue(false) },
    mailDomain: MAIL_DOMAIN,
    logger: createMockLogger(),
    ...overrides,
  };
}

describe("Property 2: Deterministic per-day healthcheck identity", () => {
  describe("subject is 'Healthcheck YYYY-MM-DD' for multiple dates", () => {
    const dateCases = [
      { label: "start of year", date: "2025-01-01" },
      { label: "leap day", date: "2024-02-29" },
      { label: "end of year", date: "2025-12-31" },
      { label: "mid-year", date: "2025-07-07" },
      { label: "single-digit month and day", date: "2025-03-05" },
      { label: "year boundary", date: "2023-12-31" },
      { label: "far future", date: "2030-06-15" },
    ];

    it.each(dateCases)("$label ($date) → subject matches expected format", async ({ date }) => {
      const sendSpy = vi.fn().mockResolvedValue(ok({ messageId: "ses-msg-id" }));
      const deps = createMockDeps({ emailService: { send: sendSpy } as unknown as HealthcheckJobDeps["emailService"] });
      const job = new HealthcheckJob(deps);

      const fakeNow = DateTime.fromISO(`${date}T12:00:00.000Z`, { zone: "utc" });
      vi.spyOn(DateTime, "utc").mockReturnValue(fakeNow as unknown as DateTime<true>);

      await job.run();

      expect(sendSpy).toHaveBeenCalledOnce();
      const sendArgs = sendSpy.mock.calls[0]![0] as { subject: string; textBody: string; tags: Array<{ Name: string; Value: string }> };
      expect(sendArgs.subject).toBe(`Healthcheck ${date}`);
      // The message-id shown in the body follows the same deterministic date.
      expect(sendArgs.textBody).toContain(`healthcheck-${date}@${MAIL_DOMAIN}`);
      // A tag-safe healthcheck id is attached for bounce/complaint correlation.
      expect(sendArgs.tags).toEqual(expect.arrayContaining([
        { Name: "X-Numaeel-Healthcheck-Id", Value: `healthcheck-${date}` },
      ]));

      vi.restoreAllMocks();
    });
  });

  describe("same date produces identical subject regardless of time of day", () => {
    const timeCases = [
      { label: "midnight", iso: "2025-07-07T00:00:00.000Z" },
      { label: "early morning (trigger time)", iso: "2025-07-07T06:00:00.000Z" },
      { label: "noon", iso: "2025-07-07T12:00:00.000Z" },
      { label: "late evening", iso: "2025-07-07T23:59:59.999Z" },
    ];

    it("all times on same date produce identical subject", async () => {
      const results: string[] = [];

      for (const { iso } of timeCases) {
        const sendSpy = vi.fn().mockResolvedValue(ok({ messageId: "ses-msg-id" }));
        const deps = createMockDeps({ emailService: { send: sendSpy } as unknown as HealthcheckJobDeps["emailService"] });
        const job = new HealthcheckJob(deps);

        const fakeNow = DateTime.fromISO(iso, { zone: "utc" });
        vi.spyOn(DateTime, "utc").mockReturnValue(fakeNow as unknown as DateTime<true>);

        await job.run();

        const sendArgs = sendSpy.mock.calls[0]![0] as { subject: string };
        results.push(sendArgs.subject);

        vi.restoreAllMocks();
      }

      const unique = new Set(results);
      expect(unique.size).toBe(1);
      expect(results[0]).toBe("Healthcheck 2025-07-07");
    });
  });
});
