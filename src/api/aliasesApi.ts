import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { DateTime } from "luxon";
import { randomUUID } from "crypto";
import { ok as neverthrowOk, err as neverthrowErr } from "neverthrow";
import type { Result } from "neverthrow";
import type { DbError } from "../errors.js";
import type { ForwardingTarget } from "../types/index.js";
import { DEFAULT_UNKNOWN_SENDER_POLICY } from "../types/index.js";
import { zParse } from "./validate.js";
import { toApiAlias, toApiAliasSender, toApiForwardingTarget } from "./transform.js";
import { CreateAliasRequest, UpdateAliasRequest, CreateSenderRequest, UpdateSenderRequest, CreateForwardingTargetRequest, VerifyForwardingTargetRequest } from "./requests.js";
import {
  Alias as AliasSchema, AliasSender as AliasSenderSchema,
  ForwardingTarget as ForwardingTargetSchema,
  ListAliasesResponse, ListSendersResponse,
  ListForwardingTargetsResponse,
} from "./schemas.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { AuditDatabase } from "../database/audit-database.js";
import type { Logger } from "../logger.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";
import type { IForwardingService } from "../forwarding/forwarding-service.js";

// Mirrors processor.ts's autoApprove — a sender disposition recorded for an address
// implies that address is a recognised alias, so the Alias record must exist alongside it.
export async function ensureAliasExists(accountDb: AccountDatabase, accountId: string, address: string, idempotencyKey: string): Promise<Result<void, DbError>> {
  const filteringResult = await accountDb.getAccountFilteringConfig(accountId);
  if (filteringResult.isErr()) return neverthrowErr(filteringResult.error);
  const defaultUnknownSenderPolicy = filteringResult.value?.defaultUnknownSenderPolicy ?? DEFAULT_UNKNOWN_SENDER_POLICY;

  const existingResult = await accountDb.getAlias(accountId, address);
  if (existingResult.isErr()) return neverthrowErr(existingResult.error);
  const existed = existingResult.value !== null;

  const aliasResult = await accountDb.ensureAlias(accountId, address, defaultUnknownSenderPolicy, existingResult.value);
  if (aliasResult.isErr()) return neverthrowErr(aliasResult.error);
  if (!existed) {
    await accountDb.incrementStatMetric(accountId, "totalAliases", 1, idempotencyKey);
  }
  return neverthrowOk(undefined);
}

export class AliasesApi {
  constructor(
    private readonly accountDb: AccountDatabase,
    private readonly auditDb: AuditDatabase,
    private readonly logger: Logger,
    private readonly forwardingService: IForwardingService,
  ) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { accountDb, auditDb, logger, forwardingService } = this;

    // -------------------------------------------------------------------------
    // Aliases  —  /accounts/:accountId/aliases
    // -------------------------------------------------------------------------

    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/aliases",
      tags: ["Aliases"],
      request: {
        params: z.object({ accountId: z.string() }),
        query: z.object({ domain: z.string().optional() }),
      },
      middleware: [authz("aliases:read", c => `accounts/${c.req.param("accountId")!}/aliases`)] as const,
      responses: { 200: { content: { "application/json": { schema: ListAliasesResponse } }, description: "List aliases" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const domain = c.req.query("domain")?.toLowerCase();
      const aliasesResult = await accountDb.listAliases(accountId);
      if (aliasesResult.isErr()) return err(c, 500, "Internal Server Error");
      let aliases = aliasesResult.value;
      if (domain) aliases = aliases.filter(a => a.createdForOrigin?.includes(domain));
      return c.json({ aliases: aliases.map(toApiAlias) }, 200);
    });

    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/aliases/{address}",
      tags: ["Aliases"],
      request: { params: z.object({ accountId: z.string(), address: z.string() }) },
      middleware: [authz("aliases:read", c => `accounts/${c.req.param("accountId")!}/aliases/${c.req.param("address")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: AliasSchema } }, description: "Get alias" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
      const aliasResult = await accountDb.getAlias(accountId, address);
      if (aliasResult.isErr()) return err(c, 500, "Internal Server Error");
      const alias = aliasResult.value;
      if (!alias) return err(c, 404, "Alias not found", "ALIAS_NOT_FOUND");
      return c.json(toApiAlias(alias), 200);
    });

    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/aliases",
      tags: ["Aliases"],
      request: { params: z.object({ accountId: z.string() }) },
      middleware: [authz("aliases:write", c => `accounts/${c.req.param("accountId")!}/aliases`)] as const,
      responses: { 201: { content: { "application/json": { schema: AliasSchema } }, description: "Alias created" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const body = await zParse(CreateAliasRequest, c.req.raw);
      const aliasDomain = body.address.split("@")[1]!;
      const domainCheckResult = await accountDb.getDomain(accountId, aliasDomain);
      if (domainCheckResult.isErr()) return err(c, 500, "Internal Server Error");
      if (!domainCheckResult.value) return err(c, 422, "Domain not registered for this account", "DOMAIN_NOT_REGISTERED");
      const existingResult = await accountDb.getAlias(accountId, body.address);
      if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
      if (existingResult.value) return err(c, 409, "Alias already exists", "ALIAS_EXISTS");
      const now = DateTime.utc().toISO()!;
      const createResult = await accountDb.createAlias({
        id: body.address,
        accountId,
        address: body.address,
        domain: body.address.split("@")[1]!,
        alias: body.address.split("@")[0]!,
        unknownSenderPolicy: body.unknownSenderPolicy ?? "quarantine_visible",
        ...(body.createdForOrigin !== undefined ? { createdForOrigin: body.createdForOrigin } : {}),
        createdAt: now,
        updatedAt: now,
      });
      if (createResult.isErr()) return err(c, 500, "Internal Server Error");
      await accountDb.incrementStatMetric(accountId, "totalAliases", 1, logger.getInvocationId());
      return c.json(toApiAlias(createResult.value), 201);
    });

    app.openapi(route({
      method: "patch",
      path: "/accounts/{accountId}/aliases/{address}",
      tags: ["Aliases"],
      request: { params: z.object({ accountId: z.string(), address: z.string() }) },
      middleware: [authz("aliases:write", c => `accounts/${c.req.param("accountId")!}/aliases/${c.req.param("address")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: AliasSchema } }, description: "Update alias" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
      const body = await zParse(UpdateAliasRequest, c.req.raw);
      if (body.newAddress) {
        const newDomain = body.newAddress.split("@")[1]!;
        const domainCheckResult = await accountDb.getDomain(accountId, newDomain);
        if (domainCheckResult.isErr()) return err(c, 500, "Internal Server Error");
        if (!domainCheckResult.value) return err(c, 422, "Domain not registered for this account", "DOMAIN_NOT_REGISTERED");
        const renameResult = await accountDb.renameAlias(accountId, address, body.newAddress);
        if (renameResult.isErr()) {
          if (renameResult.error.kind === "not_found") return err(c, 404, "Alias not found", "ALIAS_NOT_FOUND");
          return err(c, 500, "Internal Server Error");
        }
        return c.json(toApiAlias(renameResult.value), 200);
      }
      const existingResult = await accountDb.getAlias(accountId, address);
      if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
      const existing = existingResult.value;
      const now = DateTime.utc().toISO()!;
      const upsertResult = await accountDb.upsertAlias({
        id: address,
        accountId,
        address,
        domain: address.split("@")[1]!,
        alias: address.split("@")[0]!,
        unknownSenderPolicy: body.unknownSenderPolicy ?? existing?.unknownSenderPolicy ?? "quarantine_visible",
        ...(body.createdForOrigin !== undefined ? { createdForOrigin: body.createdForOrigin } : existing?.createdForOrigin !== undefined ? { createdForOrigin: existing.createdForOrigin } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      if (upsertResult.isErr()) return err(c, 500, "Internal Server Error");
      return c.json(toApiAlias(upsertResult.value), 200);
    });

    app.openapi(route({
      method: "delete",
      path: "/accounts/{accountId}/aliases/{address}",
      tags: ["Aliases"],
      request: { params: z.object({ accountId: z.string(), address: z.string() }) },
      middleware: [authz("aliases:write", c => `accounts/${c.req.param("accountId")!}/aliases/${c.req.param("address")!}`)] as const,
      responses: { 204: { description: "Alias deleted" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
      const deleteResult = await accountDb.deleteAlias(accountId, address);
      if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
      await accountDb.incrementStatMetric(accountId, "totalAliases", -1, logger.getInvocationId());
      const { userId } = c.get("auth");
      const auditResult = await auditDb.saveAuditEvent({
        accountId, userId, action: "deleted", resourceType: "alias", resourceId: address,
        before: { address }, after: null,
      });
      if (auditResult.isErr()) {
        logger.warn("Audit write failed for alias deletion, proceeding", { code: "api.audit.alias_delete_failed", accountId, address, error: auditResult.error });
      }
      return new Response(null, { status: 204 });
    });

    // -------------------------------------------------------------------------
    // Alias Senders  —  /accounts/:accountId/aliases/:address/senders
    // -------------------------------------------------------------------------

    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/aliases/{address}/senders",
      tags: ["Alias Senders"],
      request: { params: z.object({ accountId: z.string(), address: z.string() }) },
      middleware: [authz("aliases:read", c => `accounts/${c.req.param("accountId")!}/aliases/${c.req.param("address")!}/senders`)] as const,
      responses: { 200: { content: { "application/json": { schema: ListSendersResponse } }, description: "List senders" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
      const sendersResult = await accountDb.listSenders(accountId, address);
      if (sendersResult.isErr()) return err(c, 500, "Internal Server Error");
      return c.json({ senders: sendersResult.value.map(toApiAliasSender) }, 200);
    });

    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/aliases/{address}/senders",
      tags: ["Alias Senders"],
      request: { params: z.object({ accountId: z.string(), address: z.string() }) },
      middleware: [authz("aliases:write", c => `accounts/${c.req.param("accountId")!}/aliases/${c.req.param("address")!}/senders`)] as const,
      responses: { 201: { content: { "application/json": { schema: AliasSenderSchema } }, description: "Sender created" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
      const body = await zParse(CreateSenderRequest, c.req.raw);
      const existingResult = await accountDb.getSender(accountId, address, body.domain);
      if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
      if (existingResult.value) {
        if (existingResult.value.policy === body.policy) {
          return c.json(toApiAliasSender(existingResult.value), 201);
        }
        return err(c, 409, "Sender already exists with a different policy", "SENDER_EXISTS");
      }
      const saveResult = await accountDb.saveSender(accountId, address, body.domain, body.policy);
      if (saveResult.isErr()) return err(c, 500, "Internal Server Error");
      const createdResult = await accountDb.getSender(accountId, address, body.domain);
      if (createdResult.isErr() || !createdResult.value) return err(c, 500, "Internal Server Error");
      return c.json(toApiAliasSender(createdResult.value), 201);
    });

    app.openapi(route({
      method: "put",
      path: "/accounts/{accountId}/aliases/{address}/senders/{domain}",
      tags: ["Alias Senders"],
      request: { params: z.object({ accountId: z.string(), address: z.string(), domain: z.string() }) },
      middleware: [authz("aliases:write", c => `accounts/${c.req.param("accountId")!}/aliases/${c.req.param("address")!}/senders/${c.req.param("domain")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: AliasSenderSchema } }, description: "Sender updated" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
      const senderDomain = decodeURIComponent(c.req.param("domain")!).toLowerCase();
      const body = await zParse(UpdateSenderRequest, c.req.raw);
      const existingResult = await accountDb.getSender(accountId, address, senderDomain);
      if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
      if (!existingResult.value) return err(c, 404, "Sender not found", "SENDER_NOT_FOUND");
      const saveResult = await accountDb.saveSender(accountId, address, senderDomain, body.policy);
      if (saveResult.isErr()) return err(c, 500, "Internal Server Error");
      const updatedResult = await accountDb.getSender(accountId, address, senderDomain);
      if (updatedResult.isErr() || !updatedResult.value) return err(c, 500, "Internal Server Error");
      return c.json(toApiAliasSender(updatedResult.value), 200);
    });

    app.openapi(route({
      method: "delete",
      path: "/accounts/{accountId}/aliases/{address}/senders/{domain}",
      tags: ["Alias Senders"],
      request: { params: z.object({ accountId: z.string(), address: z.string(), domain: z.string() }) },
      middleware: [authz("aliases:write", c => `accounts/${c.req.param("accountId")!}/aliases/${c.req.param("address")!}/senders/${c.req.param("domain")!}`)] as const,
      responses: { 204: { description: "Sender removed" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
      const senderDomain = decodeURIComponent(c.req.param("domain")!).toLowerCase();
      const removeResult = await accountDb.removeSender(accountId, address, senderDomain);
      if (removeResult.isErr()) return err(c, 500, "Internal Server Error");
      return new Response(null, { status: 204 });
    });

    // -------------------------------------------------------------------------
    // Forwarding targets  —  /accounts/:accountId/forwarding-addresses
    // -------------------------------------------------------------------------

    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/forwarding-addresses",
      tags: ["Forwarding Targets"],
      request: { params: z.object({ accountId: z.string() }) },
      middleware: [authz("forwarding-addresses:read", c => `accounts/${c.req.param("accountId")!}/forwarding-addresses`)] as const,
      responses: { 200: { content: { "application/json": { schema: ListForwardingTargetsResponse } }, description: "List forwarding targets" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const targetsResult = await accountDb.listForwardingTargets(accountId);
      if (targetsResult.isErr()) return err(c, 500, "Internal Server Error");
      return c.json({ forwardingTargets: targetsResult.value.map(toApiForwardingTarget) }, 200);
    });

    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/forwarding-addresses",
      tags: ["Forwarding Targets"],
      request: { params: z.object({ accountId: z.string() }) },
      middleware: [authz("forwarding-addresses:write", c => `accounts/${c.req.param("accountId")!}/forwarding-addresses`)] as const,
      responses: { 201: { content: { "application/json": { schema: ForwardingTargetSchema } }, description: "Forwarding target created" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const body = await zParse(CreateForwardingTargetRequest, c.req.raw);

      const existingResult = await accountDb.getForwardingTarget(accountId, body.target);
      if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
      const existing = existingResult.value;
      if (existing?.status === "verified") return c.json(toApiForwardingTarget(existing), 201);

      const now = DateTime.utc().toISO()!;
      const addr: ForwardingTarget = {
        id: body.target,
        accountId,
        target: body.target,
        type: body.type,
        status: "pending",
        token: randomUUID(),
        createdAt: existing?.createdAt ?? now,
        ...(existing?.verifiedAt !== undefined ? { verifiedAt: existing.verifiedAt } : {}),
      };

      // Verify based on type — ForwardingService dispatches by target type internally
      const verifyResult = await forwardingService.sendVerification(accountId, addr);
      if (verifyResult.isErr()) {
        if (body.type === "webhook") {
          logger.warn("Webhook target verification failed — URL did not return HTTP 200", { code: "forwarding.webhook_verification_failed", accountId, target: addr.target, error: verifyResult.error });
          return err(c, 422, "Webhook URL did not respond with HTTP 200. Please check the URL and try again.");
        }
        logger.warn("Failed to send forwarding target verification email", { code: "forwarding.verification_email_failed", accountId, target: addr.target, error: verifyResult.error });
        return err(c, 422, "Failed to send verification email. Please try again.");
      }
      if (body.type === "webhook") {
        // Webhooks are verified immediately on successful test request
        addr.status = "verified";
        addr.verifiedAt = now;
      }

      const saveResult = await accountDb.saveForwardingTarget(addr);
      if (saveResult.isErr()) return err(c, 500, "Internal Server Error");

      return c.json(toApiForwardingTarget(addr), 201);
    });

    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/forwarding-addresses/{address}/verify",
      tags: ["Forwarding Targets"],
      request: { params: z.object({ accountId: z.string(), address: z.string() }) },
      middleware: [authz("forwarding-addresses:write", c => `accounts/${c.req.param("accountId")!}/forwarding-addresses/${c.req.param("address")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: ForwardingTargetSchema } }, description: "Target verified" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
      const body = await zParse(VerifyForwardingTargetRequest, c.req.raw);

      const existingResult = await accountDb.getForwardingTarget(accountId, address);
      if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
      const existing = existingResult.value;
      if (!existing) return err(c, 404, "Forwarding target not found", "FORWARDING_ADDRESS_NOT_FOUND");
      if (existing.status === "verified") return c.json(toApiForwardingTarget(existing), 200);
      if (existing.token !== body.token) return err(c, 400, "Invalid token", "INVALID_TOKEN");

      const verified: ForwardingTarget = { ...existing, status: "verified", verifiedAt: DateTime.utc().toISO()! };
      const saveResult = await accountDb.saveForwardingTarget(verified);
      if (saveResult.isErr()) return err(c, 500, "Internal Server Error");
      return c.json(toApiForwardingTarget(verified), 200);
    });

    app.openapi(route({
      method: "delete",
      path: "/accounts/{accountId}/forwarding-addresses/{address}",
      tags: ["Forwarding Targets"],
      request: { params: z.object({ accountId: z.string(), address: z.string() }) },
      middleware: [authz("forwarding-addresses:write", c => `accounts/${c.req.param("accountId")!}/forwarding-addresses/${c.req.param("address")!}`)] as const,
      responses: { 204: { description: "Forwarding target deleted" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const address = decodeURIComponent(c.req.param("address")!).toLowerCase();

      // Reject delete if target is referenced by digest or rules
      const accountResult = await accountDb.getAccount(accountId);
      if (accountResult.isErr()) return err(c, 500, "Internal Server Error");
      if (accountResult.value?.digest?.forwardingTargetId === address) {
        return err(c, 409, "Cannot delete target — currently used for digest emails", "TARGET_IN_USE");
      }

      const rulesResult = await accountDb.listRules(accountId);
      if (rulesResult.isErr()) return err(c, 500, "Internal Server Error");
      const referencingRule = rulesResult.value.find(r =>
        r.actions.some(a => a.type === "forward" && a.value === address),
      );
      if (referencingRule) {
        return err(c, 409, "Cannot delete target — referenced by rule: " + referencingRule.name, "TARGET_IN_USE");
      }

      const deleteResult = await accountDb.deleteForwardingTarget(accountId, address);
      if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
      return new Response(null, { status: 204 });
    });
  }
}
