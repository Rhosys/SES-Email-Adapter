import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import webpush from "web-push";
import type { Notifier } from "../processor/processor.js";
import type { Arc, Signal, Account, PushSubscription, AuthData } from "../types/index.js";

const ACCOUNTS_TABLE = process.env["ACCOUNTS_TABLE"] ?? "ses-accounts";
const PROCESSING_TABLE = process.env["PROCESSING_TABLE"] ?? "ses-processing";
const FROM_ADDRESS = process.env["NOTIFICATION_FROM"] ?? "";
const CONFIG_SET = process.env["SES_CONFIGURATION_SET"] ?? "";
const APP_BASE_URL = process.env["APP_BASE_URL"] ?? "https://app.example.com";

const VAPID_PUBLIC  = process.env["VAPID_PUBLIC_KEY"] ?? "";
const VAPID_PRIVATE = process.env["VAPID_PRIVATE_KEY"] ?? "";
const VAPID_SUBJECT = process.env["VAPID_SUBJECT"] ?? `mailto:${FROM_ADDRESS}`;

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

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

    if (signal.workflow === "auth") {
      await this.pushNotify(accountId, arc, signal);
    }
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
      `Reason: untrusted sender`,
      ``,
      `To allow this sender, visit: ${APP_BASE_URL}/account/aliases`,
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
      TableName: ACCOUNTS_TABLE,
      Key: { pk: `ACCT#${accountId}`, sk: "META" },
    }));
    return result.Item ? (result.Item as Account) : null;
  }

  private async pushNotify(accountId: string, _arc: Arc, signal: Signal): Promise<void> {
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
    const authData = signal.workflowData as AuthData;

    const res = await dynamo.send(new QueryCommand({
      TableName: ACCOUNTS_TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `ACCT#${accountId}`,
        ":prefix": "PUSH#",
      },
      ProjectionExpression: "id, endpoint, #k",
      ExpressionAttributeNames: { "#k": "keys" },
    }));
    const subs = (res.Items ?? []) as PushSubscription[];

    const payload = JSON.stringify({
      code: authData.code,
      expiresInMinutes: authData.expiresInMinutes,
      originDomain: authData.service,
    });

    await Promise.all(subs.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
      } catch (err: unknown) {
        if (typeof err === "object" && err !== null && "statusCode" in err && (err as { statusCode: number }).statusCode === 410) {
          await dynamo.send(new DeleteCommand({
            TableName: ACCOUNTS_TABLE,
            Key: { pk: `ACCT#${accountId}`, sk: `PUSH#${sub.id}` },
          }));
        }
      }
    }));
  }

  private async isAddressSuppressed(address: string): Promise<boolean> {
    const result = await dynamo.send(new GetCommand({
      TableName: PROCESSING_TABLE,
      Key: { pk: `SUPPRESS#${address}`, sk: "SUPPRESS" },
      ProjectionExpression: "address",
    }));
    return result.Item !== undefined;
  }
}
