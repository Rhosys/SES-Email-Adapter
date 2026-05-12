import { randomUUID } from "crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ResultAsync } from "neverthrow";
import type { Result } from "neverthrow";
import { dynamo, ACCOUNTS_TABLE } from "./shared.js";
import { dbError, notFoundError, ok, err } from "../errors.js";
import type { DbError, NotFoundError } from "../errors.js";
import type { Account, View, Label, Rule, RuleStatus, Domain, Alias, AliasSender, SenderMode, AccountFilteringConfig, VerifiedForwardingAddress, EmailTemplate, WsConnection } from "../types/index.js";
import type { CreateViewRequest, UpdateViewRequest, CreateLabelRequest, UpdateLabelRequest, CreateRuleRequest, UpdateRuleRequest } from "../api/app.js";

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

const pk = (accountId: string) => `ACCT#${accountId}`;

function ruleGsi1pk(accountId: string) { return `ACCT#${accountId}`; }
function ruleGsi1sk(status: RuleStatus, priorityOrder: number, id: string) {
  return `RULE#${status}#${String(priorityOrder).padStart(6, "0")}#${id}`;
}

// ---------------------------------------------------------------------------
// Error mapper for AWS SDK calls
// ---------------------------------------------------------------------------

const toDbError = (e: unknown): DbError => dbError(e instanceof Error ? e : new Error(String(e)));

// ---------------------------------------------------------------------------
// AccountDatabase
// Owns: Account record, Aliases, Views, Labels, Rules, Domains
// Table: ACCOUNTS_TABLE
// ---------------------------------------------------------------------------

export class AccountDatabase {
  // ---------------------------------------------------------------------------
  // Account
  // ---------------------------------------------------------------------------

  getAccount(accountId: string): ResultAsync<Account | null, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: "META" },
      })).then(res => res.Item ? (res.Item as Account) : null),
      toDbError,
    );
  }

  updateAccount(accountId: string, update: Partial<Pick<Account, "name" | "deletionRetentionDays" | "notifications" | "filtering">>): ResultAsync<Account, DbError> {
    const now = new Date().toISOString();
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };
    const exprNames: Record<string, string> = {};

    if (update.name !== undefined) { setParts.push("#name = :name"); exprValues[":name"] = update.name; exprNames["#name"] = "name"; }
    if (update.deletionRetentionDays !== undefined) { setParts.push("deletionRetentionDays = :drd"); exprValues[":drd"] = update.deletionRetentionDays; }
    if (update.notifications !== undefined) { setParts.push("notifications = :notif"); exprValues[":notif"] = update.notifications; }
    if (update.filtering !== undefined) { setParts.push("filtering = :filtering"); exprValues[":filtering"] = update.filtering; }

    return ResultAsync.fromPromise(
      dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: "META" },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
        ReturnValues: "ALL_NEW",
      })).then(res => res.Attributes! as unknown as Account),
      toDbError,
    );
  }

  // ---------------------------------------------------------------------------
  // Aliases (each stored as its own item: SK = ALIAS#${address})
  // ---------------------------------------------------------------------------

  getAlias(accountId: string, address: string): ResultAsync<Alias | null, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `ALIAS#${address}` },
      })).then(res => res.Item ? (res.Item as Alias) : null),
      toDbError,
    );
  }

  saveAlias(alias: Alias): ResultAsync<Alias, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: { ...alias, pk: pk(alias.accountId), sk: `ALIAS#${alias.address}` },
      })).then(() => alias),
      toDbError,
    );
  }

  createAlias(alias: Alias): ResultAsync<Alias, DbError> {
    return this.saveAlias(alias);
  }

  listAliases(accountId: string): ResultAsync<Alias[], DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "ALIAS#" },
      })).then(res => (res.Items ?? []) as Alias[]),
      toDbError,
    );
  }

  upsertAlias(alias: Alias): ResultAsync<Alias, DbError> {
    return this.saveAlias(alias);
  }

  deleteAlias(accountId: string, address: string): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new DeleteCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `ALIAS#${address}` },
      })).then(() => undefined),
      toDbError,
    );
  }

  async renameAlias(accountId: string, oldAddress: string, newAddress: string): Promise<Result<Alias, DbError | NotFoundError>> {
    const oldResult = await this.getAlias(accountId, oldAddress);
    if (oldResult.isErr()) return err(oldResult.error);
    const old = oldResult.value;
    if (!old) return err(notFoundError("alias", oldAddress));

    const sendersResult = await this.listSenders(accountId, oldAddress);
    if (sendersResult.isErr()) return err(sendersResult.error);
    const senders = sendersResult.value;

    const renamed: Alias = { ...old, address: newAddress, updatedAt: new Date().toISOString() };
    const saveResult = await this.saveAlias(renamed);
    if (saveResult.isErr()) return err(saveResult.error);

    for (const s of senders) {
      const saveSenderResult = await this.saveSender(accountId, newAddress, s.domain, s.mode);
      if (saveSenderResult.isErr()) return err(saveSenderResult.error);
    }

    const deleteResult = await this.deleteAlias(accountId, oldAddress);
    if (deleteResult.isErr()) return err(deleteResult.error);

    for (const s of senders) {
      const removeResult = await this.removeSender(accountId, oldAddress, s.domain);
      if (removeResult.isErr()) return err(removeResult.error);
    }

    return ok(renamed);
  }

  // ---------------------------------------------------------------------------
  // Alias Senders (per-alias allowed/blocked sender domains)
  // sk = SENDER#${address}#${domain}  — distinct prefix from alias items
  // ---------------------------------------------------------------------------

  saveSender(accountId: string, address: string, domain: string, mode: SenderMode): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: {
          pk: pk(accountId),
          sk: `SENDER#${address}#${domain}`,
          gsi1pk: `SENDERS#${accountId}#${domain}`,
          gsi1sk: `ALIAS#${address}`,
          accountId, aliasAddress: address, domain, mode,
          addedAt: new Date().toISOString(),
        },
      })).then(() => undefined),
      toDbError,
    );
  }

  removeSender(accountId: string, address: string, domain: string): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new DeleteCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `SENDER#${address}#${domain}` },
      })).then(() => undefined),
      toDbError,
    );
  }

  getSender(accountId: string, address: string, domain: string): ResultAsync<AliasSender | null, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `SENDER#${address}#${domain}` },
      })).then(res => res.Item ? (res.Item as AliasSender) : null),
      toDbError,
    );
  }

  listSenders(accountId: string, address: string): ResultAsync<AliasSender[], DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": `SENDER#${address}#` },
      })).then(res => (res.Items ?? []) as AliasSender[]),
      toDbError,
    );
  }

  listAliasesForDomain(accountId: string, domain: string): ResultAsync<AliasSender[], DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `SENDERS#${accountId}#${domain}` },
      })).then(res => (res.Items ?? []) as AliasSender[]),
      toDbError,
    );
  }

  async getAccountFilteringConfig(accountId: string): Promise<ResultAsync<AccountFilteringConfig | null, DbError>> {
    const accountResult = await this.getAccount(accountId);
    if (accountResult.isErr()) return err(accountResult.error);
    return ok(accountResult.value?.filtering ?? null);
  }

  async getAccountRetentionDays(accountId: string): Promise<ResultAsync<number, DbError>> {
    const accountResult = await this.getAccount(accountId);
    if (accountResult.isErr()) return err(accountResult.error);
    return ok(accountResult.value?.deletionRetentionDays ?? 0);
  }

  async getProcessorAccountContext(accountId: string, recipientAddress: string): Promise<ResultAsync<{ retentionDays: number; filtering: AccountFilteringConfig | null; emailConfig: Alias | null; registeredDomains: string[]; userEmails: string[]; billingPlan: import("../embedding/retention-tier.js").BillingPlan }, DbError>> {
    const accountResult = await this.getAccount(accountId);
    if (accountResult.isErr()) return err(accountResult.error);
    const account = accountResult.value;

    const emailConfigResult = await this.getAlias(accountId, recipientAddress);
    if (emailConfigResult.isErr()) return err(emailConfigResult.error);
    const emailConfig = emailConfigResult.value;

    const domainsResult = await this.listDomains(accountId);
    if (domainsResult.isErr()) return err(domainsResult.error);
    const domains = domainsResult.value;

    return ok({
      retentionDays: account?.deletionRetentionDays ?? 0,
      filtering: account?.filtering ?? null,
      emailConfig,
      registeredDomains: domains.map((d) => d.domain),
      userEmails: [],
      billingPlan: account?.billingPlan ?? "Paid",
    });
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  listViews(accountId: string): ResultAsync<View[], DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "VIEW#" },
      })).then(res => ((res.Items ?? []) as View[]).sort((a, b) => a.position - b.position)),
      toDbError,
    );
  }

  getView(accountId: string, id: string): ResultAsync<View | null, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `VIEW#${id}` },
      })).then(res => res.Item ? (res.Item as View) : null),
      toDbError,
    );
  }

  async createView(accountId: string, data: CreateViewRequest): Promise<Result<View, DbError>> {
    const viewsResult = await this.listViews(accountId);
    if (viewsResult.isErr()) return err(viewsResult.error);
    const views = viewsResult.value;

    const now = new Date().toISOString();
    const view: View = {
      id: randomUUID(),
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

    const putResult = await ResultAsync.fromPromise(
      dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: { ...view, pk: pk(accountId), sk: `VIEW#${view.id}` },
      })).then(() => view),
      toDbError,
    );
    if (putResult.isErr()) return err(putResult.error);
    return ok(putResult.value);
  }

  updateView(accountId: string, id: string, data: UpdateViewRequest): ResultAsync<View, DbError> {
    const now = new Date().toISOString();
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

    return ResultAsync.fromPromise(
      dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `VIEW#${id}` },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
        ReturnValues: "ALL_NEW",
      })).then(res => res.Attributes as unknown as View),
      toDbError,
    );
  }

  deleteView(accountId: string, id: string): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new DeleteCommand({ TableName: ACCOUNTS_TABLE, Key: { pk: pk(accountId), sk: `VIEW#${id}` } })).then(() => undefined),
      toDbError,
    );
  }

  reorderViews(accountId: string, orderedIds: string[]): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      Promise.all(orderedIds.map((id, position) =>
        dynamo.send(new UpdateCommand({
          TableName: ACCOUNTS_TABLE,
          Key: { pk: pk(accountId), sk: `VIEW#${id}` },
          UpdateExpression: "SET #pos = :pos",
          ExpressionAttributeNames: { "#pos": "position" },
          ExpressionAttributeValues: { ":pos": position },
        })),
      )).then(() => undefined),
      toDbError,
    );
  }

  // ---------------------------------------------------------------------------
  // Labels
  // ---------------------------------------------------------------------------

  listLabels(accountId: string): ResultAsync<Label[], DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "LABEL#" },
      })).then(res => (res.Items ?? []) as Label[]),
      toDbError,
    );
  }

  createLabel(accountId: string, data: CreateLabelRequest): ResultAsync<Label, DbError> {
    const now = new Date().toISOString();
    const label: Label = {
      id: randomUUID(),
      accountId,
      name: data.name,
      ...(data.color !== undefined ? { color: data.color } : {}),
      ...(data.icon !== undefined ? { icon: data.icon } : {}),
      createdAt: now,
    };
    return ResultAsync.fromPromise(
      dynamo.send(new PutCommand({ TableName: ACCOUNTS_TABLE, Item: { ...label, pk: pk(accountId), sk: `LABEL#${label.id}` } })).then(() => label),
      toDbError,
    );
  }

  async updateLabel(accountId: string, id: string, data: UpdateLabelRequest): Promise<Result<Label, DbError>> {
    const setParts: string[] = [];
    const exprValues: Record<string, unknown> = {};
    const exprNames: Record<string, string> = {};

    if (data.name !== undefined) { setParts.push("#name = :name"); exprValues[":name"] = data.name; exprNames["#name"] = "name"; }
    if (data.color !== undefined) { setParts.push("color = :color"); exprValues[":color"] = data.color; }
    if (data.icon !== undefined) { setParts.push("icon = :icon"); exprValues[":icon"] = data.icon; }

    if (setParts.length === 0) {
      const getResult = await ResultAsync.fromPromise(
        dynamo.send(new GetCommand({
          TableName: ACCOUNTS_TABLE,
          Key: { pk: pk(accountId), sk: `LABEL#${id}` },
        })).then(res => res.Item as unknown as Label),
        toDbError,
      );
      if (getResult.isErr()) return err(getResult.error);
      return ok(getResult.value);
    }

    const updateResult = await ResultAsync.fromPromise(
      dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `LABEL#${id}` },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
        ReturnValues: "ALL_NEW",
      })).then(res => res.Attributes as unknown as Label),
      toDbError,
    );
    if (updateResult.isErr()) return err(updateResult.error);
    return ok(updateResult.value);
  }

  deleteLabel(accountId: string, id: string): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new DeleteCommand({ TableName: ACCOUNTS_TABLE, Key: { pk: pk(accountId), sk: `LABEL#${id}` } })).then(() => undefined),
      toDbError,
    );
  }

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------

  listRules(accountId: string): ResultAsync<Rule[], DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
        ExpressionAttributeValues: { ":pk": ruleGsi1pk(accountId), ":prefix": "RULE#" },
      })).then(res => (res.Items ?? []) as Rule[]),
      toDbError,
    );
  }

  listEnabledRules(accountId: string): ResultAsync<Rule[], DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
        ExpressionAttributeValues: { ":pk": ruleGsi1pk(accountId), ":prefix": "RULE#enabled#" },
      })).then(res => (res.Items ?? []) as Rule[]),
      toDbError,
    );
  }

  async createRule(accountId: string, data: CreateRuleRequest): Promise<Result<Rule, DbError>> {
    const allRulesResult = await this.listRules(accountId);
    if (allRulesResult.isErr()) return err(allRulesResult.error);
    const allRules = allRulesResult.value;

    const userRules = allRules.filter((r) => r.priorityOrder >= 100);
    const now = new Date().toISOString();
    const rule: Rule = {
      id: randomUUID(),
      accountId,
      name: data.name,
      condition: data.condition ?? "",
      actions: data.actions as Rule["actions"],
      status: "enabled",
      priorityOrder: data.priorityOrder ?? (userRules.length > 0 ? Math.max(...userRules.map((r) => r.priorityOrder)) + 1 : 100),
      ...(data.tags !== undefined ? { tags: data.tags } : {}),
      createdAt: now,
      updatedAt: now,
    };

    const putResult = await ResultAsync.fromPromise(
      dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: {
          ...rule,
          pk: pk(accountId), sk: `RULE#${rule.id}`,
          gsi1pk: ruleGsi1pk(accountId), gsi1sk: ruleGsi1sk(rule.status, rule.priorityOrder, rule.id),
        },
      })).then(() => rule),
      toDbError,
    );
    if (putResult.isErr()) return err(putResult.error);
    return ok(putResult.value);
  }

  async updateRule(accountId: string, id: string, data: UpdateRuleRequest): Promise<Result<Rule, DbError>> {
    const currentResult = await ResultAsync.fromPromise(
      dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `RULE#${id}` },
      })).then(res => res.Item as Rule),
      toDbError,
    );
    if (currentResult.isErr()) return err(currentResult.error);
    const existing = currentResult.value;

    const now = new Date().toISOString();
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
    if (data.actions !== undefined) { setParts.push("actions = :actions"); exprValues[":actions"] = data.actions; }
    if (data.priorityOrder !== undefined) { setParts.push("#pri = :pri"); exprValues[":pri"] = data.priorityOrder; exprNames["#pri"] = "priorityOrder"; }
    if (data.status !== undefined) { setParts.push("#status = :status"); exprValues[":status"] = data.status; exprNames["#status"] = "status"; }
    if (data.tags !== undefined) { setParts.push("tags = :tags"); exprValues[":tags"] = data.tags; }

    const updateResult = await ResultAsync.fromPromise(
      dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `RULE#${id}` },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
        ReturnValues: "ALL_NEW",
      })).then(res => res.Attributes as unknown as Rule),
      toDbError,
    );
    if (updateResult.isErr()) return err(updateResult.error);
    return ok(updateResult.value);
  }

  deleteRule(accountId: string, id: string): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new DeleteCommand({ TableName: ACCOUNTS_TABLE, Key: { pk: pk(accountId), sk: `RULE#${id}` } })).then(() => undefined),
      toDbError,
    );
  }

  // ---------------------------------------------------------------------------
  // Domains
  // ---------------------------------------------------------------------------

  listDomains(accountId: string): ResultAsync<Domain[], DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "DOMAIN#" },
      })).then(res => (res.Items ?? []) as Domain[]),
      toDbError,
    );
  }

  getDomain(accountId: string, id: string): ResultAsync<Domain | null, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { pk: pk(accountId), sk: `DOMAIN#${id}` } }))
        .then(res => res.Item ? res.Item as unknown as Domain : null),
      toDbError,
    );
  }

  getDomainByName(accountId: string, domainName: string): ResultAsync<Domain | null, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `DOMAIN#${domainName}` },
      })).then(res => res.Item ? res.Item as unknown as Domain : null),
      toDbError,
    );
  }

  createDomain(accountId: string, domain: string): ResultAsync<Domain, DbError> {
    const now = new Date().toISOString();
    const item: Domain = {
      id: domain,
      accountId,
      domain,
      receivingSetupComplete: false,
      senderSetupComplete: false,
      createdAt: now,
      updatedAt: now,
    };
    return ResultAsync.fromPromise(
      dynamo.send(new PutCommand({ TableName: ACCOUNTS_TABLE, Item: { ...item, pk: pk(accountId), sk: `DOMAIN#${domain}` } })).then(() => item),
      toDbError,
    );
  }

  deleteDomain(accountId: string, id: string): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new DeleteCommand({ TableName: ACCOUNTS_TABLE, Key: { pk: pk(accountId), sk: `DOMAIN#${id}` } })).then(() => undefined),
      toDbError,
    );
  }

  updateDomainHealth(accountId: string, id: string, health: {
    receivingHealthy: boolean;
    senderHealthy: boolean;
    failingRecords: string[];
    lastCheckedAt: string;
    lastHealthyAt?: string;
  }): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `DOMAIN#${id}` },
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
      })).then(() => undefined),
      toDbError,
    );
  }

  scanAllDomains(): ResultAsync<Array<{ accountId: string; domains: Domain[] }>, DbError> {
    return ResultAsync.fromPromise(
      (async () => {
        const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
        const accountDomains = new Map<string, Domain[]>();
        let lastKey: Record<string, unknown> | undefined;

        do {
          const res = await dynamo.send(new ScanCommand({
            TableName: ACCOUNTS_TABLE,
            FilterExpression: "begins_with(sk, :prefix)",
            ExpressionAttributeValues: { ":prefix": "DOMAIN#" },
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
        return results;
      })(),
      toDbError,
    );
  }

  // ---------------------------------------------------------------------------
  // Verified forwarding addresses
  // ---------------------------------------------------------------------------

  listVerifiedForwardingAddresses(accountId: string): ResultAsync<VerifiedForwardingAddress[], DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "FWDADDR#" },
      })).then(res => (res.Items ?? []) as VerifiedForwardingAddress[]),
      toDbError,
    );
  }

  getVerifiedForwardingAddress(accountId: string, address: string): ResultAsync<VerifiedForwardingAddress | null, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `FWDADDR#${address}` },
      })).then(res => res.Item ? (res.Item as VerifiedForwardingAddress) : null),
      toDbError,
    );
  }

  saveVerifiedForwardingAddress(addr: VerifiedForwardingAddress): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: { ...addr, pk: pk(addr.accountId), sk: `FWDADDR#${addr.address}` },
      })).then(() => undefined),
      toDbError,
    );
  }

  deleteVerifiedForwardingAddress(accountId: string, address: string): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new DeleteCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `FWDADDR#${address}` },
      })).then(() => undefined),
      toDbError,
    );
  }

  async disableForwardActions(accountId: string, toAddress: string): Promise<ResultAsync<void, DbError>> {
    const rulesResult = await this.listRules(accountId);
    if (rulesResult.isErr()) return err(rulesResult.error);
    const rules = rulesResult.value;

    const affected = rules.filter((r) => r.actions.some((a) => a.type === "forward" && a.value === toAddress && !a.disabled));
    for (const r of affected) {
      const updateResult = await this.updateRule(accountId, r.id, {
        actions: r.actions.map((a) =>
          a.type === "forward" && a.value === toAddress ? { ...a, disabled: true } : a,
        ),
      });
      if (updateResult.isErr()) return err(updateResult.error);
    }
    return ok(undefined);
  }

  // ---------------------------------------------------------------------------
  // Email Templates
  // ---------------------------------------------------------------------------

  createTemplate(template: EmailTemplate): ResultAsync<EmailTemplate, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: { ...template, pk: pk(template.accountId), sk: `TEMPLATE#${template.id}` },
      })).then(() => template),
      toDbError,
    );
  }

  getTemplate(accountId: string, id: string): ResultAsync<EmailTemplate | null, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `TEMPLATE#${id}` },
      })).then(res => res.Item ? (res.Item as EmailTemplate) : null),
      toDbError,
    );
  }

  async updateTemplate(accountId: string, id: string, update: Partial<Pick<EmailTemplate, "name" | "subject" | "body">>): Promise<Result<EmailTemplate, DbError>> {
    const now = new Date().toISOString();
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };
    const exprNames: Record<string, string> = {};
    if (update.name !== undefined) { setParts.push("#name = :name"); exprValues[":name"] = update.name; exprNames["#name"] = "name"; }
    if (update.subject !== undefined) { setParts.push("#subject = :subject"); exprValues[":subject"] = update.subject; exprNames["#subject"] = "subject"; }
    if (update.body !== undefined) { setParts.push("body = :body"); exprValues[":body"] = update.body; }

    const result = await ResultAsync.fromPromise(
      dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `TEMPLATE#${id}` },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
        ReturnValues: "ALL_NEW",
      })).then(res => res.Attributes as unknown as EmailTemplate),
      toDbError,
    );
    if (result.isErr()) return err(result.error);
    return ok(result.value);
  }

  deleteTemplate(accountId: string, id: string): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new DeleteCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `TEMPLATE#${id}` },
      })).then(() => undefined),
      toDbError,
    );
  }

  listTemplates(accountId: string): ResultAsync<EmailTemplate[], DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "TEMPLATE#" },
      })).then(res => (res.Items ?? []) as EmailTemplate[]),
      toDbError,
    );
  }

  // ---------------------------------------------------------------------------
  // WebSocket Connections
  // ---------------------------------------------------------------------------

  saveWsConnection(conn: WsConnection): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: { ...conn, pk: pk(conn.accountId), sk: `CONN#${conn.connectionId}` },
      })).then(() => undefined),
      toDbError,
    );
  }

  listWsConnections(accountId: string): ResultAsync<WsConnection[], DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "CONN#" },
      })).then(res => (res.Items ?? []) as WsConnection[]),
      toDbError,
    );
  }

  deleteWsConnection(accountId: string, connectionId: string): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new DeleteCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `CONN#${connectionId}` },
      })).then(() => undefined),
      toDbError,
    );
  }
}
