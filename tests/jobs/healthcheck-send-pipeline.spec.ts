import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok } from "neverthrow";
import { DateTime } from "luxon";
import { HealthcheckJob } from "../../src/jobs/healthcheck-job.js";
import { HealthcheckValidator } from "../../src/jobs/healthcheck-validator.js";
import { EmailService } from "../../src/email/email-service.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { checkDomain } from "../../src/dns/dns-checker.js";
import type { ThreadMatcher } from "../../src/database/thread-matcher.js";
import type { SesIdentityChecker } from "../../src/email/ses-identity-checker.js";

// ---------------------------------------------------------------------------
// Component test: Healthcheck Send Pipeline
//
// Validates the exact data that reaches SES when the healthcheck job runs.
// Exercises the full component chain: HealthcheckJob → HealthcheckValidator →
// EmailService → SESv2Client. The SES client is the mocked boundary — we
// assert on the exact SendEmailCommand payload to catch regressions in:
//   - recipient address
//   - from address
//   - SES TenantName
//   - email tags (purpose, healthcheck-id)
//   - configuration set name
//   - subject and body content structure
// ---------------------------------------------------------------------------

vi.mock("node:dns/promises", () => ({
  default: {
    resolveMx: vi.fn().mockResolvedValue([{ exchange: "mx.platform.email.rhosys.cloud", priority: 10 }]),
    resolveTxt: vi.fn().mockImplementation((name: string) => {
      if (name.startsWith("mail._domainkey")) return Promise.resolve([["v=DKIM1; k=rsa; p=fake"]]);
      if (name.startsWith("bounce.")) return Promise.resolve([["v=spf1 include:amazonses.com ~all"]]);
      if (name.startsWith("_dmarc.")) return Promise.resolve([["v=DMARC1; p=none"]]);
      return Promise.resolve([]);
    }),
  },
}));

vi.mock("../../src/dns/dns-checker.js", () => ({
  checkDomain: vi.fn().mockResolvedValue([
    { name: "healthcheck.platform.email.rhosys.cloud", type: "MX", value: "10 mx.platform.email.rhosys.cloud", status: "verified" },
    { name: "mail._domainkey.healthcheck.platform.email.rhosys.cloud", type: "CNAME", value: "mail._domainkey.platform.email.rhosys.cloud", status: "verified" },
    { name: "bounce.healthcheck.platform.email.rhosys.cloud", type: "CNAME", value: "bounce.platform.email.rhosys.cloud", status: "verified" },
    { name: "_dmarc.healthcheck.platform.email.rhosys.cloud", type: "CNAME", value: "_dmarc.platform.email.rhosys.cloud", status: "verified" },
  ]),
}));

vi.mock("../../src/email/template-renderer.js", () => ({
  renderTemplate: vi.fn().mockResolvedValue("<html><body>Healthcheck</body></html>"),
}));

const MAIL_DOMAIN = "platform.email.rhosys.cloud";
const CONFIG_SET = "email-catcher-config-set";
const FROM_ADDRESS = `noreply@${MAIL_DOMAIN}`;
const PLATFORM_TENANT = "platform-tenant";

const YESTERDAY = DateTime.utc().minus({ days: 1 }).toFormat("yyyy-MM-dd");
const TODAY = DateTime.utc().toFormat("yyyy-MM-dd");

function makeThread(overrides: { id?: string; workflow?: string; createdAt?: string } = {}) {
  const createdAt = overrides.createdAt ?? `${YESTERDAY}T06:00:00.000Z`;
  return {
    id: overrides.id ?? "thr-hc",
    accountId: "SYSTEM",
    workflow: overrides.workflow ?? "healthcheck",
    labels: [],
    status: "active",
    summary: "Healthcheck",
    lastSignalAt: createdAt,
    createdAt,
    updatedAt: createdAt,
    sender: { address: `healthcheck@${MAIL_DOMAIN}` },
    recipientAddress: `healthcheck@healthcheck.${MAIL_DOMAIN}`,
    subject: `Healthcheck ${YESTERDAY}`,
  };
}

describe("Healthcheck send pipeline — SES interface contract", () => {
  let sesSendCalls: Array<{ input: Record<string, unknown> }>;
  let mockSesClient: { send: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    sesSendCalls = [];
    mockSesClient = {
      send: vi.fn().mockImplementation((cmd: { input: Record<string, unknown> }) => {
        sesSendCalls.push(cmd);
        return Promise.resolve({ MessageId: "ses-mock-msg-id-001" });
      }),
    };
  });

  function buildPipeline(threads: ReturnType<typeof makeThread>[] = [makeThread()]) {
    const logger = createMockLogger();

    const emailService = new EmailService(
      mockSesClient as never,
      { from: FROM_ADDRESS, configSetName: CONFIG_SET, platformTenantName: PLATFORM_TENANT, mailDomain: MAIL_DOMAIN },
      logger,
    );

    const validator = new HealthcheckValidator({
      threadDb: { listActiveThreadsSince: vi.fn().mockResolvedValue(ok(threads)) } as never,
      searchDatabase: { hasEmbedding: vi.fn().mockResolvedValue(ok(true)) } as unknown as ThreadMatcher,
      sesChecker: { canSendFrom: vi.fn().mockResolvedValue({ verified: true, dkimEnabled: true, accountSendingEnabled: true }) } as unknown as SesIdentityChecker,
      dnsChecker: { checkDomain },
      mailDomain: MAIL_DOMAIN,
      emailBucket: "test-emails-bucket",
      logGroupName: "/aws/lambda/test-function",
      logger,
    });

    const job = new HealthcheckJob({
      threadDb: { listActiveThreadsSince: vi.fn().mockResolvedValue(ok(threads)) } as never,
      emailService,
      validator,
      mailDomain: MAIL_DOMAIN,
      logger,
    });

    return { job, logger, emailService };
  }

  it("sends to the correct recipient on the healthcheck subdomain", async () => {
    const { job } = buildPipeline();
    await job.run();

    expect(sesSendCalls).toHaveLength(1);
    const input = sesSendCalls[0]!.input;
    expect(input.Destination).toEqual({ ToAddresses: [`healthcheck@healthcheck.${MAIL_DOMAIN}`] });
  });

  it("sends from the platform noreply address", async () => {
    const { job } = buildPipeline();
    await job.run();

    const input = sesSendCalls[0]!.input;
    expect(input.FromEmailAddress).toBe(FROM_ADDRESS);
  });

  it("uses SYSTEM as TenantName for SES multi-tenant routing", async () => {
    const { job } = buildPipeline();
    await job.run();

    const input = sesSendCalls[0]!.input;
    expect(input.TenantName).toBe("SYSTEM");
  });

  it("includes the configuration set name", async () => {
    const { job } = buildPipeline();
    await job.run();

    const input = sesSendCalls[0]!.input;
    expect(input.ConfigurationSetName).toBe(CONFIG_SET);
  });

  it("includes X-Numaeel-Purpose=healthcheck and X-Numaeel-Healthcheck-Id tags", async () => {
    const { job } = buildPipeline();
    await job.run();

    const input = sesSendCalls[0]!.input;
    const tags = input.EmailTags as Array<{ Name: string; Value: string }>;
    expect(tags).toContainEqual({ Name: "X-Numaeel-Purpose", Value: "healthcheck" });
    expect(tags).toContainEqual({ Name: "X-Numaeel-Healthcheck-Id", Value: `healthcheck-${TODAY}` });
  });

  it("sets subject to 'Healthcheck <today>'", async () => {
    const { job } = buildPipeline();
    await job.run();

    const input = sesSendCalls[0]!.input;
    const content = input.Content as { Simple: { Subject: { Data: string } } };
    expect(content.Simple.Subject.Data).toBe(`Healthcheck ${TODAY}`);
  });

  it("includes both HTML and plain text body", async () => {
    const { job } = buildPipeline();
    await job.run();

    const input = sesSendCalls[0]!.input;
    const content = input.Content as { Simple: { Body: { Text?: { Data: string }; Html?: { Data: string } } } };
    expect(content.Simple.Body.Text?.Data).toBeTruthy();
    expect(content.Simple.Body.Html?.Data).toBeTruthy();
  });

  it("plain text body contains pipeline healthcheck identifier", async () => {
    const { job } = buildPipeline();
    await job.run();

    const input = sesSendCalls[0]!.input;
    const content = input.Content as { Simple: { Body: { Text: { Data: string } } } };
    expect(content.Simple.Body.Text.Data).toContain("Pipeline Healthcheck");
    expect(content.Simple.Body.Text.Data).toContain(TODAY);
  });

  it("uses UTF-8 charset for subject and body", async () => {
    const { job } = buildPipeline();
    await job.run();

    const input = sesSendCalls[0]!.input;
    const content = input.Content as { Simple: { Subject: { Charset: string }; Body: { Text: { Charset: string }; Html: { Charset: string } } } };
    expect(content.Simple.Subject.Charset).toBe("UTF-8");
    expect(content.Simple.Body.Text.Charset).toBe("UTF-8");
    expect(content.Simple.Body.Html.Charset).toBe("UTF-8");
  });

  it("full SES payload structure matches the expected shape", async () => {
    const { job } = buildPipeline();
    await job.run();

    expect(sesSendCalls).toHaveLength(1);
    const input = sesSendCalls[0]!.input;

    // Validate the full shape in one assertion for regression detection
    expect(input).toEqual({
      FromEmailAddress: FROM_ADDRESS,
      Destination: { ToAddresses: [`healthcheck@healthcheck.${MAIL_DOMAIN}`] },
      Content: {
        Simple: {
          Subject: { Data: `Healthcheck ${TODAY}`, Charset: "UTF-8" },
          Body: {
            Text: { Data: expect.stringContaining("Pipeline Healthcheck"), Charset: "UTF-8" },
            Html: { Data: expect.any(String), Charset: "UTF-8" },
          },
          Headers: [
            { Name: "X-Numaeel-Purpose", Value: "healthcheck" },
            { Name: "X-Numaeel-Healthcheck-Id", Value: `healthcheck-${TODAY}` },
          ],
        },
      },
      ConfigurationSetName: CONFIG_SET,
      TenantName: "SYSTEM",
      EmailTags: expect.arrayContaining([
        { Name: "X-Numaeel-Purpose", Value: "healthcheck" },
        { Name: "X-Numaeel-Healthcheck-Id", Value: `healthcheck-${TODAY}` },
      ]),
    });
  });
});
