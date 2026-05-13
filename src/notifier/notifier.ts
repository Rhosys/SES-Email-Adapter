import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ResultAsync, ok } from "neverthrow";
import { dbError } from "../errors.js";
import type { DbError } from "../errors.js";
import type { Notifier } from "../processor/processor.js";
import type { Arc, Signal, WsConnection, AuthData } from "../types/index.js";

const ACCOUNTS_TABLE = process.env["ACCOUNTS_TABLE"] ?? "ses-accounts";

const WS_ENDPOINT = process.env["WS_API_ENDPOINT"] ?? "";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export class SesNotifier implements Notifier {
  notify(accountId: string, arc: Arc, signal: Signal): ResultAsync<void, DbError> {
    if (signal.workflow === "auth") {
      return ResultAsync.fromPromise(
        this.wsNotify(accountId, arc, signal),
        (e) => dbError(e instanceof Error ? e : new Error(String(e))),
      );
    }
    return ok(undefined) as unknown as ResultAsync<void, DbError>;
  }

  notifyBlocked(_accountId: string, _signal: Signal): ResultAsync<void, DbError> {
    return ok(undefined) as unknown as ResultAsync<void, DbError>;
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
}
