import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { ResultAsync } from "neverthrow";
import { AccountDatabase } from "../database/account-database.js";
import { ArcDatabase } from "../database/arc-database.js";
import { checkDomain } from "../dns/dns-checker.js";
import { isOutstandingArc, buildAccountLogEntry, buildAccountReports, buildRunCompleteLogEntry } from "./staleness-logic.js";
import type { AccountStalenessReport } from "./staleness-logic.js";
import { dbError } from "../errors.js";
import type { Logger } from "../logger.js";

const FROM_ADDRESS = process.env["NOTIFICATION_FROM"] ?? "";
const APP_BASE_URL = process.env["APP_BASE_URL"] ?? "https://app.example.com";

const sesv2 = new SESv2Client({});

export class DomainHealthJob {
  constructor(
    private readonly db: AccountDatabase,
    private readonly arcDb: ArcDatabase,
    private readonly logger: Logger,
  ) {}

  async run(): Promise<void> {
    this.logger.startInvocation();
    const startTime = Date.now();

    const accountsResult = await this.db.scanAllDomains();
    if (accountsResult.isErr()) {
      this.logger.error("Failed to fetch account list for domain health check run. The DynamoDB scan of all domains returned an error. No domains will be checked in this invocation. Investigate DynamoDB table health and retry on next scheduled run.", {
        code: "domain_health.accounts_fetch_failed",
        error: accountsResult.error.cause?.message ?? String(accountsResult.error),
      });
      return;
    }

    const allAccounts = accountsResult.value;
    const reports: AccountStalenessReport[] = [];

    for (const { accountId, domains } of allAccounts) {
      const accountResult = await this.db.getAccount(accountId);
      if (accountResult.isErr()) {
        this.logger.error("Failed to fetch account details during domain health check. The DynamoDB get for the account record returned an error. This account's domains will be skipped. Check DynamoDB read capacity.", {
          code: "domain_health.account_fetch_failed",
          accountId,
          error: accountResult.error.cause?.message ?? String(accountResult.error),
        });
        continue;
      }
      const account = accountResult.value;
      const notifyEmail = account?.notifications?.email?.enabled ? account.notifications.email.address : null;

      for (const domain of domains) {
        const records = await checkDomain(domain);
        const now = new Date().toISOString();
        const failingRecords = records.filter((r) => r.status === "failing").map((r) => r.name);
        const receivingHealthy = records.find((r) => r.type === "MX")?.status === "verified";
        const senderHealthy = records.filter((r) => r.type !== "MX").every((r) => r.status === "verified");
        const allHealthy = failingRecords.length === 0;

        const updateResult = await this.db.updateDomainHealth(accountId, domain.id, {
          receivingHealthy,
          senderHealthy,
          failingRecords,
          lastCheckedAt: now,
          ...(allHealthy ? { lastHealthyAt: now } : {}),
        });
        if (updateResult.isErr()) {
          this.logger.error("Failed to persist domain health check results. The DynamoDB update for the domain record returned an error. Health status won't be reflected in the UI until the next successful check. Check DynamoDB write capacity.", {
            code: "domain_health.update_health_failed",
            accountId,
            domainId: domain.id,
            error: updateResult.error.cause?.message ?? String(updateResult.error),
          });
          continue;
        }

        if (!allHealthy && notifyEmail && FROM_ADDRESS) {
          const body = [
            `DNS health check failed for domain: ${domain.domain}`,
            ``,
            `Failing records:`,
            ...failingRecords.map((r) => `  - ${r}`),
            ``,
            `Review your DNS settings: ${APP_BASE_URL}/domains/${domain.id}`,
          ].join("\n");

          const sendResult = await ResultAsync.fromPromise(
            sesv2.send(new SendEmailCommand({
              FromEmailAddress: FROM_ADDRESS,
              Destination: { ToAddresses: [notifyEmail] },
              Content: {
                Simple: {
                  Subject: { Data: `[DNS Alert] ${domain.domain} has failing records`, Charset: "UTF-8" },
                  Body: { Text: { Data: body, Charset: "UTF-8" } },
                },
              },
            })),
            (e) => dbError(e instanceof Error ? e : new Error(String(e))),
          );
          if (sendResult.isErr()) {
            this.logger.error("Failed to send DNS health alert email to account owner. The SESv2 send call returned an error. The owner won't be notified of failing DNS records. Check SES sending limits and verify the notification from-address.", {
              code: "domain_health.notification_failed",
              accountId,
              domain: domain.domain,
              notifyEmail,
              error: sendResult.error.cause?.message ?? String(sendResult.error),
            });
          }
        }
      }

      // Staleness check: identify outstanding arcs for this account
      const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const staleArcsResult = await this.arcDb.listActiveArcsBefore(accountId, cutoffDate);
      if (staleArcsResult.isErr()) {
        this.logger.error("Failed to query stale arcs for account during staleness check. The DynamoDB query returned an error. This account's staleness report will be skipped. Check DynamoDB read capacity.", {
          code: "staleness_checker.account_error",
          accountId,
          error: staleArcsResult.error.cause?.message ?? String(staleArcsResult.error),
        });
        continue;
      }

      const staleArcs = staleArcsResult.value;
      const outstanding = staleArcs.filter(arc => isOutstandingArc(arc, cutoffDate));
      if (outstanding.length > 0) {
        const [report] = buildAccountReports(outstanding.map(arc => ({
          id: arc.id,
          accountId: arc.accountId,
          lastSignalAt: arc.lastSignalAt,
          urgency: arc.urgency,
          workflow: arc.workflow,
        })));
        reports.push(report!);
        const logEntry = buildAccountLogEntry(report!, new Date().toISOString());
        // buildAccountLogEntry returns { level: "track", message, ...context }
        const { level: _level, message, timestamp: _ts, ...context } = logEntry as Record<string, unknown>;
        this.logger.track(message as string, context);
      }
    }

    const durationMs = Date.now() - startTime;
    const runCompleteEntry = buildRunCompleteLogEntry(reports, durationMs, new Date().toISOString());
    // buildRunCompleteLogEntry returns { level: "info", message, ...context }
    const { level: _level, message, timestamp: _ts, ...context } = runCompleteEntry as Record<string, unknown>;
    this.logger.info(message as string, context);
  }
}
