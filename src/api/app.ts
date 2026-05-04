import { Hono } from "hono";
import { randomUUID } from "crypto";
import { getDomain } from "tldts";
import type { Arc, Signal, View, Label, Rule, Domain, DnsRecord, Account, Page, PageParams, ArcStatus, Workflow, Alias, SenderFilterMode, AccountFilteringConfig, VerifiedForwardingAddress, Pagination } from "../types/index.js";

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
// Access (Authress RBAC)
// ---------------------------------------------------------------------------

export type AccountRole = "owner" | "admin" | "member" | "viewer";

export interface AccountUser {
  userId: string;
  role: AccountRole;
}

export interface AccessService {
  listUsers(accountId: string): Promise<AccountUser[]>;
  addUser(accountId: string, userId: string, role: AccountRole): Promise<void>;
  updateUserRole(accountId: string, userId: string, role: AccountRole): Promise<void>;
  removeUser(accountId: string, userId: string): Promise<void>;
  checkAccess(userId: string, accountId: string, permission: string): Promise<void>;
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
  updateArc(accountId: string, id: string, update: UpdateArcRequest): Promise<Arc>;

  // Signals
  listSignals(accountId: string, arcId: string, params: PageParams): Promise<Page<Signal>>;
  getSignal(accountId: string, id: string): Promise<Signal | null>;
  updateSignal(accountId: string, id: string, update: Partial<Pick<Signal, "subject" | "textBody" | "from" | "to">>): Promise<Signal>;
  deleteSignal(accountId: string, id: string): Promise<void>;

  // Views
  listViews(accountId: string): Promise<View[]>;
  getView(accountId: string, id: string): Promise<View | null>;
  createView(accountId: string, data: CreateViewRequest): Promise<View>;
  updateView(accountId: string, id: string, data: UpdateViewRequest): Promise<View>;
  deleteView(accountId: string, id: string): Promise<void>;
  reorderViews(accountId: string, orderedIds: string[]): Promise<void>;

  // Labels
  listLabels(accountId: string): Promise<Label[]>;
  createLabel(accountId: string, data: CreateLabelRequest): Promise<Label>;
  updateLabel(accountId: string, id: string, data: UpdateLabelRequest): Promise<Label>;
  deleteLabel(accountId: string, id: string): Promise<void>;

  // Rules
  listRules(accountId: string): Promise<Rule[]>;
  createRule(accountId: string, data: CreateRuleRequest): Promise<Rule>;
  updateRule(accountId: string, id: string, data: UpdateRuleRequest): Promise<Rule>;
  deleteRule(accountId: string, id: string): Promise<void>;
  reorderRules(accountId: string, orderedIds: string[]): Promise<void>;

  // Domains
  listDomains(accountId: string): Promise<Domain[]>;
  getDomain(accountId: string, id: string): Promise<Domain | null>;
  createDomain(accountId: string, domain: string): Promise<Domain>;
  deleteDomain(accountId: string, id: string): Promise<void>;

  // Search
  searchArcs(accountId: string, query: string, params: PageParams): Promise<Page<Arc>>;

  // Account
  getAccount(accountId: string): Promise<Account | null>;
  updateAccount(accountId: string, update: Partial<Pick<Account, "name" | "deletionRetentionDays" | "notifications" | "filtering">>): Promise<Account>;

  // Aliases
  listAliases(accountId: string): Promise<Alias[]>;
  getAlias(accountId: string, address: string): Promise<Alias | null>;
  createAlias(alias: Alias): Promise<Alias>;
  upsertAlias(alias: Alias): Promise<Alias>;
  deleteAlias(accountId: string, address: string): Promise<void>;

  // Signal unblocking
  unblockSignal(accountId: string, signalId: string, arcId: string): Promise<void>;
  createArc(arc: Arc): Promise<void>;

  // Verified forwarding addresses
  listVerifiedForwardingAddresses(accountId: string): Promise<VerifiedForwardingAddress[]>;
  getVerifiedForwardingAddress(accountId: string, address: string): Promise<VerifiedForwardingAddress | null>;
  saveVerifiedForwardingAddress(addr: VerifiedForwardingAddress): Promise<void>;
  deleteVerifiedForwardingAddress(accountId: string, address: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Verification mailer
// ---------------------------------------------------------------------------

export interface VerificationMailer {
  sendForwardVerification(accountId: string, address: string, token: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

interface AppDeps {
  store: ApiDatabase;
  auth: AuthService;
  access?: AccessService;
  verificationMailer?: VerificationMailer;
}

type AppEnv = { Variables: { auth: AuthContext } };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiError(c: Parameters<typeof Hono.prototype.get>[1] extends infer H ? never : never, status: number, title: string, errorCode?: string, details?: unknown): Response {
  return Response.json(
    { title, ...(errorCode ? { errorCode } : {}), ...(details !== undefined ? { details } : {}) },
    { status },
  );
}

function page<K extends string, T>(key: K, items: T[], nextCursor?: string): Record<K, T[]> & { pagination: Pagination } {
  return { [key]: items, pagination: { cursor: nextCursor ?? null } } as Record<K, T[]> & { pagination: Pagination };
}

export function createApp({ store, auth, access, verificationMailer }: AppDeps) {
  const app = new Hono<AppEnv>();

  function err(c: Parameters<ReturnType<typeof app.get>>[0], status: number, title: string, errorCode?: string, details?: unknown) {
    return c.json(
      { title, ...(errorCode ? { errorCode } : {}), ...(details !== undefined ? { details } : {}) },
      status as 400 | 401 | 403 | 404 | 409 | 501,
    );
  }

  // JWT verification
  app.use("*", async (c, next) => {
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) return err(c, 401, "Unauthorized");

    let ctx: AuthContext;
    try {
      ctx = await auth.verify(header.slice(7));
    } catch {
      return err(c, 401, "Unauthorized");
    }

    // For /accounts/:accountId routes, extract accountId from URL and verify access
    const accountMatch = /^\/accounts\/([^/]+)/.exec(c.req.path);
    if (accountMatch) {
      const accountId = accountMatch[1]!;
      if (access) {
        try {
          await access.checkAccess(ctx.userId, accountId, "account:read");
        } catch {
          return err(c, 403, "Forbidden");
        }
      }
      c.set("auth", { accountId, userId: ctx.userId });
    } else {
      c.set("auth", ctx);
    }

    await next();
  });

  // -------------------------------------------------------------------------
  // Arcs  —  /accounts/:accountId/arcs
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/arcs", async (c) => {
    const { accountId } = c.get("auth");
    const query = c.req.query();
    const params: ListArcsParams = {
      ...(query["workflow"] ? { workflow: query["workflow"] as Workflow } : {}),
      ...(query["label"] ? { label: query["label"] } : {}),
      ...(query["status"] ? { status: query["status"] as ArcStatus } : {}),
      ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
      ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
    };
    const result = await store.listArcs(accountId, params);
    return c.json(page("arcs", result.items, result.nextCursor));
  });

  app.get("/accounts/:accountId/arcs/:id", async (c) => {
    const { accountId } = c.get("auth");
    const arc = await store.getArc(accountId, c.req.param("id"));
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    if (arc.accountId !== accountId) return err(c, 403, "Forbidden");
    return c.json(arc);
  });

  app.patch("/accounts/:accountId/arcs/:id", async (c) => {
    const { accountId } = c.get("auth");
    const arc = await store.getArc(accountId, c.req.param("id"));
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    if (arc.accountId !== accountId) return err(c, 403, "Forbidden");
    const body = await c.req.json() as UpdateArcRequest;
    const updated = await store.updateArc(accountId, arc.id, body);
    return c.json(updated);
  });

  app.post("/accounts/:accountId/arcs", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as {
      signalId: string;
      approveSender?: boolean;
      updateFilterMode?: SenderFilterMode;
    };

    const signal = await store.getSignal(accountId, body.signalId);
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.status !== "blocked" && signal.status !== "quarantined") {
      return err(c, 400, "Signal is not blocked or quarantined", "SIGNAL_NOT_BLOCKED");
    }

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
      const existing = await store.getAlias(accountId, signal.recipientAddress);

      const base = existing ?? {
        id: randomUUID(),
        accountId,
        address: signal.recipientAddress,
        filterMode: "notify_new" as SenderFilterMode,
        approvedSenders: [] as string[],
        createdAt: now,
        updatedAt: now,
      };

      await store.upsertAlias({
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
  // Signals  —  /accounts/:accountId/arcs/:arcId/signals  &  /signals/:id
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/arcs/:arcId/signals", async (c) => {
    const { accountId } = c.get("auth");
    const arc = await store.getArc(accountId, c.req.param("arcId"));
    if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
    if (arc.accountId !== accountId) return err(c, 403, "Forbidden");
    const query = c.req.query();
    const params: PageParams = {
      ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
      ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
    };
    const result = await store.listSignals(accountId, arc.id, params);
    return c.json(page("signals", result.items, result.nextCursor));
  });

  app.get("/accounts/:accountId/signals/:id", async (c) => {
    const { accountId } = c.get("auth");
    const signal = await store.getSignal(accountId, c.req.param("id"));
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.accountId !== accountId) return err(c, 403, "Forbidden");
    return c.json(signal);
  });

  app.patch("/accounts/:accountId/signals/:id", async (c) => {
    const { accountId } = c.get("auth");
    const signal = await store.getSignal(accountId, c.req.param("id"));
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.accountId !== accountId) return err(c, 403, "Forbidden");
    if (signal.status !== "draft") return err(c, 400, "Only draft signals can be updated", "SIGNAL_NOT_DRAFT");
    const body = await c.req.json() as Partial<Pick<Signal, "subject" | "textBody" | "from" | "to">>;
    const updated = await store.updateSignal(accountId, signal.id, body);
    return c.json(updated);
  });

  app.post("/accounts/:accountId/signals/:id/send", async (c) => {
    const { accountId } = c.get("auth");
    const signal = await store.getSignal(accountId, c.req.param("id"));
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.accountId !== accountId) return err(c, 403, "Forbidden");
    if (signal.status !== "draft") return err(c, 400, "Only draft signals can be sent", "SIGNAL_NOT_DRAFT");
    // Flip to active — the actual SES send is wired at the handler layer outside the API
    const sent = await store.updateSignal(accountId, signal.id, {});
    return c.json(sent);
  });

  app.delete("/accounts/:accountId/signals/:id", async (c) => {
    const { accountId } = c.get("auth");
    const signal = await store.getSignal(accountId, c.req.param("id"));
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.accountId !== accountId) return err(c, 403, "Forbidden");
    if (signal.status !== "draft") return err(c, 400, "Only draft signals can be deleted", "SIGNAL_NOT_DRAFT");
    await store.deleteSignal(accountId, signal.id);
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Views  —  /accounts/:accountId/views
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/views", async (c) => {
    const { accountId } = c.get("auth");
    const views = await store.listViews(accountId);
    return c.json(page("views", views));
  });

  app.post("/accounts/:accountId/views/reorder", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as { orderedIds: string[] };
    await store.reorderViews(accountId, body.orderedIds);
    return c.json({ ok: true });
  });

  app.post("/accounts/:accountId/views", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as Partial<CreateViewRequest>;
    if (!body.name) return err(c, 400, "name is required", "MISSING_FIELD", { field: "name" });
    if (body.workflow !== undefined && !VALID_WORKFLOWS.has(body.workflow)) {
      return err(c, 400, "Invalid workflow", "INVALID_WORKFLOW", { workflow: body.workflow });
    }
    const view = await store.createView(accountId, body as CreateViewRequest);
    return c.json(view, 201);
  });

  app.patch("/accounts/:accountId/views/:id", async (c) => {
    const { accountId } = c.get("auth");
    const view = await store.getView(accountId, c.req.param("id"));
    if (!view) return err(c, 404, "View not found", "VIEW_NOT_FOUND");
    const body = await c.req.json() as UpdateViewRequest;
    const updated = await store.updateView(accountId, view.id, body);
    return c.json(updated);
  });

  app.delete("/accounts/:accountId/views/:id", async (c) => {
    const { accountId } = c.get("auth");
    const view = await store.getView(accountId, c.req.param("id"));
    if (!view) return err(c, 404, "View not found", "VIEW_NOT_FOUND");
    await store.deleteView(accountId, view.id);
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Labels  —  /accounts/:accountId/labels
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/labels", async (c) => {
    const { accountId } = c.get("auth");
    const labels = await store.listLabels(accountId);
    return c.json(page("labels", labels));
  });

  app.post("/accounts/:accountId/labels", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as Partial<CreateLabelRequest>;
    if (!body.name) return err(c, 400, "name is required", "MISSING_FIELD", { field: "name" });
    const label = await store.createLabel(accountId, body as CreateLabelRequest);
    return c.json(label, 201);
  });

  app.patch("/accounts/:accountId/labels/:id", async (c) => {
    const { accountId } = c.get("auth");
    const labels = await store.listLabels(accountId);
    const label = labels.find((l) => l.id === c.req.param("id"));
    if (!label) return err(c, 404, "Label not found", "LABEL_NOT_FOUND");
    const body = await c.req.json() as UpdateLabelRequest;
    const updated = await store.updateLabel(accountId, label.id, body);
    return c.json(updated);
  });

  app.delete("/accounts/:accountId/labels/:id", async (c) => {
    const { accountId } = c.get("auth");
    const labels = await store.listLabels(accountId);
    const label = labels.find((l) => l.id === c.req.param("id"));
    if (!label) return err(c, 404, "Label not found", "LABEL_NOT_FOUND");
    await store.deleteLabel(accountId, label.id);
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Rules  —  /accounts/:accountId/rules
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/rules", async (c) => {
    const { accountId } = c.get("auth");
    const rules = await store.listRules(accountId);
    return c.json(page("rules", rules));
  });

  app.post("/accounts/:accountId/rules/reorder", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as { orderedIds: string[] };
    await store.reorderRules(accountId, body.orderedIds);
    return c.json({ ok: true });
  });

  app.post("/accounts/:accountId/rules", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as Partial<CreateRuleRequest>;
    if (!body.name) return err(c, 400, "name is required", "MISSING_FIELD", { field: "name" });
    if (!body.actions || body.actions.length === 0) {
      return err(c, 400, "actions must not be empty", "MISSING_FIELD", { field: "actions" });
    }
    const forwardError = await validateForwardTargets(accountId, body.actions, store);
    if (forwardError) return err(c, 400, forwardError, "UNVERIFIED_FORWARD_TARGET");
    const rule = await store.createRule(accountId, body as CreateRuleRequest);
    return c.json(rule, 201);
  });

  app.patch("/accounts/:accountId/rules/:id", async (c) => {
    const { accountId } = c.get("auth");
    const rules = await store.listRules(accountId);
    const rule = rules.find((r) => r.id === c.req.param("id"));
    if (!rule) return err(c, 404, "Rule not found", "RULE_NOT_FOUND");
    const body = await c.req.json() as UpdateRuleRequest;
    if (body.actions) {
      const forwardError = await validateForwardTargets(accountId, body.actions, store);
      if (forwardError) return err(c, 400, forwardError, "UNVERIFIED_FORWARD_TARGET");
    }
    const updated = await store.updateRule(accountId, rule.id, body);
    return c.json(updated);
  });

  app.delete("/accounts/:accountId/rules/:id", async (c) => {
    const { accountId } = c.get("auth");
    const rules = await store.listRules(accountId);
    const rule = rules.find((r) => r.id === c.req.param("id"));
    if (!rule) return err(c, 404, "Rule not found", "RULE_NOT_FOUND");
    await store.deleteRule(accountId, rule.id);
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Domains  —  /accounts/:accountId/domains
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/domains", async (c) => {
    const { accountId } = c.get("auth");
    const domains = await store.listDomains(accountId);
    return c.json(page("domains", domains));
  });

  app.post("/accounts/:accountId/domains", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as { domain?: string };
    if (!body.domain) return err(c, 400, "domain is required", "MISSING_FIELD", { field: "domain" });
    const domain = await store.createDomain(accountId, body.domain);
    return c.json(domain, 201);
  });

  app.get("/accounts/:accountId/domains/:id/records", async (c) => {
    const { accountId } = c.get("auth");
    const domain = await store.getDomain(accountId, c.req.param("id"));
    if (!domain) return err(c, 404, "Domain not found", "DOMAIN_NOT_FOUND");
    if (domain.accountId !== accountId) return err(c, 403, "Forbidden");
    return c.json(buildDnsRecords(domain));
  });

  app.delete("/accounts/:accountId/domains/:id", async (c) => {
    const { accountId } = c.get("auth");
    const domain = await store.getDomain(accountId, c.req.param("id"));
    if (!domain) return err(c, 404, "Domain not found", "DOMAIN_NOT_FOUND");
    if (domain.accountId !== accountId) return err(c, 403, "Forbidden");
    await store.deleteDomain(accountId, domain.id);
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Account  —  /accounts/:accountId
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId", async (c) => {
    const { accountId } = c.get("auth");
    const account = await store.getAccount(accountId);
    if (!account) return err(c, 404, "Account not found", "ACCOUNT_NOT_FOUND");
    return c.json(account);
  });

  app.patch("/accounts/:accountId", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as Partial<Pick<Account, "name" | "deletionRetentionDays" | "notifications" | "filtering">>;
    const updated = await store.updateAccount(accountId, body);
    return c.json(updated);
  });

  // -------------------------------------------------------------------------
  // Account users  —  /accounts/:accountId/users
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/users", async (c) => {
    if (!access) return err(c, 501, "Not implemented");
    const { accountId } = c.get("auth");
    const users = await access.listUsers(accountId);
    return c.json(page("users", users));
  });

  app.post("/accounts/:accountId/users", async (c) => {
    if (!access) return err(c, 501, "Not implemented");
    const { accountId } = c.get("auth");
    const body = await c.req.json() as { userId?: string; role?: string };
    if (!body.userId) return err(c, 400, "userId is required", "MISSING_FIELD", { field: "userId" });
    if (!body.role || !VALID_ROLES.has(body.role as AccountRole)) {
      return err(c, 400, "Invalid role", "INVALID_ROLE", { role: body.role });
    }
    await access.addUser(accountId, body.userId, body.role as AccountRole);
    return c.json({ userId: body.userId, role: body.role }, 201);
  });

  app.patch("/accounts/:accountId/users/:userId", async (c) => {
    if (!access) return err(c, 501, "Not implemented");
    const { accountId } = c.get("auth");
    const body = await c.req.json() as { role?: string };
    if (!body.role || !VALID_ROLES.has(body.role as AccountRole)) {
      return err(c, 400, "Invalid role", "INVALID_ROLE", { role: body.role });
    }
    await access.updateUserRole(accountId, c.req.param("userId"), body.role as AccountRole);
    return c.json({ userId: c.req.param("userId"), role: body.role });
  });

  app.delete("/accounts/:accountId/users/:userId", async (c) => {
    if (!access) return err(c, 501, "Not implemented");
    const { accountId } = c.get("auth");
    await access.removeUser(accountId, c.req.param("userId"));
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Aliases  —  /accounts/:accountId/aliases
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/aliases", async (c) => {
    const { accountId } = c.get("auth");
    const aliases = await store.listAliases(accountId);
    return c.json(page("aliases", aliases));
  });

  app.get("/accounts/:accountId/aliases/:address", async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const alias = await store.getAlias(accountId, address);
    if (!alias) return err(c, 404, "Alias not found", "ALIAS_NOT_FOUND");
    return c.json(alias);
  });

  app.post("/accounts/:accountId/aliases", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as {
      address: string;
      filterMode?: SenderFilterMode;
      createdForOrigin?: string;
    };
    if (!body.address) return err(c, 400, "address is required", "MISSING_FIELD", { field: "address" });
    const existing = await store.getAlias(accountId, body.address);
    if (existing) return err(c, 409, "Alias already exists", "ALIAS_EXISTS");
    const now = new Date().toISOString();
    const alias = await store.createAlias({
      id: randomUUID(),
      accountId,
      address: body.address,
      filterMode: body.filterMode ?? "notify_new",
      approvedSenders: [],
      ...(body.createdForOrigin !== undefined ? { createdForOrigin: body.createdForOrigin } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return c.json(alias, 201);
  });

  app.patch("/accounts/:accountId/aliases/:address", async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const body = await c.req.json() as {
      filterMode?: SenderFilterMode;
      approvedSenders?: string[];
      onboardingEmailHandling?: Alias["onboardingEmailHandling"];
      spamScoreThreshold?: number;
      createdForOrigin?: string;
    };
    const existing = await store.getAlias(accountId, address);
    const now = new Date().toISOString();
    const updated = await store.upsertAlias({
      id: existing?.id ?? randomUUID(),
      accountId,
      address,
      filterMode: body.filterMode ?? existing?.filterMode ?? "notify_new",
      approvedSenders: body.approvedSenders ?? existing?.approvedSenders ?? [],
      ...(body.onboardingEmailHandling !== undefined ? { onboardingEmailHandling: body.onboardingEmailHandling } : existing?.onboardingEmailHandling !== undefined ? { onboardingEmailHandling: existing.onboardingEmailHandling } : {}),
      ...(body.spamScoreThreshold !== undefined ? { spamScoreThreshold: body.spamScoreThreshold } : existing?.spamScoreThreshold !== undefined ? { spamScoreThreshold: existing.spamScoreThreshold } : {}),
      ...(body.createdForOrigin !== undefined ? { createdForOrigin: body.createdForOrigin } : existing?.createdForOrigin !== undefined ? { createdForOrigin: existing.createdForOrigin } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return c.json(updated);
  });

  app.delete("/accounts/:accountId/aliases/:address", async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    await store.deleteAlias(accountId, address);
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Verified forwarding addresses  —  /accounts/:accountId/forwarding-addresses
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/forwarding-addresses", async (c) => {
    const { accountId } = c.get("auth");
    const addresses = await store.listVerifiedForwardingAddresses(accountId);
    return c.json(page("forwardingAddresses", addresses));
  });

  app.post("/accounts/:accountId/forwarding-addresses", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as { address?: string };
    if (!body.address) return err(c, 400, "address is required", "MISSING_FIELD", { field: "address" });

    const existing = await store.getVerifiedForwardingAddress(accountId, body.address);
    if (existing?.status === "verified") return c.json(existing, 200);

    const now = new Date().toISOString();
    const addr: VerifiedForwardingAddress = {
      id: existing?.id ?? randomUUID(),
      accountId,
      address: body.address,
      status: "pending",
      token: randomUUID(),
      createdAt: existing?.createdAt ?? now,
      ...(existing?.verifiedAt !== undefined ? { verifiedAt: existing.verifiedAt } : {}),
    };
    await store.saveVerifiedForwardingAddress(addr);

    if (verificationMailer) {
      await verificationMailer.sendForwardVerification(accountId, addr.address, addr.token).catch((e) => {
        console.error("Failed to send verification email:", e);
      });
    }

    return c.json(addr, 201);
  });

  app.post("/accounts/:accountId/forwarding-addresses/:address/verify", async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const body = await c.req.json() as { token?: string };
    if (!body.token) return err(c, 400, "token is required", "MISSING_FIELD", { field: "token" });

    const existing = await store.getVerifiedForwardingAddress(accountId, address);
    if (!existing) return err(c, 404, "Forwarding address not found", "FORWARDING_ADDRESS_NOT_FOUND");
    if (existing.status === "verified") return c.json(existing);
    if (existing.token !== body.token) return err(c, 400, "Invalid token", "INVALID_TOKEN");

    const verified: VerifiedForwardingAddress = { ...existing, status: "verified", verifiedAt: new Date().toISOString() };
    await store.saveVerifiedForwardingAddress(verified);
    return c.json(verified);
  });

  app.delete("/accounts/:accountId/forwarding-addresses/:address", async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    await store.deleteVerifiedForwardingAddress(accountId, address);
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Search  —  /accounts/:accountId/search
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/search", async (c) => {
    const { accountId } = c.get("auth");
    const q = c.req.query("q");
    if (!q) return err(c, 400, "q is required", "MISSING_FIELD", { field: "q" });
    const query = c.req.query();
    const params: PageParams = {
      ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
      ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
    };
    const result = await store.searchArcs(accountId, q, params);
    return c.json(page("arcs", result.items, result.nextCursor));
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { WORKFLOWS } from "../types/index.js";
const VALID_WORKFLOWS = new Set<string>(WORKFLOWS);
const VALID_ROLES = new Set<AccountRole>(["owner", "admin", "member", "viewer"]);

// Validate that all forward targets in a rule's actions are verified for this account.
// Returns an error string if invalid, null if OK.
async function validateForwardTargets(
  accountId: string,
  actions: Rule["actions"],
  store: Pick<ApiDatabase, "listVerifiedForwardingAddresses">,
): Promise<string | null> {
  const forwardTargets = actions.filter((a) => a.type === "forward" && a.value).map((a) => a.value!);
  if (forwardTargets.length === 0) return null;
  const verified = await store.listVerifiedForwardingAddresses(accountId);
  const verifiedSet = new Set(verified.filter((v) => v.status === "verified").map((v) => v.address));
  const unverified = forwardTargets.filter((t) => !verifiedSet.has(t));
  return unverified.length > 0 ? `Forward targets not verified: ${unverified.join(", ")}` : null;
}

const DKIM_SELECTOR = "mail";
const MAIL_DOMAIN = process.env["MAIL_DOMAIN"] ?? "mail.ses-email-adapter.example.com";
const SES_INBOUND_ENDPOINT = process.env["SES_INBOUND_ENDPOINT"] ?? "inbound-smtp.eu-west-1.amazonaws.com";

// Always returns all 4 DNS records for a domain regardless of setup tier.
// The status field on each record reflects the last health check result.
function buildDnsRecords(domain: Domain): DnsRecord[] {
  const d = domain.domain;
  const failing = new Set(domain.failingRecords ?? []);
  const checked = domain.lastCheckedAt !== undefined;

  function recordStatus(name: string): DnsRecord["status"] {
    if (!checked) return "pending";
    return failing.has(name) ? "failing" : "verified";
  }

  const mxName = d;
  const dkimName = `${DKIM_SELECTOR}._domainkey.${d}`;
  const spfName = `bounce.${d}`;
  const dmarcName = `_dmarc.${d}`;

  return [
    {
      name: mxName,
      type: "MX",
      value: `10 ${SES_INBOUND_ENDPOINT}`,
      status: recordStatus(mxName),
    },
    {
      name: dkimName,
      type: "CNAME",
      value: `${DKIM_SELECTOR}.${MAIL_DOMAIN}._domainkey.amazonses.com`,
      status: recordStatus(dkimName),
    },
    {
      name: spfName,
      type: "TXT",
      value: `v=spf1 include:amazonses.com ~all`,
      status: recordStatus(spfName),
    },
    {
      name: dmarcName,
      type: "CNAME",
      value: `_dmarc.${MAIL_DOMAIN}`,
      status: recordStatus(dmarcName),
    },
  ];
}
