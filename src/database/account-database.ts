import { randomUUID } from "crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, ACCOUNTS_TABLE } from "./shared.js";
import { dbError, notFoundError, ok, err } from "../errors.js";
import type { Result, DbError, NotFoundError } from "../errors.js";
import type { Account, View, Label, Rule, RuleStatus, Domain, Alias, AliasSender, SenderPolicy, AccountFilteringConfig, VerifiedForwardingAddress, EmailTemplate, WsConnection } from "../types/index.js";
import type { StatsCategory } from "../types/index.js";
import type { CreateViewRequest, UpdateViewRequest, CreateLabelRequest, UpdateLabelRequest, CreateRuleRequest, UpdateRuleRequest } from "../api/app.js";
import { buildStatsUpdateParams, buildPruneNames } from "./stats-writer.js";

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

const pk = (accountId: string) => `ACCT#${accountId}`;

function ruleGsi1pk(accountId: string) { return `ACCT#${accountId}`; }
function ruleGsi1sk(status: RuleStatus, priorityOrder: number, id: string) {
  return `RULE#${status}#${String(priorityOrder).padStart(6, "0")}#${id}`;
}

// ---------------------------------------------------------------------------
// AccountDatabase
// Owns: Account record, Aliases, Views, Labels, Rules, Domains
// Table: ACCOUNTS_TABLE
// ---------------------------------------------------------------------------

export class AccountDatabase {
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
        Item: { ...account, pk: pk(account.id), sk: "META" },
        ConditionExpression: "attribute_not_exists(pk)",
      }));
      return ok(account);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateAccount(accountId: string, update: Partial<Pick<Account, "name" | "deletionRetentionDays" | "notifications" | "filtering" | "onboarding">>): Promise<Result<Account, DbError>> {
    const now = new Date().toISOString();
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };
    const exprNames: Record<string, string> = {};

    if (update.name !== undefined) { setParts.push("#name = :name"); exprValues[":name"] = update.name; exprNames["#name"] = "name"; }
    if (update.deletionRetentionDays !== undefined) { setParts.push("deletionRetentionDays = :drd"); exprValues[":drd"] = update.deletionRetentionDays; }
    if (update.notifications !== undefined) { setParts.push("notifications = :notif"); exprValues[":notif"] = update.notifications; }
    if (update.filtering !== undefined) { setParts.push("filtering = :filtering"); exprValues[":filtering"] = update.filtering; }
    if (update.onboarding !== undefined) { setParts.push("onboarding = :onboarding"); exprValues[":onboarding"] = update.onboarding; }

    try {
      const res = await dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: "META" },
        UpdateExpression: `SET ${setParts.join(", ")}`,
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
  // Aliases (each stored as its own item: SK = ALIAS#${address})
  // ---------------------------------------------------------------------------

  async getAlias(accountId: string, address: string): Promise<Result<Alias | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `ALIAS#${address}` },
      }));
      return ok(res.Item ? (res.Item as Alias) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async saveAlias(alias: Alias): Promise<Result<Alias, DbError>> {
    try {
      await dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: { ...alias, pk: pk(alias.accountId), sk: `ALIAS#${alias.address}` },
      }));
      return ok(alias);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async createAlias(alias: Alias): Promise<Result<Alias, DbError>> {
    return this.saveAlias(alias);
  }

  async listAliases(accountId: string): Promise<Result<Alias[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "ALIAS#" },
      }));
      return ok((res.Items ?? []) as Alias[]);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async upsertAlias(alias: Alias): Promise<Result<Alias, DbError>> {
    return this.saveAlias(alias);
  }

  async deleteAlias(accountId: string, address: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new DeleteCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `ALIAS#${address}` },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
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

    const renamed: Alias = { ...old, address: newAddress, updatedAt: new Date().toISOString() };
    const saveResult = await this.saveAlias(renamed);
    if (saveResult.isErr()) return err(saveResult.error);

    for (const s of senders) {
      const saveSenderResult = await this.saveSender(accountId, newAddress, s.domain, s.policy);
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

  async saveSender(accountId: string, address: string, domain: string, policy: SenderPolicy): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: {
          pk: pk(accountId),
          sk: `SENDER#${address}#${domain}`,
          gsi1pk: `SENDERS#${accountId}#${domain}`,
          gsi1sk: `ALIAS#${address}`,
          accountId, aliasAddress: address, domain, policy,
          addedAt: new Date().toISOString(),
        },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async removeSender(accountId: string, address: string, domain: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new DeleteCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `SENDER#${address}#${domain}` },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async getSender(accountId: string, address: string, domain: string): Promise<Result<AliasSender | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `SENDER#${address}#${domain}` },
      }));
      return ok(res.Item ? (res.Item as AliasSender) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async listSenders(accountId: string, address: string): Promise<Result<AliasSender[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": `SENDER#${address}#` },
      }));
      return ok((res.Items ?? []) as AliasSender[]);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async listAliasesForDomain(accountId: string, domain: string): Promise<Result<AliasSender[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `SENDERS#${accountId}#${domain}` },
      }));
      return ok((res.Items ?? []) as AliasSender[]);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async getAccountFilteringConfig(accountId: string): Promise<Result<AccountFilteringConfig | null, DbError>> {
    const accountResult = await this.getAccount(accountId);
    if (accountResult.isErr()) return err(accountResult.error);
    return ok(accountResult.value?.filtering ?? null);
  }

  async getAccountRetentionDays(accountId: string): Promise<Result<number, DbError>> {
    const accountResult = await this.getAccount(accountId);
    if (accountResult.isErr()) return err(accountResult.error);
    return ok(accountResult.value?.deletionRetentionDays ?? 0);
  }

  async getProcessorAccountContext(accountId: string, recipientAddress: string): Promise<Result<{ retentionDays: number; filtering: AccountFilteringConfig | null; emailConfig: Alias | null; registeredDomains: string[]; userEmails: string[]; billingPlan: import("../embedding/retention-tier.js").BillingPlan }, DbError>> {
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
    const now = new Date().toISOString();
    const label: Label = {
      id: randomUUID(),
      accountId,
      name: data.name,
      ...(data.color !== undefined ? { color: data.color } : {}),
      ...(data.icon !== undefined ? { icon: data.icon } : {}),
      createdAt: now,
    };
    try {
      await dynamo.send(new PutCommand({ TableName: ACCOUNTS_TABLE, Item: { ...label, pk: pk(accountId), sk: `LABEL#${label.id}` } }));
      return ok(label);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateLabel(accountId: string, id: string, data: UpdateLabelRequest): Promise<Result<Label, DbError>> {
    const setParts: string[] = [];
    const exprValues: Record<string, unknown> = {};
    const exprNames: Record<string, string> = {};

    if (data.name !== undefined) { setParts.push("#name = :name"); exprValues[":name"] = data.name; exprNames["#name"] = "name"; }
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
        ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
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
      return ok((res.Items ?? []) as Rule[]);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async listEnabledRules(accountId: string): Promise<Result<Rule[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
        ExpressionAttributeValues: { ":pk": ruleGsi1pk(accountId), ":prefix": "RULE#enabled#" },
      }));
      return ok((res.Items ?? []) as Rule[]);
    } catch (e) {
      return err(dbError(e));
    }
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

  async updateRule(accountId: string, id: string, data: UpdateRuleRequest): Promise<Result<Rule, DbError>> {
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

    try {
      const res = await dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `RULE#${id}` },
        UpdateExpression: `SET ${setParts.join(", ")}`,
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
        ExpressionAttributeValues: { ":err": errorMessage, ":now": new Date().toISOString() },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Domains
  // ---------------------------------------------------------------------------

  async listDomains(accountId: string): Promise<Result<Domain[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "DOMAIN#" },
      }));
      return ok((res.Items ?? []) as Domain[]);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async getDomain(accountId: string, id: string): Promise<Result<Domain | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { pk: pk(accountId), sk: `DOMAIN#${id}` } }));
      return ok(res.Item ? res.Item as unknown as Domain : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async getDomainByName(accountId: string, domainName: string): Promise<Result<Domain | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `DOMAIN#${domainName}` },
      }));
      return ok(res.Item ? res.Item as unknown as Domain : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async createDomain(accountId: string, domain: string): Promise<Result<Domain, DbError>> {
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
    try {
      await dynamo.send(new PutCommand({ TableName: ACCOUNTS_TABLE, Item: { ...item, pk: pk(accountId), sk: `DOMAIN#${domain}` } }));
      return ok(item);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async deleteDomain(accountId: string, id: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new DeleteCommand({ TableName: ACCOUNTS_TABLE, Key: { pk: pk(accountId), sk: `DOMAIN#${id}` } }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateDomainHealth(accountId: string, id: string, health: {
    receivingHealthy: boolean;
    senderHealthy: boolean;
    failingRecords: string[];
    lastCheckedAt: string;
    lastHealthyAt?: string;
  }): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new UpdateCommand({
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
      return ok(results);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Verified forwarding addresses
  // ---------------------------------------------------------------------------

  async listVerifiedForwardingAddresses(accountId: string): Promise<Result<VerifiedForwardingAddress[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "FWDADDR#" },
      }));
      return ok((res.Items ?? []) as VerifiedForwardingAddress[]);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async getVerifiedForwardingAddress(accountId: string, address: string): Promise<Result<VerifiedForwardingAddress | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `FWDADDR#${address}` },
      }));
      return ok(res.Item ? (res.Item as VerifiedForwardingAddress) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async saveVerifiedForwardingAddress(addr: VerifiedForwardingAddress): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: { ...addr, pk: pk(addr.accountId), sk: `FWDADDR#${addr.address}` },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async deleteVerifiedForwardingAddress(accountId: string, address: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new DeleteCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `FWDADDR#${address}` },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async disableForwardActions(accountId: string, toAddress: string): Promise<Result<void, DbError>> {
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

  async updateTemplate(accountId: string, id: string, update: Partial<Pick<EmailTemplate, "name" | "subject" | "body">>): Promise<Result<EmailTemplate, DbError>> {
    const now = new Date().toISOString();
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };
    const exprNames: Record<string, string> = {};
    if (update.name !== undefined) { setParts.push("#name = :name"); exprValues[":name"] = update.name; exprNames["#name"] = "name"; }
    if (update.subject !== undefined) { setParts.push("#subject = :subject"); exprValues[":subject"] = update.subject; exprNames["#subject"] = "subject"; }
    if (update.body !== undefined) { setParts.push("body = :body"); exprValues[":body"] = update.body; }

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
  // Stats
  // ---------------------------------------------------------------------------

  async incrementStats(accountId: string, category: StatsCategory): Promise<Result<void, DbError>> {
    const now = new Date();
    const params = buildStatsUpdateParams(accountId, category, now, ACCOUNTS_TABLE);
    const pruneResult = buildPruneNames(now);
    const finalExpression = pruneResult.expression
      ? `${params.UpdateExpression} ${pruneResult.expression}`
      : params.UpdateExpression;
    try {
      await dynamo.send(new UpdateCommand({
        ...params,
        UpdateExpression: finalExpression,
        ExpressionAttributeNames: { ...params.ExpressionAttributeNames, ...pruneResult.names },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async getStats(accountId: string): Promise<Result<Record<string, unknown> | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: `ACCT#${accountId}`, sk: "STATS" },
      }));
      return ok(res.Item ? (res.Item as Record<string, unknown>) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }
}
