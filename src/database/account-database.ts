import { randomUUID } from "crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, ACCOUNTS_TABLE } from "./shared.js";
import type { Account, View, Label, Rule, Domain, Alias, AccountFilteringConfig, VerifiedForwardingAddress } from "../types/index.js";
import type { CreateViewRequest, UpdateViewRequest, CreateLabelRequest, UpdateLabelRequest, CreateRuleRequest, UpdateRuleRequest } from "../api/app.js";

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

const pk = (accountId: string) => `ACCT#${accountId}`;

// ---------------------------------------------------------------------------
// AccountDatabase
// Owns: Account record (with embedded aliases), Views, Labels, Rules, Domains
// Table: ACCOUNTS_TABLE
// ---------------------------------------------------------------------------

export class AccountDatabase {
  // ---------------------------------------------------------------------------
  // Account
  // ---------------------------------------------------------------------------

  async getAccount(accountId: string): Promise<Account | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { pk: pk(accountId), sk: "META" },
    }));
    return result.Item ? (result.Item as Account) : null;
  }

  async updateAccount(accountId: string, update: Partial<Pick<Account, "name" | "deletionRetentionDays" | "notifications" | "filtering">>): Promise<Account> {
    const now = new Date().toISOString();
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };
    const exprNames: Record<string, string> = {};

    if (update.name !== undefined) { setParts.push("#name = :name"); exprValues[":name"] = update.name; exprNames["#name"] = "name"; }
    if (update.deletionRetentionDays !== undefined) { setParts.push("deletionRetentionDays = :drd"); exprValues[":drd"] = update.deletionRetentionDays; }
    if (update.notifications !== undefined) { setParts.push("notifications = :notif"); exprValues[":notif"] = update.notifications; }
    if (update.filtering !== undefined) { setParts.push("filtering = :filtering"); exprValues[":filtering"] = update.filtering; }

    await dynamo.send(new UpdateCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { pk: pk(accountId), sk: "META" },
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ExpressionAttributeValues: exprValues,
      ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
    }));
    return (await this.getAccount(accountId))!;
  }

  // ---------------------------------------------------------------------------
  // Email address configs (embedded in Account record)
  // ---------------------------------------------------------------------------

  async getAlias(accountId: string, address: string): Promise<Alias | null> {
    const account = await this.getAccount(accountId);
    return account?.aliases?.[address] ?? null;
  }

  async saveAlias(alias: Alias): Promise<Alias> {
    const now = new Date().toISOString();
    await dynamo.send(new UpdateCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { pk: pk(alias.accountId), sk: "META" },
      UpdateExpression: "SET aliases.#addr = :alias, updatedAt = :now",
      ExpressionAttributeNames: { "#addr": alias.address },
      ExpressionAttributeValues: { ":alias": alias, ":now": now },
    }));
    return alias;
  }

  async createAlias(alias: Alias): Promise<Alias> {
    return this.saveAlias(alias);
  }

  async listAliases(accountId: string): Promise<Alias[]> {
    const account = await this.getAccount(accountId);
    return Object.values(account?.aliases ?? {});
  }

  async upsertAlias(alias: Alias): Promise<Alias> {
    return this.saveAlias(alias);
  }

  async deleteAlias(accountId: string, address: string): Promise<void> {
    const now = new Date().toISOString();
    await dynamo.send(new UpdateCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { pk: pk(accountId), sk: "META" },
      UpdateExpression: "REMOVE aliases.#addr SET updatedAt = :now",
      ExpressionAttributeNames: { "#addr": address },
      ExpressionAttributeValues: { ":now": now },
    }));
  }

  async getAccountFilteringConfig(accountId: string): Promise<AccountFilteringConfig | null> {
    const account = await this.getAccount(accountId);
    return account?.filtering ?? null;
  }

  async getAccountRetentionDays(accountId: string): Promise<number> {
    const account = await this.getAccount(accountId);
    return account?.deletionRetentionDays ?? 0;
  }

  async getProcessorAccountContext(accountId: string, recipientAddress: string): Promise<{ retentionDays: number; filtering: AccountFilteringConfig | null; emailConfig: Alias | null; registeredDomains: string[]; userEmails: string[] }> {
    const [account, domains] = await Promise.all([
      this.getAccount(accountId),
      this.listDomains(accountId),
    ]);
    return {
      retentionDays: account?.deletionRetentionDays ?? 0,
      filtering: account?.filtering ?? null,
      emailConfig: account?.aliases?.[recipientAddress] ?? null,
      registeredDomains: domains.map((d) => d.domain),
      // userEmails fetched via Authress at runtime; placeholder empty array here
      userEmails: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  async listViews(accountId: string): Promise<View[]> {
    const res = await dynamo.send(new QueryCommand({
      TableName: ACCOUNTS_TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "VIEW#" },
    }));
    return ((res.Items ?? []) as View[]).sort((a, b) => a.position - b.position);
  }

  async getView(accountId: string, id: string): Promise<View | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { pk: pk(accountId), sk: `VIEW#${id}` },
    }));
    return result.Item ? (result.Item as View) : null;
  }

  async createView(accountId: string, data: CreateViewRequest): Promise<View> {
    const views = await this.listViews(accountId);
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
    await dynamo.send(new PutCommand({
      TableName: ACCOUNTS_TABLE,
      Item: { ...view, pk: pk(accountId), sk: `VIEW#${view.id}` },
    }));
    return view;
  }

  async updateView(accountId: string, id: string, data: UpdateViewRequest): Promise<View> {
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

    await dynamo.send(new UpdateCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { pk: pk(accountId), sk: `VIEW#${id}` },
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ExpressionAttributeValues: exprValues,
      ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
    }));
    return (await this.getView(accountId, id))!;
  }

  async deleteView(accountId: string, id: string): Promise<void> {
    await dynamo.send(new DeleteCommand({ TableName: ACCOUNTS_TABLE, Key: { pk: pk(accountId), sk: `VIEW#${id}` } }));
  }

  async reorderViews(accountId: string, orderedIds: string[]): Promise<void> {
    await Promise.all(orderedIds.map((id, position) =>
      dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `VIEW#${id}` },
        UpdateExpression: "SET #pos = :pos",
        ExpressionAttributeNames: { "#pos": "position" },
        ExpressionAttributeValues: { ":pos": position },
      })),
    ));
  }

  // ---------------------------------------------------------------------------
  // Labels
  // ---------------------------------------------------------------------------

  async listLabels(accountId: string): Promise<Label[]> {
    const res = await dynamo.send(new QueryCommand({
      TableName: ACCOUNTS_TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "LABEL#" },
    }));
    return (res.Items ?? []) as Label[];
  }

  async createLabel(accountId: string, data: CreateLabelRequest): Promise<Label> {
    const now = new Date().toISOString();
    const label: Label = {
      id: randomUUID(),
      accountId,
      name: data.name,
      ...(data.color !== undefined ? { color: data.color } : {}),
      ...(data.icon !== undefined ? { icon: data.icon } : {}),
      createdAt: now,
    };
    await dynamo.send(new PutCommand({ TableName: ACCOUNTS_TABLE, Item: { ...label, pk: pk(accountId), sk: `LABEL#${label.id}` } }));
    return label;
  }

  async updateLabel(accountId: string, id: string, data: UpdateLabelRequest): Promise<Label> {
    const setParts: string[] = [];
    const exprValues: Record<string, unknown> = {};
    const exprNames: Record<string, string> = {};

    if (data.name !== undefined) { setParts.push("#name = :name"); exprValues[":name"] = data.name; exprNames["#name"] = "name"; }
    if (data.color !== undefined) { setParts.push("color = :color"); exprValues[":color"] = data.color; }
    if (data.icon !== undefined) { setParts.push("icon = :icon"); exprValues[":icon"] = data.icon; }

    if (setParts.length > 0) {
      await dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `LABEL#${id}` },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
      }));
    }

    const labels = await this.listLabels(accountId);
    return labels.find((l) => l.id === id)!;
  }

  async deleteLabel(accountId: string, id: string): Promise<void> {
    await dynamo.send(new DeleteCommand({ TableName: ACCOUNTS_TABLE, Key: { pk: pk(accountId), sk: `LABEL#${id}` } }));
  }

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------

  async listRules(accountId: string): Promise<Rule[]> {
    const res = await dynamo.send(new QueryCommand({
      TableName: ACCOUNTS_TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "RULE#" },
    }));
    return ((res.Items ?? []) as Rule[]).sort((a, b) => a.position - b.position);
  }

  async createRule(accountId: string, data: CreateRuleRequest): Promise<Rule> {
    const rules = await this.listRules(accountId);
    const now = new Date().toISOString();
    const rule: Rule = {
      id: randomUUID(),
      accountId,
      name: data.name,
      condition: data.condition,
      actions: data.actions,
      position: data.position ?? (rules.length > 0 ? Math.max(...rules.map((r) => r.position)) + 1 : 0),
      createdAt: now,
      updatedAt: now,
    };
    await dynamo.send(new PutCommand({ TableName: ACCOUNTS_TABLE, Item: { ...rule, pk: pk(accountId), sk: `RULE#${rule.id}` } }));
    return rule;
  }

  async updateRule(accountId: string, id: string, data: UpdateRuleRequest): Promise<Rule> {
    const now = new Date().toISOString();
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };
    const exprNames: Record<string, string> = {};

    if (data.name !== undefined) { setParts.push("#name = :name"); exprValues[":name"] = data.name; exprNames["#name"] = "name"; }
    if (data.condition !== undefined) { setParts.push("#cond = :cond"); exprValues[":cond"] = data.condition; exprNames["#cond"] = "condition"; }
    if (data.actions !== undefined) { setParts.push("actions = :actions"); exprValues[":actions"] = data.actions; }
    if (data.position !== undefined) { setParts.push("#pos = :pos"); exprValues[":pos"] = data.position; exprNames["#pos"] = "position"; }

    await dynamo.send(new UpdateCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { pk: pk(accountId), sk: `RULE#${id}` },
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ExpressionAttributeValues: exprValues,
      ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
    }));
    const rules = await this.listRules(accountId);
    return rules.find((r) => r.id === id)!;
  }

  async deleteRule(accountId: string, id: string): Promise<void> {
    await dynamo.send(new DeleteCommand({ TableName: ACCOUNTS_TABLE, Key: { pk: pk(accountId), sk: `RULE#${id}` } }));
  }

  async reorderRules(accountId: string, orderedIds: string[]): Promise<void> {
    await Promise.all(orderedIds.map((id, position) =>
      dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `RULE#${id}` },
        UpdateExpression: "SET #pos = :pos",
        ExpressionAttributeNames: { "#pos": "position" },
        ExpressionAttributeValues: { ":pos": position },
      })),
    ));
  }

  // ---------------------------------------------------------------------------
  // Domains
  // ---------------------------------------------------------------------------

  async listDomains(accountId: string): Promise<Domain[]> {
    const res = await dynamo.send(new QueryCommand({
      TableName: ACCOUNTS_TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "DOMAIN#" },
    }));
    return (res.Items ?? []) as Domain[];
  }

  async getDomain(accountId: string, id: string): Promise<Domain | null> {
    const result = await dynamo.send(new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { pk: pk(accountId), sk: `DOMAIN#${id}` } }));
    return result.Item ? (result.Item as Domain) : null;
  }

  async createDomain(accountId: string, domain: string): Promise<Domain> {
    const now = new Date().toISOString();
    const item: Domain = {
      id: randomUUID(),
      accountId,
      domain,
      receivingSetupComplete: false,
      senderSetupComplete: false,
      createdAt: now,
      updatedAt: now,
    };
    await dynamo.send(new PutCommand({ TableName: ACCOUNTS_TABLE, Item: { ...item, pk: pk(accountId), sk: `DOMAIN#${item.id}` } }));
    return item;
  }

  async deleteDomain(accountId: string, id: string): Promise<void> {
    await dynamo.send(new DeleteCommand({ TableName: ACCOUNTS_TABLE, Key: { pk: pk(accountId), sk: `DOMAIN#${id}` } }));
  }

  // ---------------------------------------------------------------------------
  // Verified forwarding addresses
  // ---------------------------------------------------------------------------

  async listVerifiedForwardingAddresses(accountId: string): Promise<VerifiedForwardingAddress[]> {
    const res = await dynamo.send(new QueryCommand({
      TableName: ACCOUNTS_TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "FWDADDR#" },
    }));
    return (res.Items ?? []) as VerifiedForwardingAddress[];
  }

  async getVerifiedForwardingAddress(accountId: string, address: string): Promise<VerifiedForwardingAddress | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { pk: pk(accountId), sk: `FWDADDR#${address}` },
    }));
    return result.Item ? (result.Item as VerifiedForwardingAddress) : null;
  }

  async saveVerifiedForwardingAddress(addr: VerifiedForwardingAddress): Promise<void> {
    await dynamo.send(new PutCommand({
      TableName: ACCOUNTS_TABLE,
      Item: { ...addr, pk: pk(addr.accountId), sk: `FWDADDR#${addr.address}` },
    }));
  }

  async deleteVerifiedForwardingAddress(accountId: string, address: string): Promise<void> {
    await dynamo.send(new DeleteCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { pk: pk(accountId), sk: `FWDADDR#${address}` },
    }));
  }

  // Disable all forward actions targeting a failed address across all account rules.
  async disableForwardActions(accountId: string, toAddress: string): Promise<void> {
    const rules = await this.listRules(accountId);
    const affected = rules.filter((r) => r.actions.some((a) => a.type === "forward" && a.value === toAddress && !a.disabled));
    await Promise.all(
      affected.map((r) =>
        this.updateRule(accountId, r.id, {
          actions: r.actions.map((a) =>
            a.type === "forward" && a.value === toAddress ? { ...a, disabled: true } : a,
          ),
        }),
      ),
    );
  }
}
