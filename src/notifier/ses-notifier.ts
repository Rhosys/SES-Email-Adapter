import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { Notifier } from "../processor/processor.js";
import type { Arc, Signal, Account } from "../types/index.js";

const TABLE = process.env["DYNAMODB_TABLE"] ?? "ses-signals";
const FROM_ADDRESS = process.env["NOTIFICATION_FROM"] ?? "";
const CONFIG_SET = process.env["SES_CONFIGURATION_SET"] ?? "";
const APP_BASE_URL = process.env["APP_BASE_URL"] ?? "https://app.example.com";

const sesv2 = new SESv2Client({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export class SesNotifier implements Notifier {
  async notify(accountId: string, arc: Arc, signal: Signal): Promise<void> {
    const [account, suppressed] = await Promise.all([
      this.getAccount(accountId),
      this.isAddressSuppressed(FROM_ADDRESS),
    ]);

    const emailSettings = account?.notifications?.email;
    if (!emailSettings?.enabled || !emailSettings.address) return;
    if (emailSettings.frequency !== "instant") return; // hourly/daily batching handled by scheduled job
    if (await this.isAddressSuppressed(emailSettings.address)) return;
    if (suppressed) return; // our from address is bouncing — infra issue

    const subject = `[${signal.workflow}] ${signal.subject}`;
    const body = [
      `From: ${signal.from.name ? `${signal.from.name} <${signal.from.address}>` : signal.from.address}`,
      `Subject: ${signal.subject}`,
      `Received: ${signal.receivedAt}`,
      ``,
      signal.summary,
      ``,
      `View in app: ${APP_BASE_URL}/arcs/${arc.id}`,
    ].join("\n");

    await sesv2.send(new SendEmailCommand({
      FromEmailAddress: FROM_ADDRESS,
      Destination: { ToAddresses: [emailSettings.address] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: { Text: { Data: body, Charset: "UTF-8" } },
          Headers: [
            { Name: "List-Unsubscribe", Value: `<${APP_BASE_URL}/account/notifications>` },
            { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
          ],
        },
      },
      ...(CONFIG_SET ? { ConfigurationSetName: CONFIG_SET } : {}),
      EmailTags: [
        { Name: "accountId", Value: accountId },
        { Name: "workflow", Value: signal.workflow },
        { Name: "type", Value: "signal_notify" },
      ],
    }));
  }

  async notifyBlocked(accountId: string, signal: Signal): Promise<void> {
    const account = await this.getAccount(accountId);
    const emailSettings = account?.notifications?.email;
    if (!emailSettings?.enabled || !emailSettings.address) return;
    if (emailSettings.frequency !== "instant") return;
    if (await this.isAddressSuppressed(emailSettings.address)) return;

    const body = [
      `A signal was blocked before reaching your inbox.`,
      ``,
      `From: ${signal.from.address}`,
      `Subject: ${signal.subject}`,
      `Reason: ${signal.blockReason ?? "unknown"}`,
      ``,
      `To allow this sender, visit: ${APP_BASE_URL}/account/email-configs`,
    ].join("\n");

    await sesv2.send(new SendEmailCommand({
      FromEmailAddress: FROM_ADDRESS,
      Destination: { ToAddresses: [emailSettings.address] },
      Content: {
        Simple: {
          Subject: { Data: `[Blocked] ${signal.subject}`, Charset: "UTF-8" },
          Body: { Text: { Data: body, Charset: "UTF-8" } },
          Headers: [
            { Name: "List-Unsubscribe", Value: `<${APP_BASE_URL}/account/notifications>` },
            { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
          ],
        },
      },
      ...(CONFIG_SET ? { ConfigurationSetName: CONFIG_SET } : {}),
      EmailTags: [
        { Name: "accountId", Value: accountId },
        { Name: "type", Value: "signal_blocked" },
      ],
    }));
  }

  private async getAccount(accountId: string): Promise<Account | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `ACCT#${accountId}`, sk: "ACCOUNT" },
    }));
    return result.Item ? (result.Item as Account) : null;
  }

  private async isAddressSuppressed(address: string): Promise<boolean> {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `SUPPRESS#${address}`, sk: "SUPPRESS" },
      ProjectionExpression: "address",
    }));
    return result.Item !== undefined;
  }
}
