import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DateTime } from "luxon";
import { dynamo, ACCOUNTS_TABLE } from "./shared.js";
import { dbError, notFoundError, ok, err } from "../errors.js";
import type { Result, DbError, NotFoundError } from "../errors.js";
import { generateId } from "../utils/id.js";
import type { Account, View, Label, Rule, RuleStatus, Domain, Alias, AliasSender, SenderPolicy, AccountFilteringConfig, UnknownSenderPolicy, ForwardingTarget, EmailTemplate, WsConnection, IUserConfiguration } from "../types/index.js";
import { USER_CONFIGURATION_DEFAULTS } from "../types/index.js";
import { SYSTEM_RULES } from "../processor/system-rules.js";
import type { CreateViewRequest, UpdateViewRequest, CreateLabelRequest, UpdateLabelRequest, CreateRuleRequest, UpdateRuleRequest } from "../api/app.js";
import { buildDiffUpdateParams, buildDiffPutParams, buildSnapshotSk } from "./stats-writer.js";
import type { StatsMetric, StatsRow } from "./stats-writer.js";
import type { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

const pk = (accountId: string) => `ACCT#${accountId}`;

/** Split a full email address into domain + local part for DDB key construction. */
function parseAddress(address: string): { domain: string; alias: string } {
  const atIdx = address.lastIndexOf("@");
  if (atIdx < 1) throw new Error(`Invalid email address: ${address}`);
  return { alias: address.slice(0, atIdx), domain: address.slice(atIdx + 1) };
}

function ruleGsi1pk(accountId: string) { return `ACCT#${accountId}`; }
function ruleGsi1sk(status: RuleStatus, priorityOrder: number, id: string) {
  return `RULE#${status}#${priorityOrder.toString().padStart(6, "0")}#${id}`;
}

const BATCH_WRITE_LIMIT = 25;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// AccountDatabase
// Owns: Account record, Aliases, Views, Labels, Rules, Domains
// Table: ACCOUNTS_TABLE
// ---------------------------------------------------------------------------

export class AccountDatabase {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  // ---------------------------------------------------------------------------
  // Account
  // ---------------------------------------------------------------------------

  async getAccount(accountId: string): Promise<Result<Account | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: "META" },
      }));
      return ok(res.Item ? (res.Item as Account) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async createAccount(account: Account): Promise<Result<Account, DbError>> {
    try {
      await dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: { ...account, pk: pk(account.id), sk: "META", gsi1pk: "META", gsi1sk: `ACCT#${account.id}` },
        ConditionExpression: "attribute_not_exists(pk)",
      }));
      return ok(account);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateAccount(accountId: string, update: Partial<Pick<Account, "name" | "retentionDuration" | "digest" | "filtering" | "onboarding" | "defaultCalendarInviteForwardingTargetId">>): Promise<Result<Account, DbError>> {
    const now = DateTime.utc().toISO()!;
    const setParts: string[] = ["updatedAt = :now", "gsi1pk = :g1pk", "gsi1sk = :g1sk"];
    const exprValues: Record<string, unknown> = { ":now": now, ":g1pk": "META", ":g1sk": `ACCT#${accountId}` };
    const exprNames: Record<string, string> = {};
    const removeParts: string[] = [];

    if (update.name !== undefined) { setParts.push("#name = :name"); exprValues[":name"] = update.name; exprNames["#name"] = "name"; }
    if (update.retentionDuration !== undefined) { setParts.push("retentionDuration = :rd"); exprValues[":rd"] = update.retentionDuration; }
    if (update.digest === null) { removeParts.push("digest"); }
    else if (update.digest !== undefined) { setParts.push("digest = :digest"); exprValues[":digest"] = update.digest; }
    if (update.filtering !== undefined) { setParts.push("filtering = :filtering"); exprValues[":filtering"] = update.filtering; }
    if (update.onboarding !== undefined) { setParts.push("onboarding = :onboarding"); exprValues[":onboarding"] = update.onboarding; }
    if (update.defaultCalendarInviteForwardingTargetId === null) { removeParts.push("defaultCalendarInviteForwardingTargetId"); }
    else if (update.defaultCalendarInviteForwardingTargetId !== undefined) { setParts.push("defaultCalendarInviteForwardingTargetId = :dcifa"); exprValues[":dcifa"] = update.defaultCalendarInviteForwardingTargetId; }

    let updateExpression = `SET ${setParts.join(", ")}`;
    if (removeParts.length > 0) { updateExpression += ` REMOVE ${removeParts.join(", ")}`; }

    try {
      const res = await dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: "META" },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
        ReturnValues: "ALL_NEW",
      }));
      return ok(res.Attributes! as unknown as Account);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Aliases — SK = DOMAIN#{domain}#ALIAS#{alias}
  // GSI: gsi1pk = DOMAIN#{domain}#ALIAS#{alias}, gsi1sk = ACCT#{accountId}
  // ---------------------------------------------------------------------------

  async getAlias(accountId: string, address: string): Promise<Result<Alias | null, DbError>> {
    const { domain, alias } = parseAddress(address);
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `DOMAIN#${domain}#ALIAS#${alias}` },
      }));
      return ok(res.Item ? (res.Item as Alias) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  /**
   * Alias lookup by full recipient address, without a known accountId. Queries gsi1
   * (which has an ALL projection), so the returned item is the complete Alias, not
   * just its keys — callers get accountId and the full alias config in one read.
   */
  async getAliasByGlobalAddress(recipientAddress: string): Promise<Result<Alias | null, DbError>> {
    const { domain, alias } = parseAddress(recipientAddress);
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `DOMAIN#${domain}#ALIAS#${alias}` },
        Limit: 1,
      }));
      return ok(res.Items && res.Items.length > 0 ? (res.Items[0] as Alias) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async saveAlias(alias: Alias): Promise<Result<Alias, DbError>> {
    const { domain, alias: localPart } = parseAddress(alias.address);
    try {
      await dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: {
          ...alias,
          domain, alias: localPart,
          pk: pk(alias.accountId),
          sk: `DOMAIN#${domain}#ALIAS#${localPart}`,
          gsi1pk: `DOMAIN#${domain}#ALIAS#${localPart}`,
          gsi1sk: `ACCT#${alias.accountId}`,
        },
      }));
      return ok(alias);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async createAlias(alias: Alias): Promise<Result<Alias, DbError>> {
    return this.saveAlias(alias);
  }

  // A sender disposition recorded for an address implies that address is a recognised
  // alias, so callers that approve/block a sender must ensure the Alias record exists too.
  // Pass `existing` when the caller already has it (e.g. processor.ts) to skip the lookup.
  async ensureAlias(accountId: string, address: string, defaultUnknownSenderPolicy: UnknownSenderPolicy, existing?: Alias | null): Promise<Result<{ alias: Alias; created: boolean }, DbError>> {
    let alias = existing;
    if (alias === undefined) {
      const existingResult = await this.getAlias(accountId, address);
      if (existingResult.isErr()) return err(existingResult.error);
      alias = existingResult.value;
    }
    if (alias) return ok({ alias, created: false });

    const now = DateTime.utc().toISO()!;
    const saveResult = await this.saveAlias({
      id: address,
      accountId,
      address,
      domain: address.split("@")[1]!,
      alias: address.split("@")[0]!,
      unknownSenderPolicy: defaultUnknownSenderPolicy,
      createdAt: now,
      updatedAt: now,
    });
    if (saveResult.isErr()) return err(saveResult.error);
    return ok({ alias: saveResult.value, created: true });
  }

  async listAliases(accountId: string): Promise<Result<Alias[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "DOMAIN#" },
      }));
      // Filter to only alias items (contain #ALIAS# but not #SENDER#)
      const aliases = (res.Items ?? []).filter((item) => {
        const sk = item["sk"] as string;
        return sk.includes("#ALIAS#") && !sk.includes("#SENDER#");
      });
      return ok(aliases as Alias[]);
    } catch (e) {
      return err(dbError(e));
    }
  }

  /** Lists all aliases registered under a specific domain for the account. */
  async listAliasesForDomain(accountId: string, domain: string): Promise<Result<Alias[], DbError>> {
    try {
      const aliases: Alias[] = [];
      let lastKey: Record<string, unknown> | undefined;
      do {
        const res = await dynamo.send(new QueryCommand({
          TableName: ACCOUNTS_TABLE,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": `DOMAIN#${domain}#ALIAS#` },
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }));
        // Filter to only alias items (exclude sender entries nested under each alias)
        for (const item of res.Items ?? []) {
          const sk = item["sk"] as string;
          if (!sk.includes("#SENDER#")) aliases.push(item as Alias);
        }
        lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastKey);
      return ok(aliases);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async upsertAlias(alias: Alias): Promise<Result<Alias, DbError>> {
    return this.saveAlias(alias);
  }

  /** Deletes an alias along with every sender entry recorded for it. */
  async deleteAlias(accountId: string, address: string): Promise<Result<void, DbError>> {
    const { domain, alias } = parseAddress(address);

    const sendersResult = await this.listSenders(accountId, address);
    if (sendersResult.isErr()) return err(sendersResult.error);
    const senders = sendersResult.value;

    this.logger.info("Deleting alias and its senders", {
      code: "account_db.delete_alias",
      accountId,
      address,
      senders: senders.map((s) => s.senderDomain),
    });

    const batchDeleteResult = await this.batchDeleteSenders(accountId, senders);
    if (batchDeleteResult.isErr()) return err(batchDeleteResult.error);

    try {
      await dynamo.send(new DeleteCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `DOMAIN#${domain}#ALIAS#${alias}` },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  /** Batch-deletes sender entries in parallel, chunked to DynamoDB's 25-item BatchWriteItem limit. */
  private async batchDeleteSenders(accountId: string, senders: AliasSender[]): Promise<Result<void, DbError>> {
    if (senders.length === 0) return ok(undefined);
    try {
      await Promise.all(
        chunk(senders, BATCH_WRITE_LIMIT).map((batch) => this.batchDeleteSenderChunk(accountId, batch)),
      );
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  private async batchDeleteSenderChunk(accountId: string, senders: AliasSender[]): Promise<void> {
    let requestItems = senders.map((s) => ({
      DeleteRequest: { Key: { pk: pk(accountId), sk: `DOMAIN#${s.domain}#ALIAS#${s.alias}#SENDER#${s.senderDomain}` } },
    }));
    while (requestItems.length > 0) {
      const res = await dynamo.send(new BatchWriteCommand({
        RequestItems: { [ACCOUNTS_TABLE]: requestItems },
      }));
      requestItems = (res.UnprocessedItems?.[ACCOUNTS_TABLE] ?? []) as typeof requestItems;
    }
  }

  async renameAlias(accountId: string, oldAddress: string, newAddress: string): Promise<Result<Alias, DbError | NotFoundError>> {
    const oldResult = await this.getAlias(accountId, oldAddress);
    if (oldResult.isErr()) return err(oldResult.error);
    const old = oldResult.value;
    if (!old) return err(notFoundError("alias", oldAddress));

    const sendersResult = await this.listSenders(accountId, oldAddress);
    if (sendersResult.isErr()) return err(sendersResult.error);
    const senders = sendersResult.value;

    const { domain: newDomain, alias: newLocal } = parseAddress(newAddress);
    const renamed: Alias = { ...old, address: newAddress, domain: newDomain, alias: newLocal, updatedAt: DateTime.utc().toISO()! };
    const saveResult = await this.saveAlias(renamed);
    if (saveResult.isErr()) return err(saveResult.error);

    for (const s of senders) {
      const saveSenderResult = await this.saveSender(accountId, newAddress, s.senderDomain);
      if (saveSenderResult.isErr()) return err(saveSenderResult.error);
    }

    // deleteAlias cascades to remove oldAddress's sender entries too
    const deleteResult = await this.deleteAlias(accountId, oldAddress);
    if (deleteResult.isErr()) return err(deleteResult.error);

    return ok(renamed);
  }

  // ---------------------------------------------------------------------------
  // Alias Senders — SK = DOMAIN#{domain}#ALIAS#{alias}#SENDER#{senderDomain}
  // GSI: gsi1pk = SENDER#{senderDomain}, gsi1sk = ACCT#{accountId}#DOMAIN#{domain}#ALIAS#{alias}
  // ---------------------------------------------------------------------------

  async saveSender(accountId: string, address: string, senderDomain: string, policy?: SenderPolicy): Promise<Result<void, DbError>> {
    const { domain, alias } = parseAddress(address);
    try {
      await dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: {
          pk: pk(accountId),
          sk: `DOMAIN#${domain}#ALIAS#${alias}#SENDER#${senderDomain}`,
          gsi1pk: `SENDER#${senderDomain}`,
          gsi1sk: `ACCT#${accountId}#DOMAIN#${domain}#ALIAS#${alias}`,
          accountId, aliasAddress: address, domain, alias, senderDomain,
          policy: policy ?? "allow",
          addedAt: DateTime.utc().toISO()!,
        },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async removeSender(accountId: string, address: string, senderDomain: string): Promise<Result<void, DbError>> {
    const { domain, alias } = parseAddress(address);
    try {
      await dynamo.send(new DeleteCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `DOMAIN#${domain}#ALIAS#${alias}#SENDER#${senderDomain}` },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async getSender(accountId: string, address: string, senderDomain: string): Promise<Result<AliasSender | null, DbError>> {
    const { domain, alias } = parseAddress(address);
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `DOMAIN#${domain}#ALIAS#${alias}#SENDER#${senderDomain}` },
      }));
      return ok(res.Item ? (res.Item as AliasSender) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async listSenders(accountId: string, address: string): Promise<Result<AliasSender[], DbError>> {
    const { domain, alias } = parseAddress(address);
    try {
      const senders: AliasSender[] = [];
      let lastKey: Record<string, unknown> | undefined;
      do {
        const res = await dynamo.send(new QueryCommand({
          TableName: ACCOUNTS_TABLE,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": `DOMAIN#${domain}#ALIAS#${alias}#SENDER#` },
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }));
        senders.push(...(res.Items ?? []) as AliasSender[]);
        lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastKey);
      return ok(senders);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async getAccountFilteringConfig(accountId: string): Promise<Result<AccountFilteringConfig | null, DbError>> {
    const accountResult = await this.getAccount(accountId);
    if (accountResult.isErr()) return err(accountResult.error);
    return ok(accountResult.value?.filtering ?? null);
  }


  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  async listViews(accountId: string): Promise<Result<View[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "VIEW#" },
      }));
      return ok(((res.Items ?? []) as View[]).sort((a, b) => a.position - b.position));
    } catch (e) {
      return err(dbError(e));
    }
  }

  async getView(accountId: string, id: string): Promise<Result<View | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `VIEW#${id}` },
      }));
      return ok(res.Item ? (res.Item as View) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async createView(accountId: string, data: CreateViewRequest): Promise<Result<View, DbError>> {
    const viewsResult = await this.listViews(accountId);
    if (viewsResult.isErr()) return err(viewsResult.error);
    const views = viewsResult.value;

    const now = DateTime.utc().toISO()!;
    const view: View = {
      id: generateId("view-"),
      accountId,
      name: data.name,
      ...(data.workflow !== undefined ? { workflow: data.workflow } : {}),
      labels: data.labels ?? [],
      sortField: data.sortField ?? "lastSignalAt",
      sortDirection: data.sortDirection ?? "desc",
      ...(data.icon !== undefined ? { icon: data.icon } : {}),
      ...(data.color !== undefined ? { color: data.color } : {}),
      position: data.position ?? (views.length > 0 ? Math.max(...views.map((v) => v.position)) + 1 : 0),
      createdAt: now,
      updatedAt: now,
    };

    try {
      await dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: { ...view, pk: pk(accountId), sk: `VIEW#${view.id}` },
      }));
      return ok(view);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateView(accountId: string, id: string, data: UpdateViewRequest): Promise<Result<View, DbError>> {
    const now = DateTime.utc().toISO()!;
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };
    const exprNames: Record<string, string> = {};

    if (data.name !== undefined) { setParts.push("#name = :name"); exprValues[":name"] = data.name; exprNames["#name"] = "name"; }
    if (data.workflow !== undefined) { setParts.push("workflow = :workflow"); exprValues[":workflow"] = data.workflow; }
    if (data.labels !== undefined) { setParts.push("labels = :labels"); exprValues[":labels"] = data.labels; }
    if (data.sortField !== undefined) { setParts.push("sortField = :sf"); exprValues[":sf"] = data.sortField; }
    if (data.sortDirection !== undefined) { setParts.push("sortDirection = :sd"); exprValues[":sd"] = data.sortDirection; }
    if (data.icon !== undefined) { setParts.push("icon = :icon"); exprValues[":icon"] = data.icon; }
    if (data.color !== undefined) { setParts.push("color = :color"); exprValues[":color"] = data.color; }
    if (data.position !== undefined) { setParts.push("#pos = :pos"); exprValues[":pos"] = data.position; exprNames["#pos"] = "position"; }

    try {
      const res = await dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `VIEW#${id}` },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
        ReturnValues: "ALL_NEW",
      }));
      return ok(res.Attributes as unknown as View);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async deleteView(accountId: string, id: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new DeleteCommand({ TableName: ACCOUNTS_TABLE, Key: { pk: pk(accountId), sk: `VIEW#${id}` } }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async reorderViews(accountId: string, orderedIds: string[]): Promise<Result<void, DbError>> {
    try {
      await Promise.all(orderedIds.map((id, position) =>
        dynamo.send(new UpdateCommand({
          TableName: ACCOUNTS_TABLE,
          Key: { pk: pk(accountId), sk: `VIEW#${id}` },
          UpdateExpression: "SET #pos = :pos",
          ExpressionAttributeNames: { "#pos": "position" },
          ExpressionAttributeValues: { ":pos": position },
        })),
      ));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Labels
  // ---------------------------------------------------------------------------

  async listLabels(accountId: string): Promise<Result<Label[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "LABEL#" },
      }));
      return ok((res.Items ?? []) as Label[]);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async createLabel(accountId: string, data: CreateLabelRequest): Promise<Result<Label, DbError>> {
    const now = DateTime.utc().toISO()!;
    const label: Label = {
      id: data.name,
      accountId,
      name: data.name,
      ...(data.color !== undefined ? { color: data.color } : {}),
      ...(data.icon !== undefined ? { icon: data.icon } : {}),
      createdAt: now,
    };
    try {
      await dynamo.send(new PutCommand({ TableName: ACCOUNTS_TABLE, Item: { ...label, pk: pk(accountId), sk: `LABEL#${label.name}` } }));
      return ok(label);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateLabel(accountId: string, id: string, data: UpdateLabelRequest): Promise<Result<Label, DbError>> {
    const setParts: string[] = [];
    const exprValues: Record<string, unknown> = {};

    // Label names are immutable (name is the key) — only color and icon can be updated
    if (data.color !== undefined) { setParts.push("color = :color"); exprValues[":color"] = data.color; }
    if (data.icon !== undefined) { setParts.push("icon = :icon"); exprValues[":icon"] = data.icon; }

    if (setParts.length === 0) {
      try {
        const res = await dynamo.send(new GetCommand({
          TableName: ACCOUNTS_TABLE,
          Key: { pk: pk(accountId), sk: `LABEL#${id}` },
        }));
        return ok(res.Item as unknown as Label);
      } catch (e) {
        return err(dbError(e));
      }
    }

    try {
      const res = await dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `LABEL#${id}` },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
        ReturnValues: "ALL_NEW",
      }));
      return ok(res.Attributes as unknown as Label);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async deleteLabel(accountId: string, id: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new DeleteCommand({ TableName: ACCOUNTS_TABLE, Key: { pk: pk(accountId), sk: `LABEL#${id}` } }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------

  async listRules(accountId: string): Promise<Result<Rule[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
        ExpressionAttributeValues: { ":pk": ruleGsi1pk(accountId), ":prefix": "RULE#" },
      }));
      const ddbRules = (res.Items ?? []) as Rule[];
      // Merge SYSTEM_RULES (code-defined) with per-account status overrides stored in DDB
      const overrideById = new Map(ddbRules.filter(r => r.id.startsWith("SR-")).map(r => [r.id, r.status]));
      const systemRules = SYSTEM_RULES.map(sr => overrideById.has(sr.id) ? { ...sr, status: overrideById.get(sr.id)! } : sr);
      const userRules = ddbRules.filter(r => !r.id.startsWith("SR-"));
      return ok([...systemRules, ...userRules].sort((a, b) => a.priorityOrder - b.priorityOrder));
    } catch (e) {
      return err(dbError(e));
    }
  }

  async listEnabledRules(accountId: string): Promise<Result<Rule[], DbError>> {
    const allResult = await this.listRules(accountId);
    if (allResult.isErr()) return allResult;
    return ok(allResult.value.filter(r => r.status === "enabled"));
  }

  async upsertSystemRuleStatus(accountId: string, ruleId: string, status: RuleStatus): Promise<Result<void, DbError>> {
    const sr = SYSTEM_RULES.find(r => r.id === ruleId);
    if (!sr) return err(dbError(new Error(`Unknown system rule: ${ruleId}`)));
    try {
      await dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: {
          ...sr, accountId, status,
          pk: pk(accountId), sk: `RULE#${ruleId}`,
          gsi1pk: ruleGsi1pk(accountId), gsi1sk: ruleGsi1sk(status, sr.priorityOrder, ruleId),
        },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async createRule(accountId: string, data: CreateRuleRequest): Promise<Result<Rule, DbError>> {
    const allRulesResult = await this.listRules(accountId);
    if (allRulesResult.isErr()) return err(allRulesResult.error);
    const allRules = allRulesResult.value;

    const userRules = allRules.filter((r) => !r.id.startsWith("SR-"));
    const now = DateTime.utc().toISO()!;
    const rule: Rule = {
      id: generateId("rule-"),
      accountId,
      name: data.name,
      condition: data.condition ?? "",
      ...(data.conditionType !== undefined ? { conditionType: data.conditionType } : {}),
      actions: data.actions as Rule["actions"],
      status: "enabled",
      priorityOrder: data.priorityOrder ?? (userRules.length > 0 ? Math.max(...userRules.map((r) => r.priorityOrder)) + 1 : 1801),
      ...(data.tags !== undefined ? { tags: data.tags } : {}),
      createdAt: now,
      updatedAt: now,
    };

    try {
      await dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: {
          ...rule,
          pk: pk(accountId), sk: `RULE#${rule.id}`,
          gsi1pk: ruleGsi1pk(accountId), gsi1sk: ruleGsi1sk(rule.status, rule.priorityOrder, rule.id),
        },
      }));
      return ok(rule);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateRule(accountId: string, id: string, data: UpdateRuleRequest & { lastError?: string | null }): Promise<Result<Rule, DbError>> {
    let existing: Rule;
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `RULE#${id}` },
      }));
      existing = res.Item as Rule;
    } catch (e) {
      return err(dbError(e));
    }

    const now = DateTime.utc().toISO()!;
    const mergedStatus = data.status ?? existing.status;
    const mergedPriority = data.priorityOrder ?? existing.priorityOrder;

    const setParts: string[] = [
      "updatedAt = :now",
      "gsi1pk = :g1pk",
      "gsi1sk = :g1sk",
    ];
    const exprValues: Record<string, unknown> = {
      ":now": now,
      ":g1pk": ruleGsi1pk(accountId),
      ":g1sk": ruleGsi1sk(mergedStatus, mergedPriority, id),
    };
    const exprNames: Record<string, string> = {};

    if (data.name !== undefined) { setParts.push("#name = :name"); exprValues[":name"] = data.name; exprNames["#name"] = "name"; }
    if (data.condition !== undefined) { setParts.push("#cond = :cond"); exprValues[":cond"] = data.condition; exprNames["#cond"] = "condition"; }
    if (data.conditionType !== undefined) { setParts.push("conditionType = :condType"); exprValues[":condType"] = data.conditionType; }
    if (data.actions !== undefined) { setParts.push("actions = :actions"); exprValues[":actions"] = data.actions; }
    if (data.priorityOrder !== undefined) { setParts.push("#pri = :pri"); exprValues[":pri"] = data.priorityOrder; exprNames["#pri"] = "priorityOrder"; }
    if (data.status !== undefined) { setParts.push("#status = :status"); exprValues[":status"] = data.status; exprNames["#status"] = "status"; }
    if (data.tags !== undefined) { setParts.push("tags = :tags"); exprValues[":tags"] = data.tags; }

    const removeParts: string[] = [];
    if (data.lastError === null) { removeParts.push("lastError"); }

    try {
      let updateExpression = `SET ${setParts.join(", ")}`;
      if (removeParts.length > 0) { updateExpression += ` REMOVE ${removeParts.join(", ")}`; }
      const res = await dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `RULE#${id}` },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
        ReturnValues: "ALL_NEW",
      }));
      return ok(res.Attributes as unknown as Rule);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async deleteRule(accountId: string, id: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new DeleteCommand({ TableName: ACCOUNTS_TABLE, Key: { pk: pk(accountId), sk: `RULE#${id}` } }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async annotateRuleError(accountId: string, ruleId: string, errorMessage: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `RULE#${ruleId}` },
        UpdateExpression: "SET lastError = :err, updatedAt = :now",
        ExpressionAttributeValues: { ":err": errorMessage, ":now": DateTime.utc().toISO()! },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async annotateTemplateError(accountId: string, templateId: string, functionName: string, errorMessage: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `TEMPLATE#${templateId}` },
        UpdateExpression: "SET functions[0].lastError = :err, updatedAt = :now",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: { ":err": `[${functionName}] ${errorMessage}`, ":now": DateTime.utc().toISO()! },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Domains — SK = DOMAIN#{domain}
  // GSI: gsi1pk = DOMAIN#{domain}, gsi1sk = ACCT#{accountId}
  // ---------------------------------------------------------------------------

  async listDomains(accountId: string): Promise<Result<Domain[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "DOMAIN#" },
      }));
      // Filter to only bare, non-deleted domain items (SK = DOMAIN#{domain}, no #ALIAS# suffix)
      const domains = (res.Items ?? []).filter((item) => {
        const sk = item["sk"] as string;
        return !sk.includes("#ALIAS#") && item["status"] !== "deleted";
      });
      return ok(domains as Domain[]);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async getDomain(accountId: string, domainName: string): Promise<Result<Domain | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { pk: pk(accountId), sk: `DOMAIN#${domainName}` } }));
      const item = res.Item ? res.Item as unknown as Domain : null;
      if (item?.status === "deleted") return ok(null);
      return ok(item);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async getDomainByName(accountId: string, domainName: string): Promise<Result<Domain | null, DbError>> {
    return this.getDomain(accountId, domainName);
  }

  async createDomain(accountId: string, domain: string): Promise<Result<Domain, DbError>> {
    const now = DateTime.utc().toISO()!;
    const item: Domain = {
      accountId,
      domain,
      status: "active",
      receivingSetupComplete: false,
      senderSetupComplete: false,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: {
          ...item,
          pk: pk(accountId),
          sk: `DOMAIN#${domain}`,
          gsi1pk: `DOMAIN#${domain}`,
          gsi1sk: `ACCT#${accountId}`,
        },
        // Allow either a fresh create or reviving this account's own soft-deleted domain.
        // pk is already account-scoped, so this can only collide with a row from this account.
        ConditionExpression: "attribute_not_exists(sk) OR #status = :deleted",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":deleted": "deleted" },
      }));
      return ok(item);
    } catch (e) {
      // Falls here only when the row exists and is still active (idempotent re-POST)
      if (e instanceof Error && e.name === "ConditionalCheckFailedException") {
        const existing = await this.getDomain(accountId, domain);
        if (existing.isErr()) return err(existing.error);
        if (existing.value) return ok(existing.value);
      }
      return err(dbError(e));
    }
  }

  async deleteDomain(accountId: string, domainName: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `DOMAIN#${domainName}` },
        UpdateExpression: "SET #status = :deleted, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":deleted": "deleted", ":now": DateTime.utc().toISO()! },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  /** Winning domain registration (oldest registrant by createdAt), unfiltered by status. */
  async getDomainOwner(domain: string): Promise<Result<Domain | null, DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `DOMAIN#${domain}` },
      }));
      const items = (res.Items ?? []) as Domain[];
      if (items.length === 0) return ok(null);
      // Sort by createdAt ascending — oldest registrant wins
      items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return ok(items[0]!);
    } catch (e) {
      return err(dbError(e));
    }
  }

  /**
   * Resolve which account owns a domain. Returns the accountId of the oldest registrant.
   * Intentionally still matches soft-deleted domains — this prevents "deleted domain
   * takeover": if a different account could claim a domain the original account merely
   * soft-deleted, the original owner would be permanently locked out of reviving it via
   * POST. Ownership persists across soft-delete; only routability is affected by status
   * (see SignalProcessor.resolveAccountIdAndAlias).
   */
  async resolveAccountForDomain(domain: string): Promise<Result<string | null, DbError>> {
    const ownerResult = await this.getDomainOwner(domain);
    if (ownerResult.isErr()) return err(ownerResult.error);
    return ok(ownerResult.value?.accountId ?? null);
  }

  async updateDomainHealth(accountId: string, domainName: string, health: {
    receivingHealthy: boolean;
    senderHealthy: boolean;
    failingRecords: string[];
    lastCheckedAt: string;
    lastHealthyAt?: string;
  }): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `DOMAIN#${domainName}` },
        UpdateExpression: "SET receivingHealthy = :rh, senderHealthy = :sh, failingRecords = :fr, lastCheckedAt = :lc, updatedAt = :ua" +
          (health.lastHealthyAt ? ", lastHealthyAt = :lha" : ""),
        ExpressionAttributeValues: {
          ":rh": health.receivingHealthy,
          ":sh": health.senderHealthy,
          ":fr": health.failingRecords,
          ":lc": health.lastCheckedAt,
          ":ua": health.lastCheckedAt,
          ...(health.lastHealthyAt ? { ":lha": health.lastHealthyAt } : {}),
        },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateDomainSetup(accountId: string, domainName: string, setup: {
    receivingSetupComplete?: boolean;
    senderSetupComplete?: boolean;
  }): Promise<Result<void, DbError>> {
    const parts: string[] = ["updatedAt = :ua"];
    const values: Record<string, unknown> = { ":ua": DateTime.utc().toISO()! };
    if (setup.receivingSetupComplete !== undefined) {
      parts.push("receivingSetupComplete = :rsc");
      values[":rsc"] = setup.receivingSetupComplete;
    }
    if (setup.senderSetupComplete !== undefined) {
      parts.push("senderSetupComplete = :ssc");
      values[":ssc"] = setup.senderSetupComplete;
    }
    try {
      await dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `DOMAIN#${domainName}` },
        UpdateExpression: `SET ${parts.join(", ")}`,
        ExpressionAttributeValues: values,
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async scanAllDomains(): Promise<Result<Array<{ accountId: string; domains: Domain[] }>, DbError>> {
    try {
      const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
      const accountDomains = new Map<string, Domain[]>();
      let lastKey: Record<string, unknown> | undefined;

      do {
        const res = await dynamo.send(new ScanCommand({
          TableName: ACCOUNTS_TABLE,
          FilterExpression: "begins_with(sk, :prefix) AND NOT contains(sk, :aliasMarker) AND (attribute_not_exists(#status) OR #status <> :deleted)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":prefix": "DOMAIN#", ":aliasMarker": "#ALIAS#", ":deleted": "deleted" },
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }));
        for (const item of res.Items ?? []) {
          const domain = item as Domain;
          const list = accountDomains.get(domain.accountId) ?? [];
          list.push(domain);
          accountDomains.set(domain.accountId, list);
        }
        lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastKey);

      const results: Array<{ accountId: string; domains: Domain[] }> = [];
      for (const [accountId, domains] of accountDomains) {
        results.push({ accountId, domains });
      }
      return ok(results);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Forwarding targets
  // ---------------------------------------------------------------------------

  async listForwardingTargets(accountId: string): Promise<Result<ForwardingTarget[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "FWDADDR#" },
      }));
      return ok((res.Items ?? []) as ForwardingTarget[]);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async getForwardingTarget(accountId: string, target: string): Promise<Result<ForwardingTarget | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `FWDADDR#${target}` },
      }));
      return ok(res.Item ? (res.Item as ForwardingTarget) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async saveForwardingTarget(addr: ForwardingTarget): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: { ...addr, pk: pk(addr.accountId), sk: `FWDADDR#${addr.target}` },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async deleteForwardingTarget(accountId: string, target: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new DeleteCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `FWDADDR#${target}` },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async disableRulesForwardingTo(accountId: string, toAddress: string): Promise<Result<string[], DbError>> {
    const rulesResult = await this.listRules(accountId);
    if (rulesResult.isErr()) return err(rulesResult.error);
    const rules = rulesResult.value;

    const affected = rules.filter((r) => r.actions.some((a) => a.type === "forward" && a.value === toAddress));
    const disabledRuleIds: string[] = [];
    for (const r of affected) {
      const updateResult = await this.updateRule(accountId, r.id, { status: "disabled" });
      if (updateResult.isErr()) return err(updateResult.error);
      disabledRuleIds.push(r.id);
    }
    return ok(disabledRuleIds);
  }

  // ---------------------------------------------------------------------------
  // Email Templates
  // ---------------------------------------------------------------------------

  async createTemplate(template: EmailTemplate): Promise<Result<EmailTemplate, DbError>> {
    try {
      await dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: { ...template, pk: pk(template.accountId), sk: `TEMPLATE#${template.id}` },
      }));
      return ok(template);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async getTemplate(accountId: string, id: string): Promise<Result<EmailTemplate | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `TEMPLATE#${id}` },
      }));
      return ok(res.Item ? (res.Item as EmailTemplate) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateTemplate(accountId: string, id: string, update: Partial<Pick<EmailTemplate, "name" | "subject" | "body" | "functions">>): Promise<Result<EmailTemplate, DbError>> {
    const now = DateTime.utc().toISO()!;
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };
    const exprNames: Record<string, string> = {};
    if (update.name !== undefined) { setParts.push("#name = :name"); exprValues[":name"] = update.name; exprNames["#name"] = "name"; }
    if (update.subject !== undefined) { setParts.push("#subject = :subject"); exprValues[":subject"] = update.subject; exprNames["#subject"] = "subject"; }
    if (update.body !== undefined) { setParts.push("body = :body"); exprValues[":body"] = update.body; }
    if (update.functions !== undefined) { setParts.push("functions = :functions"); exprValues[":functions"] = update.functions; }

    try {
      const res = await dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `TEMPLATE#${id}` },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
        ReturnValues: "ALL_NEW",
      }));
      return ok(res.Attributes as unknown as EmailTemplate);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async deleteTemplate(accountId: string, id: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new DeleteCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `TEMPLATE#${id}` },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async listTemplates(accountId: string): Promise<Result<EmailTemplate[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "TEMPLATE#" },
      }));
      return ok((res.Items ?? []) as EmailTemplate[]);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket Connections
  // ---------------------------------------------------------------------------

  async saveWsConnection(conn: WsConnection): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: { ...conn, pk: pk(conn.accountId), sk: `CONN#${conn.connectionId}` },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async listWsConnections(accountId: string): Promise<Result<WsConnection[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "CONN#" },
      }));
      return ok((res.Items ?? []) as WsConnection[]);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async deleteWsConnection(accountId: string, connectionId: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new DeleteCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `CONN#${connectionId}` },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Account Metas (GSI1 query for digest dispatcher)
  // ---------------------------------------------------------------------------

  async queryAllAccountMetas(): Promise<Result<Array<{ id: string; digest?: { frequency: string; forwardingTargetId: string } | null }>, DbError>> {
    const items: Array<{ id: string; digest?: { frequency: string; forwardingTargetId: string } | null }> = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    try {
      do {
        const res = await dynamo.send(new QueryCommand({
          TableName: ACCOUNTS_TABLE,
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :pk",
          ExpressionAttributeValues: { ":pk": "META" },
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }));
        for (const item of res.Items ?? []) {
          items.push({ id: item["id"] as string, ...(item["digest"] !== undefined ? { digest: item["digest"] as { frequency: string; forwardingTargetId: string } | null } : {}) });
        }
        exclusiveStartKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (exclusiveStartKey);
      return ok(items);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  /**
   * Three-level conditional write for diff rows with idempotency:
   * 1. UpdateItem (attribute_exists + NOT contains(history, key)) — fast path
   * 2. If condition fails → GetItem to disambiguate:
   *    - Row doesn't exist → PutItem with history seeded
   *    - Row exists + key in history → return ok (deduplicated)
   * 3. If PutItem condition fails (race) → retry UpdateItem
   *
   * Post-write: if history > 100 items, trim oldest 10 (fire-and-forget).
   */
  private async writeDiffMetric(accountId: string, metric: StatsMetric, delta: number, idempotencyKey: string): Promise<Result<void, DbError>> {
    const now = DateTime.utc();
    const updateParams = buildDiffUpdateParams(accountId, metric, delta, now, ACCOUNTS_TABLE);
    const putParams = buildDiffPutParams(accountId, metric, delta, now, ACCOUNTS_TABLE);

    // Step 1: try to ADD to existing row with idempotency check
    try {
      await dynamo.send(new UpdateCommand({
        ...updateParams,
        UpdateExpression: `${updateParams.UpdateExpression} SET history = list_append(history, :keyList)`,
        ConditionExpression: "attribute_exists(pk) AND NOT contains(history, :key)",
        ExpressionAttributeValues: {
          ...updateParams.ExpressionAttributeValues,
          ":key": idempotencyKey,
          ":keyList": [idempotencyKey],
        },
      }));
      await this.trimHistory(updateParams.Key);
      return ok(undefined);
    } catch (e) {
      if (!(e instanceof Error && e.name === "ConditionalCheckFailedException")) {
        this.logger.warn("writeDiffMetric step 1 failed with unexpected error", { code: "account_db.write_diff_metric_step1_error", accountId, metric, delta, idempotencyKey, error: e });
        return err(dbError(e));
      }
    }

    // Step 2: condition failed — disambiguate with GetItem
    try {
      const existing = await dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: updateParams.Key,
        ProjectionExpression: "history",
      }));
      if (existing.Item) {
        // Row exists — check if key is already in history (deduplicated)
        const history = (existing.Item["history"] as string[] | undefined) ?? [];
        if (history.includes(idempotencyKey)) {
          this.logger.info("writeDiffMetric deduplicated — key already in history", { code: "account_db.write_diff_metric_dedup", accountId, metric, idempotencyKey });
          return ok(undefined);
        }
        // Key not in history — unexpected condition failure, retry update
        this.logger.info("writeDiffMetric step 2 retry — row exists but key not in history", { code: "account_db.write_diff_metric_step2_retry", accountId, metric, delta, idempotencyKey });
        try {
          await dynamo.send(new UpdateCommand({
            ...updateParams,
            UpdateExpression: `${updateParams.UpdateExpression} SET history = list_append(history, :keyList)`,
            ConditionExpression: "attribute_exists(pk) AND NOT contains(history, :key)",
            ExpressionAttributeValues: {
              ...updateParams.ExpressionAttributeValues,
              ":key": idempotencyKey,
              ":keyList": [idempotencyKey],
            },
          }));
          await this.trimHistory(updateParams.Key);
          return ok(undefined);
        } catch (retryErr) {
          if (retryErr instanceof Error && retryErr.name === "ConditionalCheckFailedException") return ok(undefined);
          this.logger.warn("writeDiffMetric step 2 retry failed", { code: "account_db.write_diff_metric_step2_retry_error", accountId, metric, delta, idempotencyKey, error: retryErr });
          return err(dbError(retryErr));
        }
      }
    } catch (e) {
      this.logger.warn("writeDiffMetric step 2 GetItem failed", { code: "account_db.write_diff_metric_step2_get_error", accountId, metric, delta, idempotencyKey, error: e });
      return err(dbError(e));
    }

    // Row doesn't exist — create it with history seeded
    this.logger.info("writeDiffMetric step 3 — creating new diff row", { code: "account_db.write_diff_metric_step3_put", accountId, metric, delta, idempotencyKey });
    try {
      await dynamo.send(new PutCommand({
        ...putParams,
        Item: { ...putParams.Item, history: [idempotencyKey] },
      }));
      return ok(undefined);
    } catch (e) {
      if (!(e instanceof Error && e.name === "ConditionalCheckFailedException")) {
        this.logger.warn("writeDiffMetric step 3 PutItem failed", { code: "account_db.write_diff_metric_step3_put_error", accountId, metric, delta, idempotencyKey, error: e });
        return err(dbError(e));
      }
    }

    // Race: another Lambda created it — retry update
    this.logger.info("writeDiffMetric step 3 race — retrying update after PutItem conflict", { code: "account_db.write_diff_metric_step3_race_retry", accountId, metric, delta, idempotencyKey });
    try {
      await dynamo.send(new UpdateCommand({
        ...updateParams,
        UpdateExpression: `${updateParams.UpdateExpression} SET history = list_append(history, :keyList)`,
        ConditionExpression: "attribute_exists(pk) AND NOT contains(history, :key)",
        ExpressionAttributeValues: {
          ...updateParams.ExpressionAttributeValues,
          ":key": idempotencyKey,
          ":keyList": [idempotencyKey],
        },
      }));
      await this.trimHistory(updateParams.Key);
      return ok(undefined);
    } catch (e) {
      if (e instanceof Error && e.name === "ConditionalCheckFailedException") return ok(undefined);
      this.logger.warn("writeDiffMetric step 3 race retry failed", { code: "account_db.write_diff_metric_step3_race_error", accountId, metric, delta, idempotencyKey, error: e });
      return err(dbError(e));
    }
  }

  /** Fire-and-forget: trim history list if over 100 items */
  private async trimHistory(key: { pk: string; sk: string }): Promise<void> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: key,
        ProjectionExpression: "history",
      }));
      const history = (res.Item?.["history"] as string[] | undefined) ?? [];
      if (history.length <= 100) return;

      // Remove first 10 elements by index
      const removeExpr = Array.from({ length: 10 }, (_, i) => `history[${i}]`).join(", ");
      await dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: key,
        UpdateExpression: `REMOVE ${removeExpr}`,
      }));
    } catch {
      // Fire-and-forget — trim failure is non-critical
    }
  }

  async incrementStatMetric(accountId: string, metric: StatsMetric, delta: number, idempotencyKey: string): Promise<Result<void, DbError>> {
    return this.writeDiffMetric(accountId, metric, delta, idempotencyKey);
  }

  async getStats(accountId: string, fromSk?: string): Promise<Result<StatsRow[], DbError>> {
    try {
      const keyCondition = fromSk
        ? "pk = :pk AND sk >= :from"
        : "pk = :pk AND begins_with(sk, :prefix)";
      const exprValues: Record<string, string> = fromSk
        ? { ":pk": `ACCT#${accountId}`, ":from": fromSk }
        : { ":pk": `ACCT#${accountId}`, ":prefix": "STATS#" };

      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: keyCondition,
        ExpressionAttributeValues: exprValues,
        ScanIndexForward: fromSk ? true : false,
        ...(!fromSk ? { Limit: 400 } : {}),
      }));
      const items = (res.Items ?? []) as StatsRow[];
      // When using reverse scan (no fromSk), flip to ascending for aggregation
      return ok(fromSk ? items : items.reverse());
    } catch (e) {
      return err(dbError(e));
    }
  }

  async writeSnapshot(accountId: string, yearMonth: string, metrics: Record<StatsMetric, number>): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: {
          pk: `ACCT#${accountId}`,
          sk: buildSnapshotSk(yearMonth),
          metrics,
        },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // User Configuration — PK = USER#{userId}, SK = CONFIG
  // ---------------------------------------------------------------------------

  async getUserConfiguration(userId: string): Promise<Result<IUserConfiguration, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: `USER#${userId}`, sk: "CONFIG" },
      }));
      if (!res.Item) return ok({ ...USER_CONFIGURATION_DEFAULTS });
      const { pk: _pk, sk: _sk, userId: _uid, createdAt: _c, updatedAt: _u, ...config } = res.Item as Record<string, unknown>;
      return ok({ ...USER_CONFIGURATION_DEFAULTS, ...config } as IUserConfiguration);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateUserConfiguration(userId: string, update: Partial<IUserConfiguration>): Promise<Result<IUserConfiguration, DbError>> {
    const now = DateTime.utc().toISO()!;
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };

    if (update.postSendView !== undefined) { setParts.push("postSendView = :psv"); exprValues[":psv"] = update.postSendView; }

    try {
      const res = await dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: `USER#${userId}`, sk: "CONFIG" },
        UpdateExpression: `SET ${setParts.join(", ")}, userId = if_not_exists(userId, :uid), createdAt = if_not_exists(createdAt, :now)`,
        ExpressionAttributeValues: { ...exprValues, ":uid": userId },
        ReturnValues: "ALL_NEW",
      }));
      const { pk: _pk, sk: _sk, userId: _uid, createdAt: _c, updatedAt: _u, ...config } = res.Attributes! as Record<string, unknown>;
      return ok({ ...USER_CONFIGURATION_DEFAULTS, ...config } as IUserConfiguration);
    } catch (e) {
      return err(dbError(e));
    }
  }
}
