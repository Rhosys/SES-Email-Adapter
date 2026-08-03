import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { DateTime } from "luxon";
import type { AccountDatabase } from "../database/account-database.js";
import type { ProviderAdapter } from "../external-exchanges/provider-adapter.js";
import type { EncryptionManager } from "../secrets/encryption-manager.js";
import type { Logger } from "../logger.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";
import type { SignalQueue } from "../messaging/signal-queue.js";
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
  exchangeId: z.string(),
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
  const result: Record<string, unknown> = {
    exchangeId: emx.id,
    accountId: emx.accountId,
    platform: emx.platform,
    emailAddress: emx.emailAddress,
    status: emx.status,
    syncCursor: emx.syncCursor ?? null,
    lastSyncAt: emx.lastSyncAt ?? null,
    nextSyncTime: emx.nextSyncTime ?? null,
    ...(emx.expiresAt !== undefined ? { expiresAt: emx.expiresAt } : {}),
    ...(emx.providerSubscriptionId !== undefined ? { providerSubscriptionId: emx.providerSubscriptionId } : {}),
    ...(emx.errorReason !== undefined ? { errorReason: emx.errorReason } : {}),
    createdAt: emx.createdAt,
    updatedAt: emx.updatedAt,
  };
  if (emx.imapConfig) {
    const { encryptedPassword: _, ...safeImap } = emx.imapConfig;
    result.imapConfig = safeImap;
  }
  if (emx.jmapConfig) {
    const { sessionUrl, username } = emx.jmapConfig;
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
    private readonly signalQueue: SignalQueue,
    private readonly logger: Logger,
  ) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { accountDb, adapters, getProviderToken, encryptionManager, signalQueue, logger } = this;

    /** Fire-and-forget: trigger immediate dispatch cycle so the new/updated exchange gets its first sync */
    const triggerDispatch = () => { void signalQueue.send("emx_dispatch", {}); };

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

        // Alias conflict check: reject if another account already owns this email address
        const aliasCheck = await accountDb.getAliasByGlobalAddress(imapConfig.username);
        if (aliasCheck.isOk() && aliasCheck.value && aliasCheck.value.accountId !== accountId) {
          return err(c, 409, "Email address is already registered to another account");
        }

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
            syncCursor: "", lastSyncAt: DateTime.utc().toISO()!,
          });
          if (result.isErr()) { logger.error("Failed to create IMAP exchange record", { code: "api.emx.imap.create_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
          logger.error("Failed to activate IMAP exchange", { code: "api.emx.imap.activate_failed", error: activateResult.error });
          return c.json(serializeEmx(result.value), 201);
        }

        const { syncCursor, expiresAt } = activateResult.value;
        const now = DateTime.utc().toISO()!;
        const result = await accountDb.createImapExchange(accountId, {
          emailAddress: imapConfig.username, status: "active",
          imapConfig: { host: imapConfig.host, tlsConfig: imapConfig.tlsConfig, username: imapConfig.username, encryptedPassword },
          syncCursor, lastSyncAt: now, nextSyncTime: expiresAt,
        });
        if (result.isErr()) { logger.error("Failed to create IMAP exchange record", { code: "api.emx.imap.create_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
        await accountDb.ensureAlias(accountId, imapConfig.username, "allow_all", aliasCheck.isOk() ? aliasCheck.value : undefined);
        triggerDispatch();
        return c.json(serializeEmx(result.value), 201);
      }

      // --- JMAP branch: uses credentials, no OAuth ---
      const jmapBody = CreateJmapExchangeRequest.safeParse(rawBody);
      if (jmapBody.success) {
        const { jmapConfig } = jmapBody.data;
        const adapter = adapters["jmap"];
        if (!adapter) return err(c, 422, "Unsupported platform");

        // Alias conflict check: reject if another account already owns this email address
        const aliasCheck = await accountDb.getAliasByGlobalAddress(jmapConfig.username);
        if (aliasCheck.isOk() && aliasCheck.value && aliasCheck.value.accountId !== accountId) {
          return err(c, 409, "Email address is already registered to another account");
        }

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
            syncCursor: "", lastSyncAt: DateTime.utc().toISO()!,
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
          syncCursor, lastSyncAt: DateTime.utc().toISO()!, nextSyncTime: expiresAt,
        });
        if (result.isErr()) { logger.error("Failed to create JMAP exchange record", { code: "api.emx.jmap.create_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
        await accountDb.ensureAlias(accountId, jmapConfig.username, "allow_all", aliasCheck.isOk() ? aliasCheck.value : undefined);
        triggerDispatch();
        return c.json(serializeEmx(result.value), 201);
      }

      // --- OAuth branch (Gmail/Outlook) ---
      const body = CreateExternalExchangeRequest.parse(rawBody);

      const adapter = adapters[body.platform];
      if (!adapter) return err(c, 422, "Unsupported platform");

      // Alias conflict check: reject if another account already owns this email address
      const oauthAliasCheck = await accountDb.getAliasByGlobalAddress(body.emailAddress);
      if (oauthAliasCheck.isOk() && oauthAliasCheck.value && oauthAliasCheck.value.accountId !== accountId) {
        return err(c, 409, "Email address is already registered to another account");
      }

      // Idempotency: find existing exchange for same platform + emailAddress
      const listResult = await accountDb.listExternalExchanges(accountId);
      const existing = listResult.isOk()
        ? listResult.value.find((e) => e.platform === body.platform && e.emailAddress === body.emailAddress)
        : undefined;

      const connectionId = body.platform === "gmail" ? "google" : "microsoft";
      let token: string;
      try {
        token = await getProviderToken(accountId, connectionId);
      } catch (e) {
        logger.error("Failed to get provider token for activation", { code: "api.emx.create.token_failed", error: e });
        if (existing) {
          const updateResult = await accountDb.updateExternalExchange(accountId, existing.id, { status: "activation_failed", errorReason: "Failed to obtain provider token", consecutiveFailures: 0 });
          if (updateResult.isErr()) { logger.error("Failed to update exchange record", { code: "api.emx.create_failed", error: updateResult.error }); return err(c, 500, "Internal Server Error"); }
          return c.json(serializeEmx(updateResult.value), 200);
        }
        const result = await accountDb.createExternalExchange(accountId, { platform: body.platform, emailAddress: body.emailAddress, status: "activation_failed", errorReason: "Failed to obtain provider token", syncCursor: "", lastSyncAt: DateTime.utc().toISO()! });
        if (result.isErr()) { logger.error("Failed to create exchange record", { code: "api.emx.create_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
        return c.json(serializeEmx(result.value), 201);
      }

      const emxStub = { id: existing?.id ?? "", accountId, platform: body.platform, emailAddress: body.emailAddress, status: "active" as const, createdAt: "", updatedAt: "" };
      const activateResult = await adapter.activate(token, emxStub);
      if (activateResult.isErr()) {
        const errorReason = String(activateResult.error.cause);
        if (existing) {
          const updateResult = await accountDb.updateExternalExchange(accountId, existing.id, { status: "activation_failed", errorReason, consecutiveFailures: 0 });
          if (updateResult.isErr()) { logger.error("Failed to update exchange record", { code: "api.emx.create_failed", error: updateResult.error }); return err(c, 500, "Internal Server Error"); }
          logger.error("Failed to activate exchange", { code: "api.emx.activate_failed", error: activateResult.error });
          return c.json(serializeEmx(updateResult.value), 200);
        }
        const result = await accountDb.createExternalExchange(accountId, { platform: body.platform, emailAddress: body.emailAddress, status: "activation_failed", errorReason, syncCursor: "", lastSyncAt: DateTime.utc().toISO()! });
        if (result.isErr()) { logger.error("Failed to create exchange record", { code: "api.emx.create_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
        logger.error("Failed to activate exchange", { code: "api.emx.activate_failed", error: activateResult.error });
        return c.json(serializeEmx(result.value), 201);
      }

      const { syncCursor, expiresAt, providerSubscriptionId } = activateResult.value;
      if (existing) {
        const updateResult = await accountDb.updateExternalExchange(accountId, existing.id, { status: "active", syncCursor, expiresAt, providerSubscriptionId, errorReason: undefined, consecutiveFailures: 0 });
        if (updateResult.isErr()) { logger.error("Failed to update exchange record", { code: "api.emx.create_failed", error: updateResult.error }); return err(c, 500, "Internal Server Error"); }
        await accountDb.ensureAlias(accountId, body.emailAddress, "allow_all", oauthAliasCheck.isOk() ? oauthAliasCheck.value : undefined);
        triggerDispatch();
        return c.json(serializeEmx(updateResult.value), 200);
      }
      const result = await accountDb.createExternalExchange(accountId, { platform: body.platform, emailAddress: body.emailAddress, status: "active", syncCursor, lastSyncAt: DateTime.utc().toISO()!, expiresAt, providerSubscriptionId });
      if (result.isErr()) { logger.error("Failed to create exchange record", { code: "api.emx.create_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
      await accountDb.ensureAlias(accountId, body.emailAddress, "allow_all", oauthAliasCheck.isOk() ? oauthAliasCheck.value : undefined);
      triggerDispatch();
      return c.json(serializeEmx(result.value), 201);
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

        // Connection test via adapter.activate — validates session URL, auth, and mailbox discovery
        const jmapAdapter = adapters["jmap"];
        if (!jmapAdapter) return err(c, 422, "Unsupported platform");
        const tempEmx: ExternalMailExchange = {
          ...emx,
          jmapConfig: { ...emx.jmapConfig, sessionUrl: mergedSessionUrl, username: mergedUsername, encryptedPassword: testPassword },
        };
        const testResult = await jmapAdapter.activate("", tempEmx);
        if (testResult.isErr()) {
          const reason = String(testResult.error.cause).slice(0, 512);
          logger.warn("JMAP connection test failed during PATCH", { code: "api.emx.patch.jmap.connection_test_failed", emxId, error: testResult.error });
          return err(c, 422, reason);
        }

        // Connection test passed — persist the full merged config (activate() updates apiUrl, downloadUrl, jmapAccountId, inboxId in-place)
        const encryptedPassword = jmapBody.data.jmapConfig.password !== undefined
          ? encryptionManager.encrypt(jmapBody.data.jmapConfig.password)
          : emx.jmapConfig.encryptedPassword;

        const { syncCursor: newSyncCursor, expiresAt: newExpiresAt } = testResult.value;
        const patchNow = DateTime.utc().toISO()!;

        const updateResult = await accountDb.updateExternalExchangeJmapConfig(accountId, emxId, {
          sessionUrl: tempEmx.jmapConfig!.sessionUrl,
          username: tempEmx.jmapConfig!.username,
          encryptedPassword,
          apiUrl: tempEmx.jmapConfig!.apiUrl,
          downloadUrl: tempEmx.jmapConfig!.downloadUrl,
          jmapAccountId: tempEmx.jmapConfig!.jmapAccountId,
          inboxId: tempEmx.jmapConfig!.inboxId,
        });
        if (updateResult.isErr()) { logger.error("Failed to update JMAP exchange", { code: "api.emx.patch.jmap_failed", error: updateResult.error }); return err(c, 500, "Internal Server Error"); }

        // Always persist fresh syncCursor and timing from the activation test
        await accountDb.updateExternalExchange(accountId, emxId, { syncCursor: newSyncCursor, lastSyncAt: patchNow, nextSyncTime: newExpiresAt });

        // Ensure alias exists for the EMX email address (may have been missed or deleted)
        await accountDb.ensureAlias(accountId, emx.emailAddress, "allow_all");

        // Re-activate if previously failed — connection test just proved creds work
        if (emx.status === "activation_failed") {
          await accountDb.updateExternalExchange(accountId, emxId, { status: "active", nextSyncTime: newExpiresAt, errorReason: undefined, consecutiveFailures: 0 });
        }

        triggerDispatch();
        const freshResult = await accountDb.getExternalExchange(accountId, emxId);
        if (freshResult.isOk() && freshResult.value) { return c.json(serializeEmx(freshResult.value), 200); }
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

      // Connection test via adapter.activate — validates host, TLS, auth, and INBOX access
      const imapAdapter = adapters["imap"];
      if (!imapAdapter) return err(c, 422, "Unsupported platform");
      const tempEmx: ExternalMailExchange = {
        ...emx,
        imapConfig: { host: mergedHost, tlsConfig: mergedTlsConfig, username: mergedUsername, encryptedPassword: testPassword },
      };
      const testResult = await imapAdapter.activate("", tempEmx);
      if (testResult.isErr()) {
        const reason = String(testResult.error.cause).slice(0, 512);
        logger.warn("IMAP connection test failed during PATCH", { code: "api.emx.patch.connection_test_failed", emxId, error: testResult.error });
        return err(c, 422, reason);
      }

      // Connection test passed — persist the full merged config + updated sync state
      const encryptedPassword = body.imapConfig.password !== undefined
        ? encryptionManager.encrypt(body.imapConfig.password)
        : emx.imapConfig.encryptedPassword;

      const { syncCursor: newSyncCursor, expiresAt: newExpiresAt } = testResult.value;
      const patchNow = DateTime.utc().toISO()!;

      const updateResult = await accountDb.updateExternalExchangeImapConfig(accountId, emxId, {
        host: mergedHost, tlsConfig: mergedTlsConfig, username: mergedUsername, encryptedPassword,
      });
      if (updateResult.isErr()) { logger.error("Failed to update exchange", { code: "api.emx.patch_failed", error: updateResult.error }); return err(c, 500, "Internal Server Error"); }

      // Always persist fresh syncCursor and timing from the activation test
      await accountDb.updateExternalExchange(accountId, emxId, { syncCursor: newSyncCursor, lastSyncAt: patchNow, nextSyncTime: newExpiresAt });

      // Ensure alias exists for the EMX email address (may have been missed or deleted)
      await accountDb.ensureAlias(accountId, emx.emailAddress, "allow_all");

      // Re-activate if previously failed — connection test just proved creds work
      if (emx.status === "activation_failed") {
        await accountDb.updateExternalExchange(accountId, emxId, { status: "active", nextSyncTime: newExpiresAt, errorReason: undefined, consecutiveFailures: 0 });
      }

      triggerDispatch();
      const freshResult = await accountDb.getExternalExchange(accountId, emxId);
      if (freshResult.isOk() && freshResult.value) { return c.json(serializeEmx(freshResult.value), 200); }
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
