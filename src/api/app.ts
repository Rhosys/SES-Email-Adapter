import { Hono } from "hono";
import { randomUUID } from "crypto";
import { getDomain } from "tldts";
import type { Arc, Signal, View, Label, Rule, Domain, Account, Page, PageParams, ArcStatus, Workflow, EmailAddressConfig, SenderFilterMode } from "../types/index.js";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthContext {
  accountId: string;
  userId: string;
}

export interface AuthService {
  verify(token: string): Promise<AuthContext>;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ListArcsParams extends PageParams {
  workflow?: Workflow;
  label?: string;
  status?: ArcStatus;
}

export interface UpdateArcRequest {
  status?: ArcStatus;
  labels?: string[];
}

export interface CreateViewRequest {
  name: string;
  workflow?: Workflow;
  labels?: string[];
  sortField?: View["sortField"];
  sortDirection?: View["sortDirection"];
  icon?: string;
  color?: string;
  position?: number;
}

export interface UpdateViewRequest {
  name?: string;
  workflow?: Workflow;
  labels?: string[];
  sortField?: View["sortField"];
  sortDirection?: View["sortDirection"];
  icon?: string;
  color?: string;
  position?: number;
}

export interface CreateLabelRequest {
  name: string;
  color?: string;
  icon?: string;
}

export interface UpdateLabelRequest {
  name?: string;
  color?: string;
  icon?: string;
}

export interface CreateRuleRequest {
  name: string;
  condition: string;
  actions: Rule["actions"];
  position?: number;
}

export interface UpdateRuleRequest {
  name?: string;
  condition?: string;
  actions?: Rule["actions"];
  position?: number;
}

export interface ApiDatabase {
  // Arcs
  listArcs(accountId: string, params: ListArcsParams): Promise<Page<Arc>>;
  getArc(accountId: string, id: string): Promise<Arc | null>;
  updateArc(accountId: string, id: string, update: UpdateArcRequest): Promise<void>;

  // Signals
  listSignals(accountId: string, arcId: string, params: PageParams): Promise<Page<Signal>>;
  getSignal(accountId: string, id: string): Promise<Signal | null>;

  // Views
  listViews(accountId: string): Promise<View[]>;
  getView(accountId: string, id: string): Promise<View | null>;
  createView(accountId: string, data: CreateViewRequest): Promise<View | void>;
  updateView(accountId: string, id: string, data: UpdateViewRequest): Promise<void>;
  deleteView(accountId: string, id: string): Promise<void>;
  reorderViews(accountId: string, orderedIds: string[]): Promise<void>;

  // Labels
  listLabels(accountId: string): Promise<Label[]>;
  createLabel(accountId: string, data: CreateLabelRequest): Promise<Label | void>;
  updateLabel(accountId: string, id: string, data: UpdateLabelRequest): Promise<void>;
  deleteLabel(accountId: string, id: string): Promise<void>;

  // Rules
  listRules(accountId: string): Promise<Rule[]>;
  createRule(accountId: string, data: CreateRuleRequest): Promise<Rule | void>;
  updateRule(accountId: string, id: string, data: UpdateRuleRequest): Promise<void>;
  deleteRule(accountId: string, id: string): Promise<void>;
  reorderRules(accountId: string, orderedIds: string[]): Promise<void>;

  // Domains
  listDomains(accountId: string): Promise<Domain[]>;
  getDomain(accountId: string, id: string): Promise<Domain | null>;
  createDomain(accountId: string, domain: string): Promise<Domain | void>;
  deleteDomain(accountId: string, id: string): Promise<void>;

  // Search
  searchArcs(accountId: string, query: string, params: PageParams): Promise<Page<Arc>>;

  // Account
  getAccount(accountId: string): Promise<Account | null>;
  updateAccount(accountId: string, update: Partial<Pick<Account, "name" | "deletionRetentionDays" | "notifications" | "filtering">>): Promise<void>;

  // Email address configs
  listEmailConfigs(accountId: string): Promise<EmailAddressConfig[]>;
  getEmailConfig(accountId: string, address: string): Promise<EmailAddressConfig | null>;
  upsertEmailConfig(config: EmailAddressConfig): Promise<void>;
  deleteEmailConfig(accountId: string, address: string): Promise<void>;

  // Signal unblocking
  unblockSignal(accountId: string, signalId: string, arcId: string): Promise<void>;
  createArc(arc: Arc): Promise<void>;
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

interface AppDeps {
  store: ApiDatabase;
  auth: AuthService;
}

type AppEnv = { Variables: { auth: AuthContext } };

export function createApp({ store, auth }: AppDeps) {
  const app = new Hono<AppEnv>();

  // Auth middleware
  app.use("*", async (c, next) => {
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) return c.json({ error: "Unauthorized" }, 401);
    try {
      const ctx = await auth.verify(header.slice(7));
      c.set("auth", ctx);
      await next();
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }
  });

  // -------------------------------------------------------------------------
  // Arcs
  // -------------------------------------------------------------------------

  app.get("/arcs", async (c) => {
    const { accountId } = c.get("auth");
    const query = c.req.query();
    const params: ListArcsParams = {
      ...(query["workflow"] ? { workflow: query["workflow"] as Workflow } : {}),
      ...(query["label"] ? { label: query["label"] } : {}),
      ...(query["status"] ? { status: query["status"] as ArcStatus } : {}),
      ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
      ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
    };
    return c.json(await store.listArcs(accountId, params));
  });

  app.get("/arcs/:id", async (c) => {
    const { accountId } = c.get("auth");
    const arc = await store.getArc(accountId, c.req.param("id"));
    if (!arc) return c.json({ error: "Not found" }, 404);
    if (arc.accountId !== accountId) return c.json({ error: "Forbidden" }, 403);
    return c.json(arc);
  });

  app.patch("/arcs/:id", async (c) => {
    const { accountId } = c.get("auth");
    const arc = await store.getArc(accountId, c.req.param("id"));
    if (!arc) return c.json({ error: "Not found" }, 404);
    if (arc.accountId !== accountId) return c.json({ error: "Forbidden" }, 403);
    const body = await c.req.json() as UpdateArcRequest;
    await store.updateArc(accountId, arc.id, body);
    return c.json({ ok: true });
  });

  app.post("/arcs", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as {
      signalId: string;
      approveSender?: boolean;
      updateFilterMode?: SenderFilterMode;
    };

    const signal = await store.getSignal(accountId, body.signalId);
    if (!signal) return c.json({ error: "Signal not found" }, 404);
    if (signal.status !== "blocked") return c.json({ error: "Signal is not blocked" }, 400);

    const now = new Date().toISOString();
    const arc: Arc = {
      id: randomUUID(),
      accountId,
      workflow: signal.workflow,
      labels: [],
      status: "active",
      summary: signal.summary,
      lastSignalAt: signal.receivedAt,
      createdAt: now,
      updatedAt: now,
    };

    await store.createArc(arc);
    await store.unblockSignal(accountId, signal.id, arc.id);

    if (body.approveSender || body.updateFilterMode) {
      const senderDomain = signal.from.address.includes("@")
        ? signal.from.address.split("@").pop()!
        : signal.from.address;
      const senderETLD1 = getDomain(senderDomain) ?? senderDomain;
      const existing = await store.getEmailConfig(accountId, signal.recipientAddress);

      const base = existing ?? {
        id: randomUUID(),
        accountId,
        address: signal.recipientAddress,
        filterMode: "notify_new" as SenderFilterMode,
        approvedSenders: [] as string[],
        createdAt: now,
        updatedAt: now,
      };

      await store.upsertEmailConfig({
        ...base,
        filterMode: body.updateFilterMode ?? base.filterMode,
        approvedSenders: body.approveSender && !base.approvedSenders.includes(senderETLD1)
          ? [...base.approvedSenders, senderETLD1]
          : base.approvedSenders,
        updatedAt: now,
      });
    }

    return c.json(arc, 201);
  });

  // -------------------------------------------------------------------------
  // Signals
  // -------------------------------------------------------------------------

  app.get("/arcs/:id/signals", async (c) => {
    const { accountId } = c.get("auth");
    const arc = await store.getArc(accountId, c.req.param("id"));
    if (!arc) return c.json({ error: "Not found" }, 404);
    if (arc.accountId !== accountId) return c.json({ error: "Forbidden" }, 403);
    const query = c.req.query();
    const params: PageParams = {
      ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
      ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
    };
    return c.json(await store.listSignals(accountId, arc.id, params));
  });

  app.get("/signals/:id", async (c) => {
    const { accountId } = c.get("auth");
    const signal = await store.getSignal(accountId, c.req.param("id"));
    if (!signal) return c.json({ error: "Not found" }, 404);
    if (signal.accountId !== accountId) return c.json({ error: "Forbidden" }, 403);
    return c.json(signal);
  });

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  app.get("/views", async (c) => {
    const { accountId } = c.get("auth");
    return c.json(await store.listViews(accountId));
  });

  app.post("/views", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as Partial<CreateViewRequest>;
    if (!body.name) return c.json({ error: "name is required" }, 400);
    if (body.workflow !== undefined && !VALID_WORKFLOWS.has(body.workflow)) {
      return c.json({ error: "Invalid workflow" }, 400);
    }
    const result = await store.createView(accountId, body as CreateViewRequest);
    return c.json(result ?? { ok: true }, 201);
  });

  app.post("/views/reorder", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as { orderedIds: string[] };
    await store.reorderViews(accountId, body.orderedIds);
    return c.json({ ok: true });
  });

  app.patch("/views/:id", async (c) => {
    const { accountId } = c.get("auth");
    const view = await store.getView(accountId, c.req.param("id"));
    if (!view) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json() as UpdateViewRequest;
    await store.updateView(accountId, view.id, body);
    return c.json({ ok: true });
  });

  app.delete("/views/:id", async (c) => {
    const { accountId } = c.get("auth");
    const view = await store.getView(accountId, c.req.param("id"));
    if (!view) return c.json({ error: "Not found" }, 404);
    await store.deleteView(accountId, view.id);
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Labels
  // -------------------------------------------------------------------------

  app.get("/labels", async (c) => {
    const { accountId } = c.get("auth");
    return c.json(await store.listLabels(accountId));
  });

  app.post("/labels", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as Partial<CreateLabelRequest>;
    if (!body.name) return c.json({ error: "name is required" }, 400);
    const result = await store.createLabel(accountId, body as CreateLabelRequest);
    return c.json(result ?? { ok: true }, 201);
  });

  app.patch("/labels/:id", async (c) => {
    const { accountId } = c.get("auth");
    const labels = await store.listLabels(accountId);
    const label = labels.find((l) => l.id === c.req.param("id"));
    if (!label) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json() as UpdateLabelRequest;
    await store.updateLabel(accountId, label.id, body);
    return c.json({ ok: true });
  });

  app.delete("/labels/:id", async (c) => {
    const { accountId } = c.get("auth");
    const labels = await store.listLabels(accountId);
    const label = labels.find((l) => l.id === c.req.param("id"));
    if (!label) return c.json({ error: "Not found" }, 404);
    await store.deleteLabel(accountId, label.id);
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------

  app.get("/rules", async (c) => {
    const { accountId } = c.get("auth");
    return c.json(await store.listRules(accountId));
  });

  app.post("/rules", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as Partial<CreateRuleRequest>;
    if (!body.name) return c.json({ error: "name is required" }, 400);
    if (!body.actions || body.actions.length === 0) return c.json({ error: "actions must not be empty" }, 400);
    const result = await store.createRule(accountId, body as CreateRuleRequest);
    return c.json(result ?? { ok: true }, 201);
  });

  app.post("/rules/reorder", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as { orderedIds: string[] };
    await store.reorderRules(accountId, body.orderedIds);
    return c.json({ ok: true });
  });

  app.patch("/rules/:id", async (c) => {
    const { accountId } = c.get("auth");
    const rules = await store.listRules(accountId);
    const rule = rules.find((r) => r.id === c.req.param("id"));
    if (!rule) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json() as UpdateRuleRequest;
    await store.updateRule(accountId, rule.id, body);
    return c.json({ ok: true });
  });

  app.delete("/rules/:id", async (c) => {
    const { accountId } = c.get("auth");
    const rules = await store.listRules(accountId);
    const rule = rules.find((r) => r.id === c.req.param("id"));
    if (!rule) return c.json({ error: "Not found" }, 404);
    await store.deleteRule(accountId, rule.id);
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Domains
  // -------------------------------------------------------------------------

  app.get("/domains", async (c) => {
    const { accountId } = c.get("auth");
    return c.json(await store.listDomains(accountId));
  });

  app.post("/domains", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as { domain?: string };
    if (!body.domain) return c.json({ error: "domain is required" }, 400);
    const result = await store.createDomain(accountId, body.domain);
    return c.json(result ?? { ok: true }, 201);
  });

  app.get("/domains/:id/dkim", async (c) => {
    const { accountId } = c.get("auth");
    const domain = await store.getDomain(accountId, c.req.param("id"));
    if (!domain) return c.json({ error: "Not found" }, 404);
    if (domain.accountId !== accountId) return c.json({ error: "Forbidden" }, 403);
    return c.json(buildDkimRecords(domain.domain));
  });

  app.delete("/domains/:id", async (c) => {
    const { accountId } = c.get("auth");
    const domain = await store.getDomain(accountId, c.req.param("id"));
    if (!domain) return c.json({ error: "Not found" }, 404);
    if (domain.accountId !== accountId) return c.json({ error: "Forbidden" }, 403);
    await store.deleteDomain(accountId, domain.id);
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Account
  // -------------------------------------------------------------------------

  app.get("/account", async (c) => {
    const { accountId } = c.get("auth");
    const account = await store.getAccount(accountId);
    if (!account) return c.json({ error: "Not found" }, 404);
    return c.json(account);
  });

  app.patch("/account", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as Partial<Pick<Account, "name" | "deletionRetentionDays" | "notifications" | "filtering">>;
    await store.updateAccount(accountId, body);
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Email address configs
  // -------------------------------------------------------------------------

  app.get("/email-configs", async (c) => {
    const { accountId } = c.get("auth");
    const configs = await store.listEmailConfigs(accountId);
    return c.json(configs);
  });

  app.get("/email-configs/:address", async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const config = await store.getEmailConfig(accountId, address);
    if (!config) return c.json({ error: "Not found" }, 404);
    return c.json(config);
  });

  app.put("/email-configs/:address", async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const body = await c.req.json() as { filterMode: SenderFilterMode; approvedSenders: string[] };
    const existing = await store.getEmailConfig(accountId, address);
    const now = new Date().toISOString();
    await store.upsertEmailConfig({
      id: existing?.id ?? randomUUID(),
      accountId,
      address,
      filterMode: body.filterMode,
      approvedSenders: body.approvedSenders,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return c.json({ ok: true });
  });

  app.delete("/email-configs/:address", async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    await store.deleteEmailConfig(accountId, address);
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  app.get("/search", async (c) => {
    const { accountId } = c.get("auth");
    const q = c.req.query("q");
    if (!q) return c.json({ error: "q is required" }, 400);
    const query = c.req.query();
    const params: PageParams = {
      ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
      ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
    };
    return c.json(await store.searchArcs(accountId, q, params));
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { WORKFLOWS } from "../types/index.js";
const VALID_WORKFLOWS = new Set<string>(WORKFLOWS);

const DKIM_SELECTOR = "email-signals";

function buildDkimRecords(domain: string): Array<{ type: string; name: string; value: string; ttl: number }> {
  return [
    {
      type: "CNAME",
      name: `${DKIM_SELECTOR}._domainkey.${domain}`,
      value: `${DKIM_SELECTOR}._domainkey.ses-email-adapter.example.com`,
      ttl: 300,
    },
    {
      type: "MX",
      name: domain,
      value: "10 inbound-smtp.us-east-1.amazonaws.com",
      ttl: 300,
    },
  ];
}
