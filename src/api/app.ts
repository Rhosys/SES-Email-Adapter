import { Hono } from "hono";
import { randomUUID } from "crypto";
import { getDomain } from "tldts";
import type { Arc, Signal, View, Label, Rule, Domain, DnsRecord, Account, Page, PageParams, ArcStatus, Workflow, EmailAddressConfig, SenderFilterMode, AccountFilteringConfig, VerifiedForwardingAddress } from "../types/index.js";

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

export function createApp({ store, auth, access, verificationMailer }: AppDeps) {
  const app = new Hono<AppEnv>();

  // JWT verification
  app.use("*", async (c, next) => {
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) return c.json({ error: "Unauthorized" }, 401);

    let ctx: AuthContext;
    try {
      ctx = await auth.verify(header.slice(7));
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // For /accounts/:accountId routes, extract accountId from URL and verify access
    const accountMatch = /^\/accounts\/([^/]+)/.exec(c.req.path);
    if (accountMatch) {
      const accountId = accountMatch[1]!;
      if (access) {
        try {
          await access.checkAccess(ctx.userId, accountId, "account:read");
        } catch {
          return c.json({ error: "Forbidden" }, 403);
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
    return c.json(await store.listArcs(accountId, params));
  });

  app.get("/accounts/:accountId/arcs/:id", async (c) => {
    const { accountId } = c.get("auth");
    const arc = await store.getArc(accountId, c.req.param("id"));
    if (!arc) return c.json({ error: "Not found" }, 404);
    if (arc.accountId !== accountId) return c.json({ error: "Forbidden" }, 403);
    return c.json(arc);
  });

  app.patch("/accounts/:accountId/arcs/:id", async (c) => {
    const { accountId } = c.get("auth");
    const arc = await store.getArc(accountId, c.req.param("id"));
    if (!arc) return c.json({ error: "Not found" }, 404);
    if (arc.accountId !== accountId) return c.json({ error: "Forbidden" }, 403);
    const body = await c.req.json() as UpdateArcRequest;
    await store.updateArc(accountId, arc.id, body);
    return c.json({ ok: true });
  });

  app.post("/accounts/:accountId/arcs", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as {
      signalId: string;
      approveSender?: boolean;
      updateFilterMode?: SenderFilterMode;
    };

    const signal = await store.getSignal(accountId, body.signalId);
    if (!signal) return c.json({ error: "Signal not found" }, 404);
    if (signal.status !== "blocked" && signal.status !== "quarantined") return c.json({ error: "Signal is not blocked or quarantined" }, 400);

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
  // Signals  —  /accounts/:accountId/arcs/:arcId/signals  &  /signals/:id
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/arcs/:arcId/signals", async (c) => {
    const { accountId } = c.get("auth");
    const arc = await store.getArc(accountId, c.req.param("arcId"));
    if (!arc) return c.json({ error: "Not found" }, 404);
    if (arc.accountId !== accountId) return c.json({ error: "Forbidden" }, 403);
    const query = c.req.query();
    const params: PageParams = {
      ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
      ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
    };
    return c.json(await store.listSignals(accountId, arc.id, params));
  });

  app.get("/accounts/:accountId/signals/:id", async (c) => {
    const { accountId } = c.get("auth");
    const signal = await store.getSignal(accountId, c.req.param("id"));
    if (!signal) return c.json({ error: "Not found" }, 404);
    if (signal.accountId !== accountId) return c.json({ error: "Forbidden" }, 403);
    return c.json(signal);
  });

  // -------------------------------------------------------------------------
  // Views  —  /accounts/:accountId/views
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/views", async (c) => {
    const { accountId } = c.get("auth");
    return c.json(await store.listViews(accountId));
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
    if (!body.name) return c.json({ error: "name is required" }, 400);
    if (body.workflow !== undefined && !VALID_WORKFLOWS.has(body.workflow)) {
      return c.json({ error: "Invalid workflow" }, 400);
    }
    const result = await store.createView(accountId, body as CreateViewRequest);
    return c.json(result ?? { ok: true }, 201);
  });

  app.patch("/accounts/:accountId/views/:id", async (c) => {
    const { accountId } = c.get("auth");
    const view = await store.getView(accountId, c.req.param("id"));
    if (!view) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json() as UpdateViewRequest;
    await store.updateView(accountId, view.id, body);
    return c.json({ ok: true });
  });

  app.delete("/accounts/:accountId/views/:id", async (c) => {
    const { accountId } = c.get("auth");
    const view = await store.getView(accountId, c.req.param("id"));
    if (!view) return c.json({ error: "Not found" }, 404);
    await store.deleteView(accountId, view.id);
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Labels  —  /accounts/:accountId/labels
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/labels", async (c) => {
    const { accountId } = c.get("auth");
    return c.json(await store.listLabels(accountId));
  });

  app.post("/accounts/:accountId/labels", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as Partial<CreateLabelRequest>;
    if (!body.name) return c.json({ error: "name is required" }, 400);
    const result = await store.createLabel(accountId, body as CreateLabelRequest);
    return c.json(result ?? { ok: true }, 201);
  });

  app.patch("/accounts/:accountId/labels/:id", async (c) => {
    const { accountId } = c.get("auth");
    const labels = await store.listLabels(accountId);
    const label = labels.find((l) => l.id === c.req.param("id"));
    if (!label) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json() as UpdateLabelRequest;
    await store.updateLabel(accountId, label.id, body);
    return c.json({ ok: true });
  });

  app.delete("/accounts/:accountId/labels/:id", async (c) => {
    const { accountId } = c.get("auth");
    const labels = await store.listLabels(accountId);
    const label = labels.find((l) => l.id === c.req.param("id"));
    if (!label) return c.json({ error: "Not found" }, 404);
    await store.deleteLabel(accountId, label.id);
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Rules  —  /accounts/:accountId/rules
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/rules", async (c) => {
    const { accountId } = c.get("auth");
    return c.json(await store.listRules(accountId));
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
    if (!body.name) return c.json({ error: "name is required" }, 400);
    if (!body.actions || body.actions.length === 0) return c.json({ error: "actions must not be empty" }, 400);
    const forwardError = await validateForwardTargets(accountId, body.actions, store);
    if (forwardError) return c.json({ error: forwardError }, 400);
    const result = await store.createRule(accountId, body as CreateRuleRequest);
    return c.json(result ?? { ok: true }, 201);
  });

  app.patch("/accounts/:accountId/rules/:id", async (c) => {
    const { accountId } = c.get("auth");
    const rules = await store.listRules(accountId);
    const rule = rules.find((r) => r.id === c.req.param("id"));
    if (!rule) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json() as UpdateRuleRequest;
    if (body.actions) {
      const forwardError = await validateForwardTargets(accountId, body.actions, store);
      if (forwardError) return c.json({ error: forwardError }, 400);
    }
    await store.updateRule(accountId, rule.id, body);
    return c.json({ ok: true });
  });

  app.delete("/accounts/:accountId/rules/:id", async (c) => {
    const { accountId } = c.get("auth");
    const rules = await store.listRules(accountId);
    const rule = rules.find((r) => r.id === c.req.param("id"));
    if (!rule) return c.json({ error: "Not found" }, 404);
    await store.deleteRule(accountId, rule.id);
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Domains  —  /accounts/:accountId/domains
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/domains", async (c) => {
    const { accountId } = c.get("auth");
    return c.json(await store.listDomains(accountId));
  });

  app.post("/accounts/:accountId/domains", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as { domain?: string };
    if (!body.domain) return c.json({ error: "domain is required" }, 400);
    const result = await store.createDomain(accountId, body.domain);
    return c.json(result ?? { ok: true }, 201);
  });

  app.get("/accounts/:accountId/domains/:id/records", async (c) => {
    const { accountId } = c.get("auth");
    const domain = await store.getDomain(accountId, c.req.param("id"));
    if (!domain) return c.json({ error: "Not found" }, 404);
    if (domain.accountId !== accountId) return c.json({ error: "Forbidden" }, 403);
    return c.json(buildDnsRecords(domain));
  });

  app.delete("/accounts/:accountId/domains/:id", async (c) => {
    const { accountId } = c.get("auth");
    const domain = await store.getDomain(accountId, c.req.param("id"));
    if (!domain) return c.json({ error: "Not found" }, 404);
    if (domain.accountId !== accountId) return c.json({ error: "Forbidden" }, 403);
    await store.deleteDomain(accountId, domain.id);
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Account  —  /accounts/:accountId
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId", async (c) => {
    const { accountId } = c.get("auth");
    const account = await store.getAccount(accountId);
    if (!account) return c.json({ error: "Not found" }, 404);
    return c.json(account);
  });

  app.patch("/accounts/:accountId", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as Partial<Pick<Account, "name" | "deletionRetentionDays" | "notifications" | "filtering">>;
    await store.updateAccount(accountId, body);
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Account users  —  /accounts/:accountId/users
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/users", async (c) => {
    if (!access) return c.json({ error: "Not implemented" }, 501);
    const { accountId } = c.get("auth");
    return c.json(await access.listUsers(accountId));
  });

  app.post("/accounts/:accountId/users", async (c) => {
    if (!access) return c.json({ error: "Not implemented" }, 501);
    const { accountId } = c.get("auth");
    const body = await c.req.json() as { userId?: string; role?: string };
    if (!body.userId) return c.json({ error: "userId is required" }, 400);
    if (!body.role || !VALID_ROLES.has(body.role as AccountRole)) return c.json({ error: "Invalid role" }, 400);
    await access.addUser(accountId, body.userId, body.role as AccountRole);
    return c.json({ ok: true }, 201);
  });

  app.patch("/accounts/:accountId/users/:userId", async (c) => {
    if (!access) return c.json({ error: "Not implemented" }, 501);
    const { accountId } = c.get("auth");
    const body = await c.req.json() as { role?: string };
    if (!body.role || !VALID_ROLES.has(body.role as AccountRole)) return c.json({ error: "Invalid role" }, 400);
    await access.updateUserRole(accountId, c.req.param("userId"), body.role as AccountRole);
    return c.json({ ok: true });
  });

  app.delete("/accounts/:accountId/users/:userId", async (c) => {
    if (!access) return c.json({ error: "Not implemented" }, 501);
    const { accountId } = c.get("auth");
    await access.removeUser(accountId, c.req.param("userId"));
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Email address configs  —  /accounts/:accountId/email-configs
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/email-configs", async (c) => {
    const { accountId } = c.get("auth");
    return c.json(await store.listEmailConfigs(accountId));
  });

  // -------------------------------------------------------------------------
  // Aliases  —  /accounts/:accountId/aliases
  // Pre-registration of email addresses before mail arrives (browser extension).
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/aliases", async (c) => {
    const { accountId } = c.get("auth");
    return c.json(await store.listEmailConfigs(accountId));
  });

  app.post("/accounts/:accountId/aliases", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as {
      address: string;
      filterMode?: SenderFilterMode;
      sourceUrl?: string;
    };

    if (!body.address || !body.address.includes("@")) {
      return c.json({ error: "Invalid address" }, 400);
    }

    const addressDomain = body.address.split("@")[1]!.toLowerCase();
    const domains = await store.listDomains(accountId);
    const owned = domains.some((d) => d.domain.toLowerCase() === addressDomain);
    if (!owned) {
      return c.json({ error: "Domain not registered to this account" }, 422);
    }

    const existing = await store.getEmailConfig(accountId, body.address);
    if (existing) {
      return c.json(existing, 200);
    }

    const account = await store.getAccount(accountId);
    const now = new Date().toISOString();
    const config: EmailAddressConfig = {
      id: randomUUID(),
      accountId,
      address: body.address,
      filterMode: body.filterMode ?? account?.filtering?.defaultFilterMode ?? "notify_new",
      approvedSenders: [],
      ...(body.sourceUrl !== undefined ? { sourceUrl: body.sourceUrl } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await store.upsertEmailConfig(config);
    return c.json(config, 201);
  });


  app.get("/accounts/:accountId/email-configs/:address", async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const config = await store.getEmailConfig(accountId, address);
    if (!config) return c.json({ error: "Not found" }, 404);
    return c.json(config);
  });

  app.put("/accounts/:accountId/email-configs/:address", async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const body = await c.req.json() as {
      filterMode: SenderFilterMode;
      approvedSenders: string[];
      onboardingEmailHandling?: EmailAddressConfig["onboardingEmailHandling"];
      spamScoreThreshold?: number;
    };
    const existing = await store.getEmailConfig(accountId, address);
    const now = new Date().toISOString();
    await store.upsertEmailConfig({
      id: existing?.id ?? randomUUID(),
      accountId,
      address,
      filterMode: body.filterMode,
      approvedSenders: body.approvedSenders,
      ...(body.onboardingEmailHandling !== undefined ? { onboardingEmailHandling: body.onboardingEmailHandling } : {}),
      ...(body.spamScoreThreshold !== undefined ? { spamScoreThreshold: body.spamScoreThreshold } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return c.json({ ok: true });
  });

  app.delete("/accounts/:accountId/email-configs/:address", async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    await store.deleteEmailConfig(accountId, address);
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Verified forwarding addresses  —  /accounts/:accountId/forwarding-addresses
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/forwarding-addresses", async (c) => {
    const { accountId } = c.get("auth");
    return c.json(await store.listVerifiedForwardingAddresses(accountId));
  });

  app.post("/accounts/:accountId/forwarding-addresses", async (c) => {
    const { accountId } = c.get("auth");
    const body = await c.req.json() as { address?: string };
    if (!body.address) return c.json({ error: "address is required" }, 400);

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
      await verificationMailer.sendForwardVerification(accountId, addr.address, addr.token).catch((err) => {
        console.error("Failed to send verification email:", err);
      });
    }

    return c.json(addr, 201);
  });

  app.post("/accounts/:accountId/forwarding-addresses/:address/verify", async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const body = await c.req.json() as { token?: string };
    if (!body.token) return c.json({ error: "token is required" }, 400);

    const existing = await store.getVerifiedForwardingAddress(accountId, address);
    if (!existing) return c.json({ error: "Not found" }, 404);
    if (existing.status === "verified") return c.json(existing);
    if (existing.token !== body.token) return c.json({ error: "Invalid token" }, 400);

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
