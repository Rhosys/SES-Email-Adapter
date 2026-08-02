import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { zParse } from "./validate.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { ProviderAdapter } from "../external-exchanges/provider-adapter.js";
import { createImapClient } from "../external-exchanges/imap-adapter.js";
import { buildBasicAuth, fetchSession } from "../external-exchanges/jmap-adapter.js";
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

const CreateJmapExchangeRequest = z.object({
  platform: z.literal("jmap"),
  jmapConfig: z.object({
    sessionUrl: z.string().url().max(2048),
    username: z.string().max(256),
    password: z.string().max(256),
  }),
});

const PatchImapExchangeRequest = z.object({
  imapConfig: z.object({
    host: z.string().max(253).optional(),
    tlsConfig: z.enum(["TLS", "DISABLED"]).optional(),
    username: z.string().max(256).optional(),
    password: z.string().max(256).optional(),
  }),
});

const PatchJmapExchangeRequest = z.object({
  jmapConfig: z.object({
    sessionUrl: z.string().url().max(2048).optional(),
    username: z.string().max(256).optional(),
    password: z.string().max(256).optional(),
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
  const { imapConfig, jmapConfig, ...rest } = emx;
  const result: Record<string, unknown> = { ...rest };
  if (imapConfig) {
    const { encryptedPassword: _, ...safeImap } = imapConfig;
    result.imapConfig = safeImap;
  }
  if (jmapConfig) {
    const { sessionUrl, username } = jmapConfig;
    result.jmapConfig = { sessionUrl, username };
  }
  return result;
}

export class ExternalExchangesApi {
  constructor(
    private readonly accountDb: AccountDatabase,
    private readonly adapters: Record<string, ProviderAdapter>,
    private readonly getProviderToken: (accountId: string, connectionId: string) => Promise<string>,
    private readonly encryptionManager: EncryptionManager,
    private readonly logger: Logger,
  ) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { accountDb, adapters, getProviderToken, encryptionManager, logger } = this;

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
      const rawBody = await c.req.json();

      // --- IMAP branch: uses credentials, no OAuth ---
      const imapBody = CreateImapExchangeRequest.safeParse(rawBody);
      if (imapBody.success) {
        const { imapConfig } = imapBody.data;
        const adapter = adapters["imap"];
        if (!adapter) return err(c, 422, "Unsupported platform");

        const encryptedPassword = encryptionManager.encrypt(imapConfig.password);

        // Build temp EMX with raw password for activation (adapter tests connection with it)
        const tempEmx: ExternalMailExchange = {
          id: "", accountId, platform: "imap", emailAddress: imapConfig.username,
          status: "active", createdAt: "", updatedAt: "",
          imapConfig: { host: imapConfig.host, tlsConfig: imapConfig.tlsConfig, username: imapConfig.username, encryptedPassword: imapConfig.password },
        };

        const activateResult = await adapter.activate("", tempEmx);
        if (activateResult.isErr()) {
          const errorReason = String(activateResult.error.cause);
          const result = await accountDb.createImapExchange(accountId, {
            emailAddress: imapConfig.username, status: "activation_failed", errorReason,
            imapConfig: { host: imapConfig.host, tlsConfig: imapConfig.tlsConfig, username: imapConfig.username, encryptedPassword },
          });
          if (result.isErr()) { logger.error("Failed to create IMAP exchange record", { code: "api.emx.imap.create_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
          logger.error("Failed to activate IMAP exchange", { code: "api.emx.imap.activate_failed", error: activateResult.error });
          return c.json(serializeEmx(result.value), 201);
        }

        const { syncCursor, expiresAt } = activateResult.value;
        const result = await accountDb.createImapExchange(accountId, {
          emailAddress: imapConfig.username, status: "active",
          imapConfig: { host: imapConfig.host, tlsConfig: imapConfig.tlsConfig, username: imapConfig.username, encryptedPassword },
          syncCursor, nextSyncTime: expiresAt,
        });
        if (result.isErr()) { logger.error("Failed to create IMAP exchange record", { code: "api.emx.imap.create_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
        return c.json(serializeEmx(result.value), 201);
      }

      // --- JMAP branch: uses credentials, no OAuth ---
      const jmapBody = CreateJmapExchangeRequest.safeParse(rawBody);
      if (jmapBody.success) {
        const { jmapConfig } = jmapBody.data;
        const adapter = adapters["jmap"];
        if (!adapter) return err(c, 422, "Unsupported platform");

        const encryptedPassword = encryptionManager.encrypt(jmapConfig.password);

        // Build temp EMX with raw password for activation (adapter tests connection with it)
        const tempEmx: ExternalMailExchange = {
          id: "", accountId, platform: "jmap", emailAddress: jmapConfig.username,
          status: "active", createdAt: "", updatedAt: "",
          jmapConfig: { sessionUrl: jmapConfig.sessionUrl, username: jmapConfig.username, encryptedPassword: jmapConfig.password, apiUrl: "", downloadUrl: "", jmapAccountId: "", inboxId: "" },
        };

        const activateResult = await adapter.activate("", tempEmx);
        if (activateResult.isErr()) {
          const errorReason = String(activateResult.error.cause);
          const result = await accountDb.createJmapExchange(accountId, {
            emailAddress: jmapConfig.username, status: "activation_failed", errorReason,
            jmapConfig: { sessionUrl: jmapConfig.sessionUrl, username: jmapConfig.username, encryptedPassword, apiUrl: "", downloadUrl: "", jmapAccountId: "", inboxId: "" },
          });
          if (result.isErr()) { logger.error("Failed to create JMAP exchange record", { code: "api.emx.jmap.create_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
          logger.error("Failed to activate JMAP exchange", { code: "api.emx.jmap.activate_failed", error: activateResult.error });
          return c.json(serializeEmx(result.value), 201);
        }

        const { syncCursor, expiresAt } = activateResult.value;
        // activate() populates apiUrl, downloadUrl, jmapAccountId, inboxId on tempEmx.jmapConfig
        const result = await accountDb.createJmapExchange(accountId, {
          emailAddress: jmapConfig.username, status: "active",
          jmapConfig: { sessionUrl: jmapConfig.sessionUrl, username: jmapConfig.username, encryptedPassword, apiUrl: tempEmx.jmapConfig!.apiUrl, downloadUrl: tempEmx.jmapConfig!.downloadUrl, jmapAccountId: tempEmx.jmapConfig!.jmapAccountId, inboxId: tempEmx.jmapConfig!.inboxId },
          syncCursor, nextSyncTime: expiresAt,
        });
        if (result.isErr()) { logger.error("Failed to create JMAP exchange record", { code: "api.emx.jmap.create_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
        return c.json(serializeEmx(result.value), 201);
      }

      // --- OAuth branch (Gmail/Outlook) ---
      const body = CreateExternalExchangeRequest.parse(rawBody);

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

    // PATCH /accounts/:accountId/external-exchanges/:emxId
    app.openapi(route({
      method: "patch",
      path: "/accounts/{accountId}/external-exchanges/{emxId}",
      tags: ["External Exchanges"],
      request: { params: z.object({ accountId: z.string(), emxId: z.string() }) },
      middleware: [authz("external-exchanges:write", c => `accounts/${c.req.param("accountId")!}/external-exchanges/${c.req.param("emxId")!}`)] as const,
      responses: {
        200: { content: { "application/json": { schema: ExternalExchangeResponse } }, description: "Exchange updated" },
      },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const emxId = c.req.param("emxId")!;
      const rawBody = await c.req.json();

      // Fetch existing EMX
      const getResult = await accountDb.getExternalExchange(accountId, emxId);
      if (getResult.isErr()) { logger.error("Failed to get exchange for patch", { code: "api.emx.patch.get_failed", error: getResult.error }); return err(c, 500, "Internal Server Error"); }
      const emx = getResult.value;
      if (!emx) return err(c, 404, "Exchange not found");

      // --- JMAP PATCH branch ---
      const jmapBody = PatchJmapExchangeRequest.safeParse(rawBody);
      if (jmapBody.success) {
        if (emx.platform !== "jmap" || !emx.jmapConfig) return err(c, 404, "Exchange not found");

        const mergedSessionUrl = jmapBody.data.jmapConfig.sessionUrl ?? emx.jmapConfig.sessionUrl;
        const mergedUsername = jmapBody.data.jmapConfig.username ?? emx.jmapConfig.username;

        let testPassword: string;
        if (jmapBody.data.jmapConfig.password !== undefined) {
          testPassword = jmapBody.data.jmapConfig.password;
        } else {
          try {
            testPassword = encryptionManager.decrypt(emx.jmapConfig.encryptedPassword);
          } catch (e) {
            logger.error("Failed to decrypt existing JMAP password for connection test", { code: "api.emx.patch.jmap.decrypt_failed", emxId, error: e });
            return err(c, 500, "Internal Server Error");
          }
        }

        // Connection test with merged config (10s timeout)
        const auth = buildBasicAuth(mergedUsername, testPassword);
        const sessionResult = await fetchSession(mergedSessionUrl, auth, 10_000);
        if (sessionResult.isErr()) {
          const reason = String(sessionResult.error.cause);
          logger.warn("JMAP connection test failed during PATCH", { code: "api.emx.patch.jmap.connection_test_failed", emxId, error: sessionResult.error });
          return err(c, 422, reason);
        }

        // Connection test passed — persist updated fields
        const updateFields: Record<string, unknown> = {};
        if (jmapBody.data.jmapConfig.sessionUrl !== undefined) updateFields.sessionUrl = jmapBody.data.jmapConfig.sessionUrl;
        if (jmapBody.data.jmapConfig.username !== undefined) updateFields.username = jmapBody.data.jmapConfig.username;
        if (jmapBody.data.jmapConfig.password !== undefined) updateFields.encryptedPassword = encryptionManager.encrypt(jmapBody.data.jmapConfig.password);

        const updateResult = await accountDb.updateExternalExchangeJmapConfig(accountId, emxId, updateFields);
        if (updateResult.isErr()) { logger.error("Failed to update JMAP exchange", { code: "api.emx.patch.jmap_failed", error: updateResult.error }); return err(c, 500, "Internal Server Error"); }

        return c.json(serializeEmx(updateResult.value), 200);
      }

      // --- IMAP PATCH branch ---
      const body = PatchImapExchangeRequest.parse(rawBody);

      if (emx.platform !== "imap" || !emx.imapConfig) return err(c, 404, "Exchange not found");

      // Merge config: new values where provided, existing where not
      const mergedHost = body.imapConfig.host ?? emx.imapConfig.host;
      const mergedTlsConfig = body.imapConfig.tlsConfig ?? emx.imapConfig.tlsConfig;
      const mergedUsername = body.imapConfig.username ?? emx.imapConfig.username;

      // Password handling: decrypt existing or use new raw password for connection test
      let testPassword: string;
      if (body.imapConfig.password !== undefined) {
        testPassword = body.imapConfig.password;
      } else {
        try {
          testPassword = encryptionManager.decrypt(emx.imapConfig.encryptedPassword);
        } catch (e) {
          logger.error("Failed to decrypt existing password for connection test", { code: "api.emx.patch.decrypt_failed", emxId, error: e });
          return err(c, 500, "Internal Server Error");
        }
      }

      // Connection test with merged config (10s timeout)
      const client = createImapClient({ host: mergedHost, tlsConfig: mergedTlsConfig, username: mergedUsername, password: testPassword, timeout: 10_000 });
      try {
        await client.connect();
        const lock = await client.getMailboxLock("INBOX");
        lock.release();
      } catch (e) {
        const reason = e instanceof Error ? e.message.slice(0, 512) : "Connection test failed";
        logger.warn("IMAP connection test failed during PATCH", { code: "api.emx.patch.connection_test_failed", emxId, error: e });
        return err(c, 422, reason);
      } finally {
        try { await client.logout(); } catch { /* best-effort logout */ }
      }

      // Connection test passed — persist updated fields
      const updateFields: Record<string, unknown> = {};
      if (body.imapConfig.host !== undefined) updateFields.host = body.imapConfig.host;
      if (body.imapConfig.tlsConfig !== undefined) updateFields.tlsConfig = body.imapConfig.tlsConfig;
      if (body.imapConfig.username !== undefined) updateFields.username = body.imapConfig.username;
      if (body.imapConfig.password !== undefined) updateFields.encryptedPassword = encryptionManager.encrypt(body.imapConfig.password);

      const updateResult = await accountDb.updateExternalExchangeImapConfig(accountId, emxId, updateFields);
      if (updateResult.isErr()) { logger.error("Failed to update exchange", { code: "api.emx.patch_failed", error: updateResult.error }); return err(c, 500, "Internal Server Error"); }

      return c.json(serializeEmx(updateResult.value), 200);
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
