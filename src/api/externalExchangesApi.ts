import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { zParse } from "./validate.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { ProviderAdapter } from "../external-exchanges/provider-adapter.js";
import type { EncryptionManager } from "../secrets/encryption-manager.js";
import type { Logger } from "../logger.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";
import { EMX_PLATFORMS, type ExternalMailExchange } from "../types/index.js";

const CreateExternalExchangeRequest = z.object({
  platform: z.enum(EMX_PLATFORMS),
  emailAddress: z.string().email(),
});

const CreateImapExchangeRequest = z.object({
  platform: z.literal("imap"),
  imapConfig: z.object({
    host: z.string().max(253),
    tlsConfig: z.enum(["TLS", "DISABLED"]),
    username: z.string().max(256),
    password: z.string().max(256),
  }),
});

const ExternalExchangeResponse = z.object({
  id: z.string(),
  accountId: z.string(),
  platform: z.enum(EMX_PLATFORMS),
  emailAddress: z.string(),
  status: z.string(),
  syncCursor: z.string().optional(),
  expiresAt: z.string().optional(),
  lastSyncAt: z.string().optional(),
  providerSubscriptionId: z.string().optional(),
  errorReason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ListExternalExchangesResponse = z.object({
  exchanges: z.array(ExternalExchangeResponse),
});

function serializeEmx(emx: ExternalMailExchange) {
  if (!emx.imapConfig) return emx;
  const { encryptedPassword: _, ...safeConfig } = emx.imapConfig;
  return { ...emx, imapConfig: safeConfig };
}

export class ExternalExchangesApi {
  constructor(
    private readonly accountDb: AccountDatabase,
    private readonly adapters: Record<string, ProviderAdapter>,
    private readonly getProviderToken: (accountId: string, connectionId: string) => Promise<string>,
    private readonly logger: Logger,
  ) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { accountDb, adapters, getProviderToken, logger } = this;

    // GET /accounts/:accountId/external-exchanges
    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/external-exchanges",
      tags: ["External Exchanges"],
      request: { params: z.object({ accountId: z.string() }) },
      middleware: [authz("external-exchanges:read", c => `accounts/${c.req.param("accountId")!}/external-exchanges`)] as const,
      responses: { 200: { content: { "application/json": { schema: ListExternalExchangesResponse } }, description: "List external exchanges" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const result = await accountDb.listExternalExchanges(accountId);
      if (result.isErr()) { logger.error("Failed to list external exchanges", { code: "api.emx.list_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
      return c.json({ exchanges: result.value.map(serializeEmx) }, 200);
    });

    // POST /accounts/:accountId/external-exchanges
    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/external-exchanges",
      tags: ["External Exchanges"],
      request: { params: z.object({ accountId: z.string() }) },
      middleware: [authz("external-exchanges:write", c => `accounts/${c.req.param("accountId")!}/external-exchanges`)] as const,
      responses: { 201: { content: { "application/json": { schema: ExternalExchangeResponse } }, description: "Exchange created" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const body = await zParse(CreateExternalExchangeRequest, c.req.raw);

      const adapter = adapters[body.platform];
      if (!adapter) return err(c, 422, "Unsupported platform");

      const connectionId = body.platform === "gmail" ? "google" : "microsoft";
      let token: string;
      try {
        token = await getProviderToken(accountId, connectionId);
      } catch (e) {
        logger.error("Failed to get provider token for activation", { code: "api.emx.create.token_failed", error: e });
        const result = await accountDb.createExternalExchange(accountId, { platform: body.platform, emailAddress: body.emailAddress, status: "activation_failed", errorReason: "Failed to obtain provider token" });
        if (result.isErr()) { logger.error("Failed to create exchange record", { code: "api.emx.create_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
        return c.json(result.value, 201);
      }

      const emxStub = { id: "", accountId, platform: body.platform, emailAddress: body.emailAddress, status: "active" as const, createdAt: "", updatedAt: "" };
      const activateResult = await adapter.activate(token, emxStub);
      if (activateResult.isErr()) {
        const errorReason = String(activateResult.error.cause);
        const result = await accountDb.createExternalExchange(accountId, { platform: body.platform, emailAddress: body.emailAddress, status: "activation_failed", errorReason });
        if (result.isErr()) { logger.error("Failed to create exchange record", { code: "api.emx.create_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
        logger.error("Failed to activate exchange", { code: "api.emx.activate_failed", error: activateResult.error });
        return c.json(result.value, 201);
      }

      const { syncCursor, expiresAt, providerSubscriptionId } = activateResult.value;
      const result = await accountDb.createExternalExchange(accountId, { platform: body.platform, emailAddress: body.emailAddress, status: "active", syncCursor, expiresAt, providerSubscriptionId });
      if (result.isErr()) { logger.error("Failed to create exchange record", { code: "api.emx.create_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
      return c.json(result.value, 201);
    });

    // GET /accounts/:accountId/external-exchanges/:emxId
    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/external-exchanges/{emxId}",
      tags: ["External Exchanges"],
      request: { params: z.object({ accountId: z.string(), emxId: z.string() }) },
      middleware: [authz("external-exchanges:read", c => `accounts/${c.req.param("accountId")!}/external-exchanges/${c.req.param("emxId")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: ExternalExchangeResponse } }, description: "Get exchange" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const emxId = c.req.param("emxId")!;
      const result = await accountDb.getExternalExchange(accountId, emxId);
      if (result.isErr()) { logger.error("Failed to get external exchange", { code: "api.emx.get_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
      if (!result.value) return err(c, 404, "Exchange not found");
      return c.json(serializeEmx(result.value), 200);
    });

    // DELETE /accounts/:accountId/external-exchanges/:emxId
    app.openapi(route({
      method: "delete",
      path: "/accounts/{accountId}/external-exchanges/{emxId}",
      tags: ["External Exchanges"],
      request: { params: z.object({ accountId: z.string(), emxId: z.string() }) },
      middleware: [authz("external-exchanges:write", c => `accounts/${c.req.param("accountId")!}/external-exchanges/${c.req.param("emxId")!}`)] as const,
      responses: { 204: { description: "Exchange deleted" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const emxId = c.req.param("emxId")!;
      const getResult = await accountDb.getExternalExchange(accountId, emxId);
      if (getResult.isErr()) { logger.error("Failed to get exchange for delete", { code: "api.emx.delete.get_failed", error: getResult.error }); return err(c, 500, "Internal Server Error"); }
      const emx = getResult.value;
      if (!emx) return err(c, 404, "Exchange not found");

      // Only deactivate with provider if the exchange was successfully activated
      if (emx.status === "active") {
        const adapter = adapters[emx.platform];
        if (adapter) {
          const connectionId = emx.platform === "gmail" ? "google" : "microsoft";
          let token: string;
          try {
            token = await getProviderToken(accountId, connectionId);
          } catch (e) {
            logger.warn("Failed to get provider token for deactivation — proceeding with local deletion", { code: "api.emx.deactivate.token_failed", emxId, error: e });
            token = "";
          }
          if (token) {
            const deactivateResult = await adapter.deactivate(token, emx);
            if (deactivateResult.isErr()) {
              logger.warn("Failed to deactivate exchange with provider — proceeding with local deletion", { code: "api.emx.deactivate_failed", emxId, error: deactivateResult.error });
            }
          }
        }
      }

      const deleteResult = await accountDb.deleteExternalExchange(accountId, emxId);
      if (deleteResult.isErr()) { logger.error("Failed to delete exchange", { code: "api.emx.delete_failed", error: deleteResult.error }); return err(c, 500, "Internal Server Error"); }
      return new Response(null, { status: 204 });
    });
  }
}
