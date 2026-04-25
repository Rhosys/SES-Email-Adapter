import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const ACCOUNTS_TABLE = process.env["ACCOUNTS_TABLE"] ?? "ses-accounts";
export const SIGNALS_TABLE = process.env["SIGNALS_TABLE"] ?? "ses-signals";
export const PROCESSING_TABLE = process.env["PROCESSING_TABLE"] ?? "ses-processing";

export const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

export function decodeCursor(cursor: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as Record<string, unknown>;
}
