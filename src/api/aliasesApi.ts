import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { DateTime } from "luxon";
import { randomUUID } from "crypto";
import { ok as neverthrowOk, err as neverthrowErr } from "neverthrow";
import type { Result } from "neverthrow";
import type { DbError } from "../errors.js";
import type { VerifiedForwardingAddress } from "../types/index.js";
import { zParse } from "./validate.js";
import { toApiAlias, toApiAliasSender, toApiForwardingAddress } from "./transform.js";
import { CreateAliasRequest, UpdateAliasRequest, CreateSenderRequest, UpdateSenderRequest, CreateForwardingAddressRequest, VerifyForwardingAddressRequest } from "./requests.js";
import {
  Alias as AliasSchema, AliasSender as AliasSenderSchema,
  VerifiedForwardingAddress as VerifiedForwardingAddressSchema,
  ListAliasesResponse, ListSendersResponse,
  ListForwardingAddressesResponse,
  ErrorCode,
} from "./schemas.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";
import type { VerificationMailer, AppEnv } from "./app.js";

type ErrorCodeLiteral = z.infer<typeof ErrorCode>;

export interface AliasesApiDeps {
  accountDb: AccountDatabase;
  logger: Logger;
  verificationMailer: VerificationMailer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authz: (permission: string, resourceUri: string | ((c: Context<AppEnv>) => string)) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  err: (c: Context<AppEnv>, status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 501 | 503, title: string, errorCode?: ErrorCodeLiteral, details?: unknown) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  route: (config: any) => any;
}

// Mirrors processor.ts's autoApprove — a sender disposition recorded for an address
// implies that address is a recognised alias, so the Alias record must exist alongside it.
export async function ensureAliasExists(accountDb: AccountDatabase, accountId: string, address: string, idempotencyKey: string): Promise<Result<void, DbError>> {
  const filteringResult = await accountDb.getAccountFilteringConfig(accountId);
  if (filteringResult.isErr()) return neverthrowErr(filteringResult.error);
  const defaultUnknownSenderPolicy = filteringResult.value?.defaultUnknownSenderPolicy ?? "quarantine_visible";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerAliasesRoutes(app: OpenAPIHono<any>, deps: AliasesApiDeps): void {
  const { accountDb, logger, verificationMailer, authz, err, route } = deps;

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
  // Verified forwarding addresses  —  /accounts/:accountId/forwarding-addresses
  // -------------------------------------------------------------------------

  app.openapi(route({
    method: "get",
    path: "/accounts/{accountId}/forwarding-addresses",
    tags: ["Forwarding Addresses"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("forwarding-addresses:read", c => `accounts/${c.req.param("accountId")!}/forwarding-addresses`)] as const,
    responses: { 200: { content: { "application/json": { schema: ListForwardingAddressesResponse } }, description: "List forwarding addresses" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const addressesResult = await accountDb.listVerifiedForwardingAddresses(accountId);
    if (addressesResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json({ forwardingAddresses: addressesResult.value.map(toApiForwardingAddress) }, 200);
  });

  app.openapi(route({
    method: "post",
    path: "/accounts/{accountId}/forwarding-addresses",
    tags: ["Forwarding Addresses"],
    request: { params: z.object({ accountId: z.string() }) },
    middleware: [authz("forwarding-addresses:write", c => `accounts/${c.req.param("accountId")!}/forwarding-addresses`)] as const,
    responses: { 201: { content: { "application/json": { schema: VerifiedForwardingAddressSchema } }, description: "Forwarding address created" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const body = await zParse(CreateForwardingAddressRequest, c.req.raw);

    const existingResult = await accountDb.getVerifiedForwardingAddress(accountId, body.address);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    const existing = existingResult.value;
    if (existing?.status === "verified") return c.json(toApiForwardingAddress(existing), 201);

    const now = DateTime.utc().toISO()!;
    const addr: VerifiedForwardingAddress = {
      id: body.address,
      accountId,
      address: body.address,
      status: "pending",
      token: randomUUID(),
      createdAt: existing?.createdAt ?? now,
      ...(existing?.verifiedAt !== undefined ? { verifiedAt: existing.verifiedAt } : {}),
    };
    // SES first — send verification email before persisting the address so a
    // mailer failure never leaves a pending record the user can't re-trigger.
    if (verificationMailer) {
      const verifyResult = await verificationMailer.sendForwardVerification(accountId, addr.address, addr.token);
      if (verifyResult.isErr()) {
        logger.warn("Failed to send forwarding address verification email. The SES send call returned an error. The user won't receive the verification link.", { code: "forwarding.verification_email_failed", accountId, address: addr.address, error: verifyResult.error });
        return err(c, 422, "Failed to send verification email. Please try again.");
      }
    }

    const saveResult = await accountDb.saveVerifiedForwardingAddress(addr);
    if (saveResult.isErr()) return err(c, 500, "Internal Server Error");

    return c.json(toApiForwardingAddress(addr), 201);
  });

  app.openapi(route({
    method: "post",
    path: "/accounts/{accountId}/forwarding-addresses/{address}/verify",
    tags: ["Forwarding Addresses"],
    request: { params: z.object({ accountId: z.string(), address: z.string() }) },
    middleware: [authz("forwarding-addresses:write", c => `accounts/${c.req.param("accountId")!}/forwarding-addresses/${c.req.param("address")!}`)] as const,
    responses: { 200: { content: { "application/json": { schema: VerifiedForwardingAddressSchema } }, description: "Address verified" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
    const body = await zParse(VerifyForwardingAddressRequest, c.req.raw);

    const existingResult = await accountDb.getVerifiedForwardingAddress(accountId, address);
    if (existingResult.isErr()) return err(c, 500, "Internal Server Error");
    const existing = existingResult.value;
    if (!existing) return err(c, 404, "Forwarding address not found", "FORWARDING_ADDRESS_NOT_FOUND");
    if (existing.status === "verified") return c.json(toApiForwardingAddress(existing), 200);
    if (existing.token !== body.token) return err(c, 400, "Invalid token", "INVALID_TOKEN");

    const verified: VerifiedForwardingAddress = { ...existing, status: "verified", verifiedAt: DateTime.utc().toISO()! };
    const saveResult = await accountDb.saveVerifiedForwardingAddress(verified);
    if (saveResult.isErr()) return err(c, 500, "Internal Server Error");
    return c.json(toApiForwardingAddress(verified), 200);
  });

  app.openapi(route({
    method: "delete",
    path: "/accounts/{accountId}/forwarding-addresses/{address}",
    tags: ["Forwarding Addresses"],
    request: { params: z.object({ accountId: z.string(), address: z.string() }) },
    middleware: [authz("forwarding-addresses:write", c => `accounts/${c.req.param("accountId")!}/forwarding-addresses/${c.req.param("address")!}`)] as const,
    responses: { 204: { description: "Forwarding address deleted" } },
  }), async (c) => {
    const accountId = c.req.param("accountId")!;
    const address = decodeURIComponent(c.req.param("address")!).toLowerCase();
    const deleteResult = await accountDb.deleteVerifiedForwardingAddress(accountId, address);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });
}
