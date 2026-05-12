import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ResultAsync } from "neverthrow";
import { dbError } from "../errors.js";
import type { DbError } from "../errors.js";
import type { Notifier } from "../processor/processor.js";
import type { Arc, Signal, Account, WsConnection, AuthData } from "../types/index.js";

const ACCOUNTS_TABLE = process.env["ACCOUNTS_TABLE"] ?? "ses-accounts";
const PROCESSING_TABLE = process.env["PROCESSING_TABLE"] ?? "ses-processing";
const FROM_ADDRESS = process.env["NOTIFICATION_FROM"] ?? "";
const CONFIG_SET = process.env["SES_CONFIGURATION_SET"] ?? "";
const APP_BASE_URL = process.env["APP_BASE_URL"] ?? "https://app.example.com";

const WS_ENDPOINT = process.env["WS_API_ENDPOINT"] ?? "";

const sesv2 = new SESv2Client({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export class SesNotifier implements Notifier {
  notify(accountId: string, arc: Arc, signal: Signal): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      this.doNotify(accountId, arc, signal),
      (e) => dbError(e instanceof Error ? e : new Error(String(e)))
    );
  }

  notifyBlocked(accountId: string, signal: Signal): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      this.doNotifyBlocked(accountId, signal),
      (e) => dbError(e instanceof Error ? e : new Error(String(e)))
    );
  }

  private async doNotify(accountId: string, arc: Arc, signal: Signal): Promise<void> {
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
      await this.wsNotify(accountId, arc, signal);
    }
  }

  private async doNotifyBlocked(accountId: string, signal: Signal): Promise<void> {
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

  private async wsNotify(accountId: string, _arc: Arc, signal: Signal): Promise<void> {
    if (!WS_ENDPOINT) return;
    const authData = signal.workflowData as AuthData;

    const res = await dynamo.send(new QueryCommand({
      TableName: ACCOUNTS_TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `ACCT#${accountId}`, ":prefix": "CONN#" },
      ProjectionExpression: "connectionId",
    }));
    const connections = (res.Items ?? []) as Pick<WsConnection, "connectionId">[];

    const payload = JSON.stringify({
      type: "auth",
      code: authData.code,
      expiresInMinutes: authData.expiresInMinutes,
      originDomain: authData.service,
    });

    await Promise.all(connections.map(async ({ connectionId }) => {
      try {
        await fetch(`${WS_ENDPOINT}/${connectionId}`, {
          method: "POST",
          body: payload,
        });
      } catch (err: unknown) {
        // Stale connection — remove it
        const status = (err as { status?: number }).status;
        if (status === 410) {
          await dynamo.send(new DeleteCommand({
            TableName: ACCOUNTS_TABLE,
            Key: { pk: `ACCT#${accountId}`, sk: `CONN#${connectionId}` },
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
