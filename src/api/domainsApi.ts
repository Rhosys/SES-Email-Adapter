import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { DateTime } from "luxon";
import { zParse } from "./validate.js";
import { toApiDomain, toApiDomainWithRecords } from "./transform.js";
import { CreateDomainRequest } from "./requests.js";
import {
  Domain as DomainSchema, DomainWithRecords as DomainWithRecordsSchema,
  ListDomainsResponse,
} from "./schemas.js";
import { checkDomain } from "../dns/dns-checker.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { AuditDatabase } from "../database/audit-database.js";
import type { DomainIdentityService } from "../email/domain-identity-service.js";
import type { Logger } from "../logger.js";
import type { Domain, DnsRecord } from "../types/index.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";

// ---------------------------------------------------------------------------
// DNS record builder
// ---------------------------------------------------------------------------

const DKIM_SELECTOR = "mail";
const MAIL_DOMAIN = process.env["MAIL_DOMAIN"] ?? "platform.email.rhosys.cloud";

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
      value: `10 mx.${MAIL_DOMAIN}`,
      status: recordStatus(mxName),
    },
    {
      name: dkimName,
      type: "CNAME",
      value: `${DKIM_SELECTOR}._domainkey.${MAIL_DOMAIN}`,
      status: recordStatus(dkimName),
    },
    {
      name: spfName,
      type: "CNAME",
      value: `bounce.${MAIL_DOMAIN}`,
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

// ---------------------------------------------------------------------------
// DomainsApi class
// ---------------------------------------------------------------------------

export class DomainsApi {
  constructor(
    private readonly accountDb: AccountDatabase,
    private readonly auditDb: AuditDatabase,
    private readonly domainIdentityService: DomainIdentityService,
    private readonly logger: Logger,
  ) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { accountDb, auditDb, domainIdentityService, logger } = this;

    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/domains",
      tags: ["Domains"],
      request: { params: z.object({ accountId: z.string() }) },
      middleware: [authz("domains:read", c => `accounts/${c.req.param("accountId")!}/domains`)] as const,
      responses: { 200: { content: { "application/json": { schema: ListDomainsResponse } }, description: "List domains" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const domainsResult = await accountDb.listDomains(accountId);
      if (domainsResult.isErr()) return err(c, 500, "Internal Server Error");
      return c.json({ domains: domainsResult.value.map(toApiDomain) }, 200);
    });

    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/domains",
      tags: ["Domains"],
      request: { params: z.object({ accountId: z.string() }) },
      middleware: [authz("domains:write", c => `accounts/${c.req.param("accountId")!}/domains`)] as const,
      responses: { 201: { content: { "application/json": { schema: DomainSchema } }, description: "Domain created" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const body = await zParse(CreateDomainRequest, c.req.raw);

      // Cross-account ownership check — oldest registrant wins
      const ownerResult = await accountDb.resolveAccountForDomain(body.domain);
      if (ownerResult.isErr()) return err(c, 500, "Internal Server Error");
      if (ownerResult.value && ownerResult.value !== accountId) {
        return err(c, 409, "Domain already registered by another account", "DOMAIN_EXISTS");
      }

      // Register domain with SES first (idempotent — AlreadyExistsException is ok)
      const sesResult = await domainIdentityService.register(body.domain, accountId);
      if (sesResult.isErr()) {
        logger.error("Failed to register domain SES identity", { code: "domain.ses_identity_failed", accountId, domain: body.domain, error: sesResult.error });
        return err(c, 500, "Internal Server Error");
      }

      // DB write last — once this succeeds, the domain "exists" for all readers
      const domainResult = await accountDb.createDomain(accountId, body.domain);
      if (domainResult.isErr()) return err(c, 500, "Internal Server Error");

      return c.json(toApiDomain(domainResult.value), 201);
    });

    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/domains/{id}",
      tags: ["Domains"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("domains:read", c => `accounts/${c.req.param("accountId")!}/domains/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: DomainWithRecordsSchema } }, description: "Get domain with DNS records" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const domainResult = await accountDb.getDomain(accountId, c.req.param("id")!.toLowerCase());
      if (domainResult.isErr()) return err(c, 500, "Internal Server Error");
      const domain = domainResult.value;
      if (!domain) return err(c, 404, "Domain not found", "DOMAIN_NOT_FOUND");
      const records = buildDnsRecords(domain);
      return c.json(toApiDomainWithRecords(domain, records), 200);
    });

    app.openapi(route({
      method: "patch",
      path: "/accounts/{accountId}/domains/{id}",
      tags: ["Domains"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("domains:write", c => `accounts/${c.req.param("accountId")!}/domains/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: DomainWithRecordsSchema } }, description: "Verify/refresh domain" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const domainResult = await accountDb.getDomain(accountId, c.req.param("id")!.toLowerCase());
      if (domainResult.isErr()) return err(c, 500, "Internal Server Error");
      const domain = domainResult.value;
      if (!domain) return err(c, 404, "Domain not found", "DOMAIN_NOT_FOUND");
      const records = await checkDomain(domain);
      const now = DateTime.utc().toISO()!;
      const failingRecords = records.filter((r) => r.status === "failing").map((r) => r.name);
      const receivingHealthy = records.find((r) => r.type === "MX")?.status === "verified";
      const senderHealthy = records.filter((r) => r.type !== "MX").every((r) => r.status === "verified");
      const healthResult = await accountDb.updateDomainHealth(accountId, domain.domain, {
        receivingHealthy,
        senderHealthy,
        failingRecords,
        lastCheckedAt: now,
        ...(failingRecords.length === 0 ? { lastHealthyAt: now } : {}),
      });
      if (healthResult.isErr()) return err(c, 500, "Internal Server Error");

      // Update setup flags to reflect current DNS state
      const receivingChanged = (receivingHealthy ?? false) !== domain.receivingSetupComplete;
      const senderChanged = senderHealthy !== domain.senderSetupComplete;
      if (receivingChanged || senderChanged) {
        await accountDb.updateDomainSetup(accountId, domain.domain, {
          receivingSetupComplete: receivingHealthy ?? false,
          senderSetupComplete: senderHealthy,
        });
      }

      const updatedResult = await accountDb.getDomain(accountId, domain.domain);
      if (updatedResult.isErr()) return err(c, 500, "Internal Server Error");
      return c.json(toApiDomainWithRecords(updatedResult.value!, records), 200);
    });

    app.openapi(route({
      method: "delete",
      path: "/accounts/{accountId}/domains/{id}",
      tags: ["Domains"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("domains:write", c => `accounts/${c.req.param("accountId")!}/domains/${c.req.param("id")!}`)] as const,
      responses: { 204: { description: "Domain deleted" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const domainResult = await accountDb.getDomain(accountId, c.req.param("id")!.toLowerCase());
      if (domainResult.isErr()) return err(c, 500, "Internal Server Error");
      const domain = domainResult.value;
      if (!domain) return err(c, 404, "Domain not found", "DOMAIN_NOT_FOUND");

      const { userId } = c.get("auth");

      // Cascade: delete every alias (and its senders) registered under this domain
      const aliasesResult = await accountDb.listAliasesForDomain(accountId, domain.domain);
      if (aliasesResult.isErr()) return err(c, 500, "Internal Server Error");
      const aliases = aliasesResult.value;
      logger.info("Cascade-deleting aliases for domain", {
        code: "api.domain_delete.cascade_aliases",
        accountId,
        domain: domain.domain,
        aliases: aliases.map((a) => a.address),
      });

      for (const alias of aliases) {
        const aliasDeleteResult = await accountDb.deleteAlias(accountId, alias.address);
        if (aliasDeleteResult.isErr()) return err(c, 500, "Internal Server Error");
        const aliasAuditResult = await auditDb.saveAuditEvent({
          accountId, userId, action: "deleted", resourceType: "alias", resourceId: alias.address,
          before: { address: alias.address }, after: null,
        });
        if (aliasAuditResult.isErr()) {
          logger.warn("Audit write failed for cascaded alias deletion, proceeding", { code: "api.audit.alias_cascade_delete_failed", accountId, address: alias.address, error: aliasAuditResult.error });
        }
      }

      const deleteResult = await accountDb.deleteDomain(accountId, domain.domain);
      if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");

      const domainAuditResult = await auditDb.saveAuditEvent({
        accountId, userId, action: "deleted", resourceType: "domain", resourceId: domain.domain,
        before: { domain: domain.domain }, after: null,
      });
      if (domainAuditResult.isErr()) {
        logger.warn("Audit write failed for domain deletion, proceeding", { code: "api.audit.domain_delete_failed", accountId, domain: domain.domain, error: domainAuditResult.error });
      }

      return new Response(null, { status: 204 });
    });
  }
}
