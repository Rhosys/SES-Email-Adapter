import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { randomUUID } from "crypto";
import { getDomain } from "tldts";
import { checkDomain } from "../dns/dns-checker.js";
import type { AuditEvent } from "../database/audit-database.js";
import type { Arc, Signal, View, Label, Rule, Domain, DnsRecord, Account, Page, PageParams, ArcStatus, Workflow, WorkflowData, Alias, AliasSender, SenderMode, SenderFilterMode, VerifiedForwardingAddress, Pagination, EmailTemplate, PushSubscription } from "../types/index.js";
import { deriveGroupingKey } from "../processor/processor.js";
import { zParse } from "./validate.js";
import {
  UpdateArcRequest, CreateArcFromSignalRequest, UpdateSignalRequest, UpdateSignalStatusRequest,
  CreateViewRequest, UpdateViewRequest,
  CreateLabelRequest, UpdateLabelRequest,
  CreateRuleRequest, UpdateRuleRequest,
  CreateDomainRequest,
  CreateAliasRequest, UpdateAliasRequest,
  UpdateAccountRequest,
  CreateForwardingAddressRequest, VerifyForwardingAddressRequest,
  InviteUserRequest, UpdateUserRequest,
  CreateSenderRequest, CreateTemplateRequest, UpdateTemplateRequest, CreatePushSubscriptionRequest,
} from "./requests.js";

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

export type { UpdateArcRequest, UpdateSignalStatusRequest, CreateViewRequest, UpdateViewRequest, CreateLabelRequest, UpdateLabelRequest, CreateRuleRequest, UpdateRuleRequest };

export interface ApiDatabase {
  // Arcs
  listArcs(accountId: string, params: ListArcsParams): Promise<Page<Arc>>;
  getArc(accountId: string, id: string): Promise<Arc | null>;
  updateArc(accountId: string, id: string, update: UpdateArcRequest): Promise<Arc>;

  // Signals
  listSignals(accountId: string, arcId: string, params: PageParams): Promise<Page<Signal>>;
  listPreArcSignals(accountId: string, status: "blocked" | "quarantined", params: PageParams): Promise<Page<Signal>>;
  getSignal(accountId: string, id: string): Promise<Signal | null>;
  updateSignal(accountId: string, id: string, update: Partial<Pick<Signal, "subject" | "textBody" | "from" | "to">>): Promise<Signal>;
  deleteSignal(accountId: string, id: string): Promise<void>;

  // Views
  listViews(accountId: string): Promise<View[]>;
  getView(accountId: string, id: string): Promise<View | null>;
  createView(accountId: string, data: CreateViewRequest): Promise<View>;
  updateView(accountId: string, id: string, data: UpdateViewRequest): Promise<View>;
  deleteView(accountId: string, id: string): Promise<void>;

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

  // Domains
  listDomains(accountId: string): Promise<Domain[]>;
  getDomain(accountId: string, id: string): Promise<Domain | null>;
  createDomain(accountId: string, domain: string): Promise<Domain>;
  deleteDomain(accountId: string, id: string): Promise<void>;
  updateDomainHealth(accountId: string, id: string, health: { receivingHealthy: boolean; senderHealthy: boolean; failingRecords: string[]; lastCheckedAt: string; lastHealthyAt?: string }): Promise<void>;

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
  renameAlias(accountId: string, oldAddress: string, newAddress: string): Promise<Alias>;

  // Alias Senders
  saveSender(accountId: string, address: string, domain: string, mode: SenderMode): Promise<void>;
  removeSender(accountId: string, address: string, domain: string): Promise<void>;
  listSenders(accountId: string, address: string): Promise<AliasSender[]>;

  // Templates
  createTemplate(template: EmailTemplate): Promise<EmailTemplate>;
  getTemplate(accountId: string, id: string): Promise<EmailTemplate | null>;
  updateTemplate(accountId: string, id: string, update: Partial<Pick<EmailTemplate, "name" | "subject" | "body">>): Promise<EmailTemplate>;
  deleteTemplate(accountId: string, id: string): Promise<void>;
  listTemplates(accountId: string): Promise<EmailTemplate[]>;

  // Push Subscriptions
  savePushSubscription(sub: PushSubscription): Promise<void>;
  listPushSubscriptions(accountId: string): Promise<PushSubscription[]>;
  deletePushSubscription(accountId: string, id: string): Promise<void>;

  // Signal status management
  blockSignal(accountId: string, signalId: string): Promise<Signal>;
  unblockSignal(accountId: string, signalId: string, arcId: string): Promise<void>;
  createArc(arc: Arc): Promise<void>;
  saveArc(arc: Arc): Promise<void>;
  findArcByGroupingKey(accountId: string, key: string): Promise<Arc | null>;

  // Verified forwarding addresses
  listVerifiedForwardingAddresses(accountId: string): Promise<VerifiedForwardingAddress[]>;
  getVerifiedForwardingAddress(accountId: string, address: string): Promise<VerifiedForwardingAddress | null>;
  saveVerifiedForwardingAddress(addr: VerifiedForwardingAddress): Promise<void>;
  deleteVerifiedForwardingAddress(accountId: string, address: string): Promise<void>;

  // Audit
  listAuditEvents(accountId: string, params: PageParams): Promise<Page<AuditEvent>>;
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

function page<K extends string, T>(key: K, items: T[], nextCursor?: string): Record<K, T[]> & { pagination: Pagination } {
  return { [key]: items, pagination: { cursor: nextCursor ?? null } } as Record<K, T[]> & { pagination: Pagination };
}

export function createApp({ store, auth, access, verificationMailer }: AppDeps) {
  const app = new OpenAPIHono<AppEnv>();

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "SES Email Adapter", version: "1.0.0" },
  });

  app.get("/", (c) => c.redirect("/openapi.json", 301));

  function err(c: Context<AppEnv>, status: number, title: string, errorCode?: string, details?: unknown) {
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
    const q = query["q"];
    if (q) {
      const params: PageParams = {
        ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
        ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
      };
      const result = await store.searchArcs(accountId, q, params);
      return c.json(page("arcs", result.items, result.nextCursor));
    }
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
    const body = await zParse(UpdateArcRequest, c.req.raw);
    const updated = await store.updateArc(accountId, arc.id, body);
    return c.json(updated);
  });

  app.post("/accounts/:accountId/arcs", async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreateArcFromSignalRequest, c.req.raw);

    const signal = await store.getSignal(accountId, body.signalId);
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.status !== "blocked" && signal.status !== "quarantine_visible" && signal.status !== "quarantine_hidden") {
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
        filterMode: "quarantine_visible" as SenderFilterMode,
        createdAt: now,
        updatedAt: now,
      };

      await store.upsertAlias({
        ...base,
        filterMode: body.updateFilterMode ?? base.filterMode,
        updatedAt: now,
      });
      if (body.approveSender) {
        await store.saveSender(accountId, signal.recipientAddress, senderETLD1, "allow");
      }
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

  app.get("/accounts/:accountId/signals", async (c) => {
    const { accountId } = c.get("auth");
    const query = c.req.query();
    const status = query["status"];
    if (status !== "blocked" && status !== "quarantined" && status !== "quarantine_visible" && status !== "quarantine_hidden") {
      return err(c, 400, "status query param must be 'blocked', 'quarantined', 'quarantine_visible', or 'quarantine_hidden'", "INVALID_STATUS");
    }
    const quarantineCategory = (status === "quarantined" || status === "quarantine_visible" || status === "quarantine_hidden") ? "quarantined" : "blocked";
    const params: PageParams = {
      ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
      ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
    };
    const result = await store.listPreArcSignals(accountId, quarantineCategory as "blocked" | "quarantined", params);
    return c.json(page("signals", result.items, result.nextCursor));
  });

  app.post("/accounts/:accountId/signals/:id/quarantineResponse", async (c) => {
    const { accountId } = c.get("auth");
    const signal = await store.getSignal(accountId, c.req.param("id"));
    if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
    if (signal.accountId !== accountId) return err(c, 403, "Forbidden");
    if (signal.status !== "blocked" && signal.status !== "quarantine_visible" && signal.status !== "quarantine_hidden") {
      return err(c, 400, "Only blocked or quarantined signals can have their status updated", "SIGNAL_NOT_REVIEWABLE");
    }

    const body = await zParse(UpdateSignalStatusRequest, c.req.raw);

    if (body.status === "blocked") {
      const updated = await store.blockSignal(accountId, signal.id);
      return c.json(updated);
    }

    // status === "active": find existing arc or create one, bypassing rule evaluation
    const senderDomain = signal.from.address.includes("@") ? signal.from.address.split("@").pop()! : signal.from.address;
    const senderETLD1 = getDomain(senderDomain) ?? senderDomain;
    const groupingKey = deriveGroupingKey(signal.workflow, signal.workflowData, signal.recipientAddress, senderETLD1);
    const matchedArc = groupingKey ? await store.findArcByGroupingKey(accountId, groupingKey) : null;

    const now = new Date().toISOString();
    let arc: Arc;
    if (matchedArc) {
      arc = matchedArc;
      if (signal.receivedAt > arc.lastSignalAt) {
        arc = { ...arc, lastSignalAt: signal.receivedAt, updatedAt: now };
        await store.saveArc(arc);
      }
    } else {
      arc = {
        id: randomUUID(),
        accountId,
        workflow: signal.workflow,
        labels: [],
        status: "active",
        summary: signal.summary,
        lastSignalAt: signal.receivedAt,
        createdAt: now,
        updatedAt: now,
        ...(groupingKey ? { groupingKey } : {}),
      };
      await store.createArc(arc);
    }

    await store.unblockSignal(accountId, signal.id, arc.id);

    return c.json({ arc, signal: { ...signal, status: "active", arcId: arc.id } });
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
    const body = await zParse(UpdateSignalRequest, c.req.raw);
    const updated = await store.updateSignal(accountId, signal.id, body as Parameters<typeof store.updateSignal>[2]);
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

  app.post("/accounts/:accountId/views", async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreateViewRequest, c.req.raw);
    const view = await store.createView(accountId, body);
    return c.json(view, 201);
  });

  app.patch("/accounts/:accountId/views/:id", async (c) => {
    const { accountId } = c.get("auth");
    const view = await store.getView(accountId, c.req.param("id"));
    if (!view) return err(c, 404, "View not found", "VIEW_NOT_FOUND");
    const body = await zParse(UpdateViewRequest, c.req.raw);
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
    const body = await zParse(CreateLabelRequest, c.req.raw);
    const label = await store.createLabel(accountId, body);
    return c.json(label, 201);
  });

  app.patch("/accounts/:accountId/labels/:id", async (c) => {
    const { accountId } = c.get("auth");
    const labels = await store.listLabels(accountId);
    const label = labels.find((l) => l.id === c.req.param("id"));
    if (!label) return err(c, 404, "Label not found", "LABEL_NOT_FOUND");
    const body = await zParse(UpdateLabelRequest, c.req.raw);
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

  app.post("/accounts/:accountId/rules", async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreateRuleRequest, c.req.raw);
    const forwardError = await validateForwardTargets(accountId, body.actions as Rule["actions"], store);
    if (forwardError) return err(c, 400, forwardError, "UNVERIFIED_FORWARD_TARGET");
    const rule = await store.createRule(accountId, body as Parameters<typeof store.createRule>[1]);
    return c.json(rule, 201);
  });

  app.patch("/accounts/:accountId/rules/:id", async (c) => {
    const { accountId } = c.get("auth");
    const rules = await store.listRules(accountId);
    const rule = rules.find((r) => r.id === c.req.param("id"));
    if (!rule) return err(c, 404, "Rule not found", "RULE_NOT_FOUND");
    const body = await zParse(UpdateRuleRequest, c.req.raw);
    if (body.actions) {
      const forwardError = await validateForwardTargets(accountId, body.actions as Rule["actions"], store);
      if (forwardError) return err(c, 400, forwardError, "UNVERIFIED_FORWARD_TARGET");
    }
    const updated = await store.updateRule(accountId, rule.id, body as Parameters<typeof store.updateRule>[2]);
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
    const body = await zParse(CreateDomainRequest, c.req.raw);
    const domain = await store.createDomain(accountId, body.domain);
    return c.json(domain, 201);
  });

  app.get("/accounts/:accountId/domains/:id", async (c) => {
    const { accountId } = c.get("auth");
    const domain = await store.getDomain(accountId, c.req.param("id"));
    if (!domain) return err(c, 404, "Domain not found", "DOMAIN_NOT_FOUND");
    if (domain.accountId !== accountId) return err(c, 403, "Forbidden");
    const records = await checkDomain(domain);
    return c.json({ ...domain, records });
  });

  app.get("/accounts/:accountId/domains/:id/records", async (c) => {
    const { accountId } = c.get("auth");
    const domain = await store.getDomain(accountId, c.req.param("id"));
    if (!domain) return err(c, 404, "Domain not found", "DOMAIN_NOT_FOUND");
    if (domain.accountId !== accountId) return err(c, 403, "Forbidden");
    return c.json(buildDnsRecords(domain));
  });

  app.post("/accounts/:accountId/domains/:id/verify", async (c) => {
    const { accountId } = c.get("auth");
    const domain = await store.getDomain(accountId, c.req.param("id"));
    if (!domain) return err(c, 404, "Domain not found", "DOMAIN_NOT_FOUND");
    if (domain.accountId !== accountId) return err(c, 403, "Forbidden");
    const records = await checkDomain(domain);
    const now = new Date().toISOString();
    const failingRecords = records.filter((r) => r.status === "failing").map((r) => r.name);
    const receivingHealthy = records.find((r) => r.type === "MX")?.status === "verified";
    const senderHealthy = records.filter((r) => r.type !== "MX").every((r) => r.status === "verified");
    await store.updateDomainHealth(accountId, domain.id, {
      receivingHealthy,
      senderHealthy,
      failingRecords,
      lastCheckedAt: now,
      ...(failingRecords.length === 0 ? { lastHealthyAt: now } : {}),
    });
    return c.json(records);
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
    const body = await zParse(UpdateAccountRequest, c.req.raw);
    const updated = await store.updateAccount(accountId, body as Partial<Pick<Account, "name" | "deletionRetentionDays" | "notifications" | "filtering">>);
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
    const body = await zParse(InviteUserRequest, c.req.raw);
    await access.addUser(accountId, body.userId, body.role);
    return c.json({ userId: body.userId, role: body.role }, 201);
  });

  app.patch("/accounts/:accountId/users/:userId", async (c) => {
    if (!access) return err(c, 501, "Not implemented");
    const { accountId } = c.get("auth");
    const body = await zParse(UpdateUserRequest, c.req.raw);
    await access.updateUserRole(accountId, c.req.param("userId"), body.role);
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
    const domain = c.req.query("domain");
    let aliases = await store.listAliases(accountId);
    if (domain) aliases = aliases.filter(a => a.createdForOrigin?.includes(domain));
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
    const body = await zParse(CreateAliasRequest, c.req.raw);
    const existing = await store.getAlias(accountId, body.address);
    if (existing) return err(c, 409, "Alias already exists", "ALIAS_EXISTS");
    const now = new Date().toISOString();
    const alias = await store.createAlias({
      id: randomUUID(),
      accountId,
      address: body.address,
      filterMode: body.filterMode ?? "quarantine_visible",
      ...(body.createdForOrigin !== undefined ? { createdForOrigin: body.createdForOrigin } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return c.json(alias, 201);
  });

  app.patch("/accounts/:accountId/aliases/:address", async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const body = await zParse(UpdateAliasRequest, c.req.raw);
    if (body.newAddress) {
      const renamed = await store.renameAlias(accountId, address, body.newAddress);
      return c.json(renamed);
    }
    const existing = await store.getAlias(accountId, address);
    const now = new Date().toISOString();
    const updated = await store.upsertAlias({
      id: existing?.id ?? randomUUID(),
      accountId,
      address,
      filterMode: body.filterMode ?? existing?.filterMode ?? "quarantine_visible",
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
  // Alias Senders  —  /accounts/:accountId/aliases/:address/senders
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/aliases/:address/senders", async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const senders = await store.listSenders(accountId, address);
    return c.json({ senders });
  });

  app.post("/accounts/:accountId/aliases/:address/senders", async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const body = await zParse(CreateSenderRequest, c.req.raw);
    await store.saveSender(accountId, address, body.domain, body.mode);
    return new Response(null, { status: 201 });
  });

  app.delete("/accounts/:accountId/aliases/:address/senders/:domain", async (c) => {
    const { accountId } = c.get("auth");
    const address = decodeURIComponent(c.req.param("address"));
    const domain = decodeURIComponent(c.req.param("domain"));
    await store.removeSender(accountId, address, domain);
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Email Templates  —  /accounts/:accountId/templates
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/templates", async (c) => {
    const { accountId } = c.get("auth");
    const templates = await store.listTemplates(accountId);
    return c.json({ templates });
  });

  app.post("/accounts/:accountId/templates", async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreateTemplateRequest, c.req.raw);
    const now = new Date().toISOString();
    const template = await store.createTemplate({
      id: randomUUID(), accountId, name: body.name, subject: body.subject, body: body.body,
      createdAt: now, updatedAt: now,
    });
    return c.json(template, 201);
  });

  app.patch("/accounts/:accountId/templates/:id", async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(UpdateTemplateRequest, c.req.raw);
    const existing = await store.getTemplate(accountId, c.req.param("id"));
    if (!existing) return err(c, 404, "Template not found", "TEMPLATE_NOT_FOUND");
    const updated = await store.updateTemplate(accountId, c.req.param("id"), body as Parameters<typeof store.updateTemplate>[2]);
    return c.json(updated);
  });

  app.delete("/accounts/:accountId/templates/:id", async (c) => {
    const { accountId } = c.get("auth");
    const existing = await store.getTemplate(accountId, c.req.param("id"));
    if (!existing) return err(c, 404, "Template not found", "TEMPLATE_NOT_FOUND");
    await store.deleteTemplate(accountId, c.req.param("id"));
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // Push Subscriptions  —  /accounts/:accountId/push-subscriptions
  // -------------------------------------------------------------------------

  app.post("/accounts/:accountId/push-subscriptions", async (c) => {
    const { accountId } = c.get("auth");
    const body = await zParse(CreatePushSubscriptionRequest, c.req.raw);
    const sub: PushSubscription = {
      id: randomUUID(), accountId,
      endpoint: body.endpoint, keys: body.keys,
      createdAt: new Date().toISOString(),
    };
    await store.savePushSubscription(sub);
    return c.json(sub, 201);
  });

  app.delete("/accounts/:accountId/push-subscriptions/:id", async (c) => {
    const { accountId } = c.get("auth");
    await store.deletePushSubscription(accountId, c.req.param("id"));
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
    const body = await zParse(CreateForwardingAddressRequest, c.req.raw);

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
    const body = await zParse(VerifyForwardingAddressRequest, c.req.raw);

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
  // Audit  —  /accounts/:accountId/audit
  // -------------------------------------------------------------------------

  app.get("/accounts/:accountId/audit", async (c) => {
    const { accountId } = c.get("auth");
    const cursor = c.req.query("cursor");
    const rawLimit = c.req.query("limit");
    const params: PageParams = { ...(cursor ? { cursor } : {}), ...(rawLimit ? { limit: parseInt(rawLimit, 10) } : {}) };
    const result = await store.listAuditEvents(accountId, params);
    return c.json(result);
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
