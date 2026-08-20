import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { DateTime } from "luxon";
import type { AccountDatabase } from "../database/account-database.js";
import type { ProviderAdapter } from "../external-exchanges/provider-adapter.js";
import type { EncryptionManager } from "../secrets/encryption-manager.js";
import type { Logger } from "../logger.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";
import type { SignalQueue } from "../messaging/signal-queue.js";
import type { AccessService } from "./accountsApi.js";
import { EMX_PLATFORMS, type ExternalMailExchange } from "../types/index.js";

const CreateExternalExchangeRequest = z.object({
  platform: z.enum(EMX_PLATFORMS),
  // Deliberately no emailAddress: it is resolved from the provider using the caller's own
  // credentials. A client-supplied address would let a caller point an exchange — and the
  // alias that routes outbound mail — at a mailbox it does not own.
  // The Authress identity-connection the caller just linked. The client chose it, so it is
  // the one thing here the server cannot derive on its own.
  connectionId: z.string().max(256).optional(),
});

/**
 * Connection id to use when a client did not send one.
 *
 * This is the one place a connection id is inferred, and only at connect time, where the
 * inference matches what the client would have sent anyway. Every later use reads the value
 * persisted on the exchange — see `exchangeCredentials`.
 */
const DEFAULT_CONNECTION_IDS: Record<string, string> = { gmail: "google", outlook: "microsoft" };

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
    private readonly getLinkedIdentity: AccessService["getLinkedIdentity"],
    private readonly encryptionManager: EncryptionManager,
    private readonly signalQueue: SignalQueue,
    private readonly logger: Logger,
  ) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { accountDb, adapters, getLinkedIdentity, encryptionManager, signalQueue, logger } = this;



    /** Trigger immediate dispatch for a specific exchange — awaited with error logging */
    const triggerDispatch = async (targetAccountId: string, emxId: string) => {
      const result = await signalQueue.send("emx_dispatch", { emxId, accountId: targetAccountId });
      if (result.isErr()) {
        logger.warn("Failed to enqueue emx_dispatch", { code: "api.emx.dispatch_enqueue_failed", emxId, error: result.error });
      }
    };

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
      logger.info("Creating external exchange", { code: "api.emx.create", accountId, platform: rawBody.platform ?? (rawBody.imapConfig ? "imap" : rawBody.jmapConfig ? "jmap" : "unknown") });

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

        const encryptResult = await encryptionManager.encrypt(imapConfig.password);
        if (encryptResult.isErr()) { logger.error("Failed to encrypt IMAP password", { code: "api.emx.imap.encrypt_failed", error: encryptResult.error }); return err(c, 500, "Internal Server Error"); }
        const encryptedPassword = encryptResult.value;

        // Build temp EMX with raw password for activation (adapter tests connection with it)
        const tempEmx: ExternalMailExchange = {
          id: "", accountId, platform: "imap", emailAddress: imapConfig.username,
          status: "active", createdAt: "", updatedAt: "",
          imapConfig: { host: imapConfig.host, tlsConfig: imapConfig.tlsConfig, username: imapConfig.username, encryptedPassword: imapConfig.password },
        };

        const activateResult = await adapter.activate(tempEmx);
        if (activateResult.isErr()) {
          const errorReason = String(activateResult.error.cause);
          const result = await accountDb.createExternalExchange(accountId, {
            platform: "imap", emailAddress: imapConfig.username, status: "activation_failed", errorReason,
            imapConfig: { host: imapConfig.host, tlsConfig: imapConfig.tlsConfig, username: imapConfig.username, encryptedPassword },
            lastSyncAt: DateTime.utc().toISO()!,
          });
          if (result.isErr()) { logger.error("Failed to create IMAP exchange record", { code: "api.emx.imap.create_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
          logger.error("Failed to activate IMAP exchange", { code: "api.emx.imap.activate_failed", error: activateResult.error });
          return c.json(serializeEmx(result.value), 201);
        }

        const { syncCursor, syncState, expiresAt } = activateResult.value;
        const now = DateTime.utc().toISO()!;
        const result = await accountDb.createExternalExchange(accountId, {
          platform: "imap", emailAddress: imapConfig.username, status: "active",
          imapConfig: { host: imapConfig.host, tlsConfig: imapConfig.tlsConfig, username: imapConfig.username, encryptedPassword },
          syncCursor: syncCursor!, syncState: syncState!, lastSyncAt: now, nextSyncTime: expiresAt,
        });
        if (result.isErr()) { logger.error("Failed to create IMAP exchange record", { code: "api.emx.imap.create_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
        const imapEnsureResult = await accountDb.ensureAlias(accountId, imapConfig.username, "allow_all", aliasCheck.isOk() ? aliasCheck.value : undefined, result.value.id);
        if (imapEnsureResult.isErr()) { logger.warn("Failed to ensure alias for IMAP exchange", { code: "api.emx.imap.ensure_alias_failed", accountId, error: imapEnsureResult.error }); }
        await triggerDispatch(accountId, result.value.id);
        logger.info("IMAP exchange created and activated", { code: "api.emx.imap.created", accountId, emxId: result.value.id, emailAddress: imapConfig.username });
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

        const encryptResult = await encryptionManager.encrypt(jmapConfig.password);
        if (encryptResult.isErr()) { logger.error("Failed to encrypt JMAP password", { code: "api.emx.jmap.encrypt_failed", error: encryptResult.error }); return err(c, 500, "Internal Server Error"); }
        const encryptedPassword = encryptResult.value;

        // Build temp EMX with raw password for activation (adapter tests connection with it)
        const tempEmx: ExternalMailExchange = {
          id: "", accountId, platform: "jmap", emailAddress: jmapConfig.username,
          status: "active", createdAt: "", updatedAt: "",
          jmapConfig: { sessionUrl: jmapConfig.sessionUrl, username: jmapConfig.username, encryptedPassword: jmapConfig.password, apiUrl: "", downloadUrl: "", jmapAccountId: "", inboxId: "" },
        };

        const activateResult = await adapter.activate(tempEmx);
        if (activateResult.isErr()) {
          const errorReason = String(activateResult.error.cause);
          const result = await accountDb.createExternalExchange(accountId, {
            platform: "jmap", emailAddress: jmapConfig.username, status: "activation_failed", errorReason,
            jmapConfig: { sessionUrl: jmapConfig.sessionUrl, username: jmapConfig.username, encryptedPassword, apiUrl: "", downloadUrl: "", jmapAccountId: "", inboxId: "" },
            syncCursor: "", lastSyncAt: DateTime.utc().toISO()!,
          });
          if (result.isErr()) { logger.error("Failed to create JMAP exchange record", { code: "api.emx.jmap.create_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
          logger.error("Failed to activate JMAP exchange", { code: "api.emx.jmap.activate_failed", error: activateResult.error });
          return c.json(serializeEmx(result.value), 201);
        }

        const { syncCursor, expiresAt } = activateResult.value;
        // activate() populates apiUrl, downloadUrl, jmapAccountId, inboxId on tempEmx.jmapConfig
        const result = await accountDb.createExternalExchange(accountId, {
          platform: "jmap", emailAddress: jmapConfig.username, status: "active",
          jmapConfig: { sessionUrl: jmapConfig.sessionUrl, username: jmapConfig.username, encryptedPassword, apiUrl: tempEmx.jmapConfig!.apiUrl, downloadUrl: tempEmx.jmapConfig!.downloadUrl, jmapAccountId: tempEmx.jmapConfig!.jmapAccountId, inboxId: tempEmx.jmapConfig!.inboxId },
          syncCursor: syncCursor!, lastSyncAt: DateTime.utc().toISO()!, nextSyncTime: expiresAt,
        });
        if (result.isErr()) { logger.error("Failed to create JMAP exchange record", { code: "api.emx.jmap.create_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
        const jmapEnsureResult = await accountDb.ensureAlias(accountId, jmapConfig.username, "allow_all", aliasCheck.isOk() ? aliasCheck.value : undefined, result.value.id);
        if (jmapEnsureResult.isErr()) { logger.warn("Failed to ensure alias for JMAP exchange", { code: "api.emx.jmap.ensure_alias_failed", accountId, error: jmapEnsureResult.error }); }
        await triggerDispatch(accountId, result.value.id);
        logger.info("JMAP exchange created and activated", { code: "api.emx.jmap.created", accountId, emxId: result.value.id, emailAddress: jmapConfig.username });
        return c.json(serializeEmx(result.value), 201);
      }

      // --- OAuth branch (Gmail/Outlook) ---
      const oauthBody = CreateExternalExchangeRequest.safeParse(rawBody);
      if (!oauthBody.success) return err(c, 400, "Invalid request body");
      const body = oauthBody.data;

      const adapter = adapters[body.platform];
      if (!adapter) return err(c, 422, "Unsupported platform");

      const connectionId = body.connectionId ?? DEFAULT_CONNECTION_IDS[body.platform];
      if (!connectionId) return err(c, 422, "Unsupported platform");

      // The provider credentials Authress holds are keyed on the Authress userId of whoever
      // linked the identity — which is the caller, right now, mid-OAuth-return. It comes from
      // the verified access token, never from the request: a caller who could name the user
      // whose mailbox is being connected could bind someone else's identity to their account.
      // Accounts are multi-user, so the accountId cannot stand in for it either.
      const userId = c.get("auth")?.userId;
      if (!userId) return err(c, 401, "Unauthorized");

      // Which identity the caller holds at that provider is Authress' to state, not the
      // client's — the client never names it. A connection can carry multiple linked
      // identities (the same user linking more than one mailbox through the same provider
      // connection); Authress reports a `linkedTime` per identity, and the one just linked by
      // the OAuth redirect that is mid-flight right now is always the most recent for its
      // connectionId, so that is the one resolved here.
      const linkedIdentityResult = await getLinkedIdentity(userId, connectionId);
      if (linkedIdentityResult.isErr()) {
        logger.error("Failed to resolve the caller's linked identity", { code: "api.emx.create.linked_identity_failed", accountId, connectionId, error: linkedIdentityResult.error });
        return err(c, 503, "Could not verify the linked identity with the identity provider");
      }
      if (!linkedIdentityResult.value) {
        return err(c, 422, "No linked identity found for this connection. Link the identity before connecting a mailbox.");
      }
      const connectionUserId = linkedIdentityResult.value.connectionUserId;

      // activate() resolves its own credentials and reports the verified mailbox address — the
      // exact credential fetch every later renew/fetch/send makes, so a failure here means the
      // connection genuinely will not work, not that it merely might. Nothing is persisted on
      // failure: without a verified address there's no meaningful record to key one on, and an
      // unusable connection isn't worth surfacing as a mailbox the user half-connected.
      const emxStub: ExternalMailExchange = { id: "", accountId, platform: body.platform, emailAddress: "", status: "active", createdAt: "", updatedAt: "" };
      const activateResult = await adapter.activate(emxStub, { userId, connectionId, connectionUserId });
      if (activateResult.isErr()) {
        logger.warn("OAuth activation failed — refusing to connect the mailbox", { code: "api.emx.create.activation_failed", accountId, connectionId, platform: body.platform, error: activateResult.error });
        return err(c, 422, "Could not activate this mailbox. Reconnect the identity and try again.");
      }
      const { syncCursor, expiresAt, providerSubscriptionId, emailAddress } = activateResult.value;

      // Alias conflict check: reject if another account already owns this email address
      const oauthAliasCheck = await accountDb.getAliasByGlobalAddress(emailAddress);
      if (oauthAliasCheck.isOk() && oauthAliasCheck.value && oauthAliasCheck.value.accountId !== accountId) {
        return err(c, 409, "Email address is already registered to another account");
      }

      // Idempotency: find existing exchange for same platform + emailAddress. The address is
      // only known now, post-activation, so this check has to come after — an idempotency key
      // is only meaningful once it's the real address, not a guess at one.
      const listResult = await accountDb.listExternalExchanges(accountId);
      const existing = listResult.isOk()
        ? listResult.value.find((e) => e.platform === body.platform && e.emailAddress === emailAddress)
        : undefined;
      if (existing) {
        const updateResult = await accountDb.updateExternalExchange(accountId, existing.id, { status: "active", syncCursor: syncCursor!, expiresAt, providerSubscriptionId, userId, connectionUserId, connectionId, consecutiveFailures: 0 }, ["errorReason"]);
        if (updateResult.isErr()) { logger.error("Failed to update exchange record", { code: "api.emx.create_failed", error: updateResult.error }); return err(c, 500, "Internal Server Error"); }
        const reactivateEnsureResult = await accountDb.ensureAlias(accountId, emailAddress, "allow_all", oauthAliasCheck.isOk() ? oauthAliasCheck.value : undefined, existing.id);
        if (reactivateEnsureResult.isErr()) { logger.warn("Failed to ensure alias for reactivated exchange", { code: "api.emx.oauth.reactivate_ensure_alias_failed", accountId, error: reactivateEnsureResult.error }); }
        await triggerDispatch(accountId, existing.id);
        logger.info("OAuth exchange reactivated", { code: "api.emx.oauth.reactivated", accountId, emxId: existing.id, platform: body.platform });
        return c.json(serializeEmx(updateResult.value), 200);
      }
      const result = await accountDb.createExternalExchange(accountId, { platform: body.platform, emailAddress, status: "active", syncCursor: syncCursor!, lastSyncAt: DateTime.utc().toISO()!, expiresAt, providerSubscriptionId, userId, connectionUserId, connectionId });
      if (result.isErr()) { logger.error("Failed to create exchange record", { code: "api.emx.create_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
      const oauthEnsureResult = await accountDb.ensureAlias(accountId, emailAddress, "allow_all", oauthAliasCheck.isOk() ? oauthAliasCheck.value : undefined, result.value.id);
      if (oauthEnsureResult.isErr()) { logger.warn("Failed to ensure alias for new OAuth exchange", { code: "api.emx.oauth.ensure_alias_failed", accountId, error: oauthEnsureResult.error }); }
      await triggerDispatch(accountId, result.value.id);
      logger.info("OAuth exchange created", { code: "api.emx.oauth.created", accountId, emxId: result.value.id, platform: body.platform });
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
      logger.info("Patching external exchange", { code: "api.emx.patch", accountId, emxId });

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
          const jmapDecryptResult = await encryptionManager.decrypt(emx.jmapConfig.encryptedPassword);
          if (jmapDecryptResult.isErr()) {
            logger.error("Failed to decrypt existing JMAP password for connection test", { code: "api.emx.patch.jmap.decrypt_failed", emxId, error: jmapDecryptResult.error });
            return err(c, 500, "Internal Server Error");
          }
          testPassword = jmapDecryptResult.value;
        }

        // Connection test via adapter.activate — validates session URL, auth, and mailbox discovery
        const jmapAdapter = adapters["jmap"];
        if (!jmapAdapter) return err(c, 422, "Unsupported platform");
        const tempEmx: ExternalMailExchange = {
          ...emx,
          jmapConfig: { ...emx.jmapConfig, sessionUrl: mergedSessionUrl, username: mergedUsername, encryptedPassword: testPassword },
        };
        const testResult = await jmapAdapter.activate(tempEmx);
        if (testResult.isErr()) {
          const reason = String(testResult.error.cause).slice(0, 512);
          logger.warn("JMAP connection test failed during PATCH", { code: "api.emx.patch.jmap.connection_test_failed", emxId, error: testResult.error });
          return err(c, 422, reason);
        }

        // Connection test passed — persist the full merged config (activate() updates apiUrl, downloadUrl, jmapAccountId, inboxId in-place)
        let encryptedPassword: string;
        if (jmapBody.data.jmapConfig.password !== undefined) {
          const jmapEncryptResult = await encryptionManager.encrypt(jmapBody.data.jmapConfig.password);
          if (jmapEncryptResult.isErr()) { logger.error("Failed to encrypt JMAP password", { code: "api.emx.patch.jmap.encrypt_failed", emxId, error: jmapEncryptResult.error }); return err(c, 500, "Internal Server Error"); }
          encryptedPassword = jmapEncryptResult.value;
        } else {
          encryptedPassword = emx.jmapConfig.encryptedPassword;
        }

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
        const jmapTimingResult = await accountDb.updateExternalExchange(accountId, emxId, { syncCursor: newSyncCursor!, lastSyncAt: patchNow, nextSyncTime: newExpiresAt });
        if (jmapTimingResult.isErr()) { logger.warn("Failed to update JMAP sync timing", { code: "api.emx.patch.jmap.timing_failed", accountId, emxId, error: jmapTimingResult.error }); }

        // Ensure alias exists for the EMX email address (may have been missed or deleted)
        const jmapPatchEnsureResult = await accountDb.ensureAlias(accountId, emx.emailAddress, "allow_all", undefined, emxId);
        if (jmapPatchEnsureResult.isErr()) { logger.warn("Failed to ensure alias during JMAP patch", { code: "api.emx.patch.jmap.ensure_alias_failed", accountId, error: jmapPatchEnsureResult.error }); }

        // Re-activate if previously failed — connection test just proved creds work
        if (emx.status === "activation_failed") {
          const reactivateResult = await accountDb.updateExternalExchange(accountId, emxId, { status: "active", nextSyncTime: newExpiresAt, consecutiveFailures: 0 }, ["errorReason"]);
          if (reactivateResult.isErr()) { logger.error("Failed to reactivate JMAP exchange", { code: "api.emx.patch.jmap.reactivate_failed", accountId, emxId, error: reactivateResult.error }); return err(c, 500, "Internal Server Error"); }
        }

        await triggerDispatch(accountId, emxId);
        const freshResult = await accountDb.getExternalExchange(accountId, emxId);
        logger.info("JMAP exchange patched", { code: "api.emx.patch.jmap.done", accountId, emxId, previousStatus: emx.status, reactivated: emx.status === "activation_failed" });
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
        const imapDecryptResult = await encryptionManager.decrypt(emx.imapConfig.encryptedPassword);
        if (imapDecryptResult.isErr()) {
          logger.error("Failed to decrypt existing password for connection test", { code: "api.emx.patch.decrypt_failed", emxId, error: imapDecryptResult.error });
          return err(c, 500, "Internal Server Error");
        }
        testPassword = imapDecryptResult.value;
      }

      // Connection test via adapter.activate — validates host, TLS, auth, and INBOX access
      const imapAdapter = adapters["imap"];
      if (!imapAdapter) return err(c, 422, "Unsupported platform");
      const tempEmx: ExternalMailExchange = {
        ...emx,
        imapConfig: { host: mergedHost, tlsConfig: mergedTlsConfig, username: mergedUsername, encryptedPassword: testPassword },
      };
      const testResult = await imapAdapter.activate(tempEmx);
      if (testResult.isErr()) {
        const reason = String(testResult.error.cause).slice(0, 512);
        logger.warn("IMAP connection test failed during PATCH", { code: "api.emx.patch.connection_test_failed", emxId, error: testResult.error });
        return err(c, 422, reason);
      }

      // Connection test passed — persist the full merged config + updated sync state
      let encryptedPassword: string;
      if (body.imapConfig.password !== undefined) {
        const imapEncryptResult = await encryptionManager.encrypt(body.imapConfig.password);
        if (imapEncryptResult.isErr()) { logger.error("Failed to encrypt IMAP password", { code: "api.emx.patch.imap.encrypt_failed", emxId, error: imapEncryptResult.error }); return err(c, 500, "Internal Server Error"); }
        encryptedPassword = imapEncryptResult.value;
      } else {
        encryptedPassword = emx.imapConfig.encryptedPassword;
      }

      const { syncCursor: newSyncCursor, syncState: newSyncState, expiresAt: newExpiresAt } = testResult.value;
      const patchNow = DateTime.utc().toISO()!;

      const updateResult = await accountDb.updateExternalExchangeImapConfig(accountId, emxId, {
        host: mergedHost, tlsConfig: mergedTlsConfig, username: mergedUsername, encryptedPassword,
      });
      if (updateResult.isErr()) { logger.error("Failed to update exchange", { code: "api.emx.patch_failed", error: updateResult.error }); return err(c, 500, "Internal Server Error"); }

      // Always persist fresh syncCursor + syncState and timing from the activation test
      const imapTimingResult = await accountDb.updateExternalExchange(accountId, emxId, { syncCursor: newSyncCursor!, syncState: newSyncState!, lastSyncAt: patchNow, nextSyncTime: newExpiresAt });
      if (imapTimingResult.isErr()) { logger.warn("Failed to update IMAP sync timing", { code: "api.emx.patch.imap.timing_failed", accountId, emxId, error: imapTimingResult.error }); }

      // Ensure alias exists for the EMX email address (may have been missed or deleted)
      const imapPatchEnsureResult = await accountDb.ensureAlias(accountId, emx.emailAddress, "allow_all", undefined, emxId);
      if (imapPatchEnsureResult.isErr()) { logger.warn("Failed to ensure alias during IMAP patch", { code: "api.emx.patch.imap.ensure_alias_failed", accountId, error: imapPatchEnsureResult.error }); }

      // Re-activate if previously failed — connection test just proved creds work
      if (emx.status === "activation_failed") {
        const imapReactivateResult = await accountDb.updateExternalExchange(accountId, emxId, { status: "active", nextSyncTime: newExpiresAt, consecutiveFailures: 0 }, ["errorReason"]);
        if (imapReactivateResult.isErr()) { logger.error("Failed to reactivate IMAP exchange", { code: "api.emx.patch.imap.reactivate_failed", accountId, emxId, error: imapReactivateResult.error }); return err(c, 500, "Internal Server Error"); }
      }

      await triggerDispatch(accountId, emxId);
      const freshResult = await accountDb.getExternalExchange(accountId, emxId);
      logger.info("IMAP exchange patched", { code: "api.emx.patch.imap.done", accountId, emxId, previousStatus: emx.status, reactivated: emx.status === "activation_failed" });
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
      logger.info("Deleting external exchange", { code: "api.emx.delete", accountId, emxId });
      const getResult = await accountDb.getExternalExchange(accountId, emxId);
      if (getResult.isErr()) { logger.error("Failed to get exchange for delete", { code: "api.emx.delete.get_failed", error: getResult.error }); return err(c, 500, "Internal Server Error"); }
      const emx = getResult.value;
      if (!emx) return err(c, 404, "Exchange not found");

      // Only deactivate with provider if the exchange was successfully activated. The adapter
      // resolves its own credentials from `emx` now — see ProviderAdapter.deactivate — so a
      // missing or unusable identity surfaces as its own failure rather than a silent skip.
      if (emx.status === "active") {
        const adapter = adapters[emx.platform];
        if (adapter) {
          const deactivateResult = await adapter.deactivate(emx);
          if (deactivateResult.isErr()) {
            logger.warn("Failed to deactivate exchange with provider — proceeding with local deletion", { code: "api.emx.deactivate_failed", emxId, error: deactivateResult.error });
          }
        }
      }

      // Unlink before deleting the exchange: an alias left pointing at a deleted exchange
      // would refuse every send from that address.
      const unlinkResult = await accountDb.updateAlias(accountId, emx.emailAddress, { emxId: undefined });
      if (unlinkResult.isErr()) {
        logger.error("Failed to unlink alias from deleted exchange — outbound mail from this address will not route through SES.", { code: "api.emx.alias_unlink_failed", accountId, aliasAddress: emx.emailAddress, error: unlinkResult.error });
      }

      const deleteResult = await accountDb.deleteExternalExchange(accountId, emxId);
      if (deleteResult.isErr()) { logger.error("Failed to delete exchange", { code: "api.emx.delete_failed", error: deleteResult.error }); return err(c, 500, "Internal Server Error"); }
      logger.info("Exchange deleted", { code: "api.emx.deleted", accountId, emxId, platform: emx.platform });
      return new Response(null, { status: 204 });
    });
  }
}
