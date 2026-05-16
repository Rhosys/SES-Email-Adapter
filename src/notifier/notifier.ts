import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { Notifier } from "../processor/processor.js";
import type { Arc, Signal, WsConnection, AuthData } from "../types/index.js";
import type { Logger } from "../logger.js";

const ACCOUNTS_TABLE = process.env["ACCOUNTS_TABLE"] ?? "ses-accounts";

const WS_ENDPOINT = process.env["WS_API_ENDPOINT"] ?? "";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export class SesNotifier implements Notifier {
  constructor(private readonly logger: Logger) {}

  async notify(accountId: string, arc: Arc, signal: Signal): Promise<Result<void, DbError>> {
    if (signal.workflow === "auth") {
      try {
        await this.wsNotify(accountId, arc, signal);
        return ok(undefined);
      } catch (e) {
        return err(dbError(e));
      }
    }
    return ok(undefined);
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
      } catch (fetchErr: unknown) {
        const status = (fetchErr as { status?: number }).status;
        if (status && status < 500) {
          this.logger.track("WebSocket push returned client error — removing stale connection.", { code: "notifier.ws_client_error", accountId, connectionId, status });
          await dynamo.send(new DeleteCommand({
            TableName: ACCOUNTS_TABLE,
            Key: { pk: `ACCT#${accountId}`, sk: `CONN#${connectionId}` },
          }));
        } else {
          this.logger.warn("WebSocket push failed with server error or network failure. The user won't receive the real-time notification for this signal.", { code: "notifier.ws_push_failed", accountId, connectionId, status, error: fetchErr });
        }
      }
    }));
  }
}
