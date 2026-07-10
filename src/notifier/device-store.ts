import { DeleteCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, ACCOUNTS_TABLE } from "../database/shared.js";
import { dbError, ok, err } from "../errors.js";
import type { Result, DbError } from "../errors.js";
import type { Device, DeviceType } from "./types.js";

// ─── Validation Error ────────────────────────────────────────────────────────

export type ValidationError = { kind: "validation_error"; field: string; message: string };
export const validationError = (field: string, message: string): ValidationError => ({ kind: "validation_error", field, message });

// ─── DeviceStore Interface ───────────────────────────────────────────────────

export interface DeviceStore {
  listDevices(accountId: string): Promise<Result<Device[], DbError>>;
  saveDevice(device: Device): Promise<Result<void, DbError | ValidationError>>;
  deleteDevice(accountId: string, token: string): Promise<Result<void, DbError>>;
  countDevices(accountId: string): Promise<Result<number, DbError>>;
}

// ─── Key Helpers ─────────────────────────────────────────────────────────────

const pk = (accountId: string) => `ACCT#${accountId}`;
const sk = (token: string) => `DEVICE#${token}`;

// ─── Constants ───────────────────────────────────────────────────────────────

const MOBILE_DEVICE_LIMIT = 10;
const VALID_DEVICE_TYPES: ReadonlySet<string> = new Set<DeviceType>(["websocket", "fcm", "apns"]);

// Device (particularly websocket connection) records carry a short TTL and
// DynamoDB's TTL sweep can lag up to 48h behind expiry, so reads here must
// not treat a stale, not-yet-swept connection as still live.
const isTtlExpired = (device: Pick<Device, "ttl">): boolean =>
  typeof device.ttl === "number" && device.ttl <= Math.floor(Date.now() / 1000);

// ─── DynamoDeviceStore ───────────────────────────────────────────────────────

export class DynamoDeviceStore implements DeviceStore {
  async listDevices(accountId: string): Promise<Result<Device[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "DEVICE#" },
      }));
      return ok(((res.Items ?? []) as Device[]).filter(d => !isTtlExpired(d)));
    } catch (e) {
      return err(dbError(e));
    }
  }

  async saveDevice(device: Device): Promise<Result<void, DbError | ValidationError>> {
    // Validate token non-empty
    if (!device.token || device.token.trim().length === 0) {
      return err(validationError("token", "Token must not be empty"));
    }

    // Validate device type
    if (!VALID_DEVICE_TYPES.has(device.type)) {
      return err(validationError("type", `Type must be one of: websocket, fcm, apns`));
    }

    // Enforce mobile device limit (websocket devices are exempt)
    if (device.type === "fcm" || device.type === "apns") {
      const countResult = await this.countMobileDevices(device.accountId, device.token);
      if (countResult.isErr()) return err(countResult.error);
      if (countResult.value >= MOBILE_DEVICE_LIMIT) {
        return err(validationError("token", "Mobile device limit reached (maximum 10)"));
      }
    }

    // Upsert — PutCommand with same key naturally replaces
    try {
      await dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: {
          pk: pk(device.accountId),
          sk: sk(device.token),
          accountId: device.accountId,
          token: device.token,
          type: device.type,
          createdAt: device.createdAt,
          updatedAt: device.updatedAt,
          ...(device.ttl !== undefined ? { ttl: device.ttl } : {}),
        },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async deleteDevice(accountId: string, token: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new DeleteCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: sk(token) },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async countDevices(accountId: string): Promise<Result<number, DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "DEVICE#" },
        Select: "COUNT",
      }));
      return ok(res.Count ?? 0);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /**
   * Count distinct mobile devices (fcm + apns) for the account, excluding
   * the device being saved (to allow upserts of existing tokens).
   */
  private async countMobileDevices(accountId: string, currentToken: string): Promise<Result<number, DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "DEVICE#" },
      }));
      const devices = (res.Items ?? []) as Device[];
      const mobileCount = devices.filter(d =>
        !isTtlExpired(d) && (d.type === "fcm" || d.type === "apns") && d.token !== currentToken,
      ).length;
      return ok(mobileCount);
    } catch (e) {
      return err(dbError(e));
    }
  }
}
