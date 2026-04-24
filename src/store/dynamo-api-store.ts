import { randomUUID } from "crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, TABLE, encodeCursor, decodeCursor } from "./dynamo-client.js";
import type { ApiStore, ListArcsParams, UpdateArcRequest, CreateViewRequest, UpdateViewRequest, CreateLabelRequest, UpdateLabelRequest, CreateRuleRequest, UpdateRuleRequest } from "../api/app.js";
import type { Arc, Signal, View, Label, Rule, Domain, Account, Page, PageParams, EmailAddressConfig, SuppressedAddress } from "../types/index.js";

export class DynamoApiStore implements ApiStore {
  // ---------------------------------------------------------------------------
  // Arcs
  // ---------------------------------------------------------------------------

  async listArcs(accountId: string, params: ListArcsParams): Promise<Page<Arc>> {
    const limit = Math.min(params.limit ?? 20, 100);
    const res = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `ACCT#${accountId}`, ":prefix": "ARC#" },
      ScanIndexForward: false,
      Limit: 200,
      ...(params.cursor ? { ExclusiveStartKey: decodeCursor(params.cursor) } : {}),
    }));

    let items = (res.Items ?? []) as Arc[];
    if (params.workflow) items = items.filter((a) => a.workflow === params.workflow);
    if (params.status) items = items.filter((a) => a.status === params.status);
    if (params.label) items = items.filter((a) => a.labels.includes(params.label!));

    const page = items.slice(0, limit);
    const nextKey = items.length > limit && res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
    return { items: page, total: items.length, ...(nextKey ? { nextCursor: nextKey } : {}) };
  }

  async getArc(accountId: string, id: string): Promise<Arc | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `ARC#${id}`, sk: "ARC" },
    }));
    if (!result.Item) return null;
    const arc = result.Item as Arc;
    return arc.accountId === accountId ? arc : null;
  }

  async updateArc(accountId: string, id: string, update: UpdateArcRequest): Promise<void> {
    const now = new Date().toISOString();
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now, ":accountId": accountId };
    const exprNames: Record<string, string> = {};

    if (update.status !== undefined) {
      setParts.push("#status = :status");
      exprValues[":status"] = update.status;
      exprNames["#status"] = "status";
      if (update.status === "deleted") {
        setParts.push("deletedAt = :now");
      }
    }
    if (update.labels !== undefined) {
      setParts.push("labels = :labels");
      exprValues[":labels"] = update.labels;
    }

    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `ARC#${id}`, sk: "ARC" },
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ConditionExpression: "accountId = :accountId",
      ExpressionAttributeValues: exprValues,
      ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
    }));
  }

  async createArc(arc: Arc): Promise<void> {
    await dynamo.send(new PutCommand({
      TableName: TABLE,
      Item: {
        ...arc,
        pk: `ARC#${arc.id}`,
        sk: "ARC",
        gsi1pk: `ACCT#${arc.accountId}`,
        gsi1sk: `ARC#${arc.lastSignalAt}#${arc.id}`,
      },
    }));
  }

  // ---------------------------------------------------------------------------
  // Signals
  // ---------------------------------------------------------------------------

  async listSignals(accountId: string, arcId: string, params: PageParams): Promise<Page<Signal>> {
    const limit = Math.min(params.limit ?? 20, 100);
    const res = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `ARCSIG#${arcId}`, ":prefix": "RECV#" },
      ScanIndexForward: false,
      Limit: limit + 1,
      ...(params.cursor ? { ExclusiveStartKey: decodeCursor(params.cursor) } : {}),
    }));

    const items = (res.Items ?? []) as Signal[];
    const page = items.slice(0, limit);
    const nextKey = items.length > limit && res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
    return { items: page, total: items.length, ...(nextKey ? { nextCursor: nextKey } : {}) };
  }

  async getSignal(accountId: string, id: string): Promise<Signal | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `SIG#${id}`, sk: "SIGNAL" },
    }));
    if (!result.Item) return null;
    const signal = result.Item as Signal;
    return signal.accountId === accountId ? signal : null;
  }

  async unblockSignal(accountId: string, signalId: string, arcId: string): Promise<void> {
    const signal = await this.getSignal(accountId, signalId);
    if (!signal) return;

    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `SIG#${signalId}`, sk: "SIGNAL" },
      UpdateExpression: "SET arcId = :arcId, #status = :status, gsi1pk = :gsi1pk",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":arcId": arcId,
        ":status": "active",
        ":gsi1pk": `ARCSIG#${arcId}`,
      },
    }));
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  async listViews(accountId: string): Promise<View[]> {
    const res = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `ACCT#${accountId}`, ":prefix": "VIEW#" },
    }));
    return ((res.Items ?? []) as View[]).sort((a, b) => a.position - b.position);
  }

  async getView(accountId: string, id: string): Promise<View | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `ACCT#${accountId}`, sk: `VIEW#${id}` },
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
      TableName: TABLE,
      Item: { ...view, pk: `ACCT#${accountId}`, sk: `VIEW#${view.id}` },
    }));
    return view;
  }

  async updateView(accountId: string, id: string, data: UpdateViewRequest): Promise<void> {
    const now = new Date().toISOString();
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };

    if (data.name !== undefined) { setParts.push("#name = :name"); exprValues[":name"] = data.name; }
    if (data.workflow !== undefined) { setParts.push("workflow = :workflow"); exprValues[":workflow"] = data.workflow; }
    if (data.labels !== undefined) { setParts.push("labels = :labels"); exprValues[":labels"] = data.labels; }
    if (data.sortField !== undefined) { setParts.push("sortField = :sortField"); exprValues[":sortField"] = data.sortField; }
    if (data.sortDirection !== undefined) { setParts.push("sortDirection = :sortDirection"); exprValues[":sortDirection"] = data.sortDirection; }
    if (data.icon !== undefined) { setParts.push("icon = :icon"); exprValues[":icon"] = data.icon; }
    if (data.color !== undefined) { setParts.push("color = :color"); exprValues[":color"] = data.color; }
    if (data.position !== undefined) { setParts.push("#position = :position"); exprValues[":position"] = data.position; }

    const exprNames: Record<string, string> = {};
    if (data.name !== undefined) exprNames["#name"] = "name";
    if (data.position !== undefined) exprNames["#position"] = "position";

    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `ACCT#${accountId}`, sk: `VIEW#${id}` },
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ExpressionAttributeValues: exprValues,
      ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
    }));
  }

  async deleteView(accountId: string, id: string): Promise<void> {
    await dynamo.send(new DeleteCommand({
      TableName: TABLE,
      Key: { pk: `ACCT#${accountId}`, sk: `VIEW#${id}` },
    }));
  }

  async reorderViews(accountId: string, orderedIds: string[]): Promise<void> {
    await Promise.all(orderedIds.map((id, position) =>
      dynamo.send(new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `ACCT#${accountId}`, sk: `VIEW#${id}` },
        UpdateExpression: "SET #position = :position",
        ExpressionAttributeNames: { "#position": "position" },
        ExpressionAttributeValues: { ":position": position },
      })),
    ));
  }

  // ---------------------------------------------------------------------------
  // Labels
  // ---------------------------------------------------------------------------

  async listLabels(accountId: string): Promise<Label[]> {
    const res = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `ACCT#${accountId}`, ":prefix": "LABEL#" },
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
    await dynamo.send(new PutCommand({
      TableName: TABLE,
      Item: { ...label, pk: `ACCT#${accountId}`, sk: `LABEL#${label.id}` },
    }));
    return label;
  }

  async updateLabel(accountId: string, id: string, data: UpdateLabelRequest): Promise<void> {
    const setParts: string[] = [];
    const exprValues: Record<string, unknown> = {};
    const exprNames: Record<string, string> = {};

    if (data.name !== undefined) { setParts.push("#name = :name"); exprValues[":name"] = data.name; exprNames["#name"] = "name"; }
    if (data.color !== undefined) { setParts.push("color = :color"); exprValues[":color"] = data.color; }
    if (data.icon !== undefined) { setParts.push("icon = :icon"); exprValues[":icon"] = data.icon; }

    if (setParts.length === 0) return;

    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `ACCT#${accountId}`, sk: `LABEL#${id}` },
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ExpressionAttributeValues: exprValues,
      ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
    }));
  }

  async deleteLabel(accountId: string, id: string): Promise<void> {
    await dynamo.send(new DeleteCommand({
      TableName: TABLE,
      Key: { pk: `ACCT#${accountId}`, sk: `LABEL#${id}` },
    }));
  }

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------

  async listRules(accountId: string): Promise<Rule[]> {
    const res = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `ACCT#${accountId}`, ":prefix": "RULE#" },
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
    await dynamo.send(new PutCommand({
      TableName: TABLE,
      Item: { ...rule, pk: `ACCT#${accountId}`, sk: `RULE#${rule.id}` },
    }));
    return rule;
  }

  async updateRule(accountId: string, id: string, data: UpdateRuleRequest): Promise<void> {
    const now = new Date().toISOString();
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };
    const exprNames: Record<string, string> = {};

    if (data.name !== undefined) { setParts.push("#name = :name"); exprValues[":name"] = data.name; exprNames["#name"] = "name"; }
    if (data.condition !== undefined) { setParts.push("#condition = :condition"); exprValues[":condition"] = data.condition; exprNames["#condition"] = "condition"; }
    if (data.actions !== undefined) { setParts.push("actions = :actions"); exprValues[":actions"] = data.actions; }
    if (data.position !== undefined) { setParts.push("#position = :position"); exprValues[":position"] = data.position; exprNames["#position"] = "position"; }

    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `ACCT#${accountId}`, sk: `RULE#${id}` },
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ExpressionAttributeValues: exprValues,
      ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
    }));
  }

  async deleteRule(accountId: string, id: string): Promise<void> {
    await dynamo.send(new DeleteCommand({
      TableName: TABLE,
      Key: { pk: `ACCT#${accountId}`, sk: `RULE#${id}` },
    }));
  }

  async reorderRules(accountId: string, orderedIds: string[]): Promise<void> {
    await Promise.all(orderedIds.map((id, position) =>
      dynamo.send(new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `ACCT#${accountId}`, sk: `RULE#${id}` },
        UpdateExpression: "SET #position = :position",
        ExpressionAttributeNames: { "#position": "position" },
        ExpressionAttributeValues: { ":position": position },
      })),
    ));
  }

  // ---------------------------------------------------------------------------
  // Domains
  // ---------------------------------------------------------------------------

  async listDomains(accountId: string): Promise<Domain[]> {
    const res = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `ACCT#${accountId}`, ":prefix": "DOMAIN#" },
    }));
    return (res.Items ?? []) as Domain[];
  }

  async getDomain(accountId: string, id: string): Promise<Domain | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `ACCT#${accountId}`, sk: `DOMAIN#${id}` },
    }));
    return result.Item ? (result.Item as Domain) : null;
  }

  async createDomain(accountId: string, domain: string): Promise<Domain> {
    const now = new Date().toISOString();
    const item: Domain = { id: randomUUID(), accountId, domain, createdAt: now };
    await dynamo.send(new PutCommand({
      TableName: TABLE,
      Item: { ...item, pk: `ACCT#${accountId}`, sk: `DOMAIN#${item.id}` },
    }));
    return item;
  }

  async deleteDomain(accountId: string, id: string): Promise<void> {
    await dynamo.send(new DeleteCommand({
      TableName: TABLE,
      Key: { pk: `ACCT#${accountId}`, sk: `DOMAIN#${id}` },
    }));
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  async searchArcs(accountId: string, query: string, params: PageParams): Promise<Page<Arc>> {
    const limit = Math.min(params.limit ?? 20, 100);
    const res = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `ACCT#${accountId}`, ":prefix": "ARC#" },
      ScanIndexForward: false,
      Limit: 500,
      ...(params.cursor ? { ExclusiveStartKey: decodeCursor(params.cursor) } : {}),
    }));

    const q = query.toLowerCase();
    const items = ((res.Items ?? []) as Arc[]).filter(
      (a) => a.summary.toLowerCase().includes(q) || a.workflow.toLowerCase().includes(q),
    );
    const page = items.slice(0, limit);
    const nextKey = items.length > limit && res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
    return { items: page, total: items.length, ...(nextKey ? { nextCursor: nextKey } : {}) };
  }

  // ---------------------------------------------------------------------------
  // Account
  // ---------------------------------------------------------------------------

  async getAccount(accountId: string): Promise<Account | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `ACCT#${accountId}`, sk: "ACCOUNT" },
    }));
    return result.Item ? (result.Item as Account) : null;
  }

  async updateAccount(accountId: string, update: Partial<Pick<Account, "name" | "deletionRetentionDays" | "notifications" | "filtering">>): Promise<void> {
    const now = new Date().toISOString();
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };
    const exprNames: Record<string, string> = {};

    if (update.name !== undefined) { setParts.push("#name = :name"); exprValues[":name"] = update.name; exprNames["#name"] = "name"; }
    if (update.deletionRetentionDays !== undefined) { setParts.push("deletionRetentionDays = :drd"); exprValues[":drd"] = update.deletionRetentionDays; }
    if (update.notifications !== undefined) { setParts.push("notifications = :notifications"); exprValues[":notifications"] = update.notifications; }
    if (update.filtering !== undefined) { setParts.push("filtering = :filtering"); exprValues[":filtering"] = update.filtering; }

    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `ACCT#${accountId}`, sk: "ACCOUNT" },
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ExpressionAttributeValues: exprValues,
      ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
    }));
  }

  // ---------------------------------------------------------------------------
  // Email address configs
  // ---------------------------------------------------------------------------

  async listEmailConfigs(accountId: string): Promise<EmailAddressConfig[]> {
    const res = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `ACCT#${accountId}`, ":prefix": "EMAILCFG#" },
    }));
    return (res.Items ?? []) as EmailAddressConfig[];
  }

  async getEmailConfig(accountId: string, address: string): Promise<EmailAddressConfig | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `ACCT#${accountId}`, sk: `EMAILCFG#${address}` },
    }));
    return result.Item ? (result.Item as EmailAddressConfig) : null;
  }

  async upsertEmailConfig(config: EmailAddressConfig): Promise<void> {
    await dynamo.send(new PutCommand({
      TableName: TABLE,
      Item: { ...config, pk: `ACCT#${config.accountId}`, sk: `EMAILCFG#${config.address}` },
    }));
  }

  async deleteEmailConfig(accountId: string, address: string): Promise<void> {
    await dynamo.send(new DeleteCommand({
      TableName: TABLE,
      Key: { pk: `ACCT#${accountId}`, sk: `EMAILCFG#${address}` },
    }));
  }

  // ---------------------------------------------------------------------------
  // Suppression helpers (used by SesNotifier)
  // ---------------------------------------------------------------------------

  async isAddressSuppressed(address: string): Promise<boolean> {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `SUPPRESS#${address}`, sk: "SUPPRESS" },
      ProjectionExpression: "address",
    }));
    return result.Item !== undefined;
  }

  async suppressAddress(entry: SuppressedAddress): Promise<void> {
    await dynamo.send(new PutCommand({
      TableName: TABLE,
      Item: { ...entry, pk: `SUPPRESS#${entry.address}`, sk: "SUPPRESS" },
    }));
  }
}
