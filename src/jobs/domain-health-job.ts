import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { AccountDatabase } from "../database/account-database.js";
import { checkDomain } from "../dns/dns-checker.js";

const FROM_ADDRESS = process.env["NOTIFICATION_FROM"] ?? "";
const APP_BASE_URL = process.env["APP_BASE_URL"] ?? "https://app.example.com";

const sesv2 = new SESv2Client({});
const db = new AccountDatabase();

export async function handler(): Promise<void> {
  const allAccounts = await db.scanAllDomains();

  await Promise.all(allAccounts.map(async ({ accountId, domains }) => {
    const account = await db.getAccount(accountId);
    const notifyEmail = account?.notifications?.email?.enabled ? account.notifications.email.address : null;

    for (const domain of domains) {
      const records = await checkDomain(domain);
      const now = new Date().toISOString();
      const failingRecords = records.filter((r) => r.status === "failing").map((r) => r.name);
      const receivingHealthy = records.find((r) => r.type === "MX")?.status === "verified";
      const senderHealthy = records.filter((r) => r.type !== "MX").every((r) => r.status === "verified");
      const allHealthy = failingRecords.length === 0;

      await db.updateDomainHealth(accountId, domain.id, {
        receivingHealthy,
        senderHealthy,
        failingRecords,
        lastCheckedAt: now,
        ...(allHealthy ? { lastHealthyAt: now } : {}),
      });

      if (!allHealthy && notifyEmail && FROM_ADDRESS) {
        const body = [
          `DNS health check failed for domain: ${domain.domain}`,
          ``,
          `Failing records:`,
          ...failingRecords.map((r) => `  - ${r}`),
          ``,
          `Review your DNS settings: ${APP_BASE_URL}/domains/${domain.id}`,
        ].join("\n");

        await sesv2.send(new SendEmailCommand({
          FromEmailAddress: FROM_ADDRESS,
          Destination: { ToAddresses: [notifyEmail] },
          Content: {
            Simple: {
              Subject: { Data: `[DNS Alert] ${domain.domain} has failing records`, Charset: "UTF-8" },
              Body: { Text: { Data: body, Charset: "UTF-8" } },
            },
          },
        })).catch((e) => console.error(`Failed to notify ${notifyEmail} for domain ${domain.domain}:`, e));
      }
    }
  }));
}
