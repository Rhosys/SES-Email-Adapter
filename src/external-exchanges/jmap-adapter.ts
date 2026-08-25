import { DateTime } from "luxon";
import { timingSafeEqual } from "node:crypto";
import { ok, err } from "../errors.js";
import type { Result } from "../errors.js";
import type { ExternalMailExchange } from "../types/index.js";
import {
  POLL_INTERVAL_MINUTES,
  type ProviderAdapter,
  type ActivationResult,
  type ActivationIdentity,
  type RawMimeResult,
  type ProviderActivationError,
  type ProviderRenewalError,
  type ProviderDeactivationError,
  type ProviderFetchError,
} from "./provider-adapter.js";
import type { EncryptionManager } from "../secrets/encryption-manager.js";
import type { ExchangesDatabase } from "../database/exchanges-database.js";
import type { SignalQueue } from "../messaging/signal-queue.js";
import type { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// JMAP types
// ---------------------------------------------------------------------------

interface JmapSession {
  apiUrl: string;
  downloadUrl: string;
  primaryAccounts: Record<string, string>;
  capabilities: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export const JMAP_USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"] as const;
const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";
const JMAP_PUSH_WEBHOOK_BASE = "https://api.email.rhosys.cloud/api/external-exchanges/jmap/target";

function delay(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

function isRetryableError(e: unknown): boolean {
  if (e instanceof Error) {
    if (e.name === "AbortError" || e.name === "TimeoutError") { return false; }
    if (e.message.includes("AbortError") || e.message.includes("abort")) { return false; }
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH" || code === "ENOTFOUND" || code === "UND_ERR_CONNECT_TIMEOUT") {
      return true;
    }
    const msg = e.message.toLowerCase();
    if (msg.includes("fetch failed") || msg.includes("network") || msg.includes("socket")) { return true; }
  }
  return false;
}

/** Fetch with exponential backoff (1s, 2s, 4s, 8s, 16s) for transient failures. */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      if (init.signal?.aborted) { break; }
      await delay(1_000 * 2 ** (attempt - 1));
      if (init.signal?.aborted) { break; }
    }
    try {
      const response = await fetch(url, init);
      if (isTransientStatus(response.status) && attempt < 4) { continue; }
      return response;
    } catch (e) {
      lastError = e;
      if (!isRetryableError(e)) { break; }
    }
  }
  throw lastError;
}

export function buildBasicAuth(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

export async function fetchSession(sessionUrl: string, auth: string, timeout: number): Promise<Result<JmapSession, ProviderActivationError>> {
  let response: Response;
  try {
    response = await fetchWithRetry(sessionUrl, {
      method: "GET",
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    return err({ kind: "provider_activation_failed", cause: "server unreachable" });
  }

  if (response.status === 401 || response.status === 403) {
    return err({ kind: "provider_activation_failed", cause: "invalid credentials" });
  }

  if (!response.ok) {
    return err({ kind: "provider_activation_failed", cause: `session fetch failed: HTTP ${response.status}` });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return err({ kind: "provider_activation_failed", cause: "invalid session response" });
  }

  const session = body as Record<string, unknown>;
  if (!session["apiUrl"] || typeof session["apiUrl"] !== "string") {
    return err({ kind: "provider_activation_failed", cause: "invalid session response" });
  }
  if (!session["downloadUrl"] || typeof session["downloadUrl"] !== "string") {
    return err({ kind: "provider_activation_failed", cause: "invalid session response" });
  }

  const primaryAccounts = session["primaryAccounts"] as Record<string, string> | undefined;
  if (!primaryAccounts || typeof primaryAccounts !== "object" || !primaryAccounts[MAIL_CAPABILITY]) {
    return err({ kind: "provider_activation_failed", cause: "server does not support JMAP Mail" });
  }

  const capabilities = (session["capabilities"] as Record<string, unknown> | undefined) ?? {};

  return ok({
    apiUrl: session["apiUrl"] as string,
    downloadUrl: session["downloadUrl"] as string,
    primaryAccounts,
    capabilities,
  });
}

export async function jmapCall(apiUrl: string, auth: string, using: readonly string[], methodCalls: unknown[][], timeout: number): Promise<Result<unknown[][], ProviderRenewalError>> {
  let response: Response;
  try {
    response = await fetchWithRetry(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ using, methodCalls }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    return err({ kind: "provider_renewal_failed", cause: "server unreachable" });
  }

  if (response.status === 401 || response.status === 403) {
    return err({ kind: "provider_renewal_failed", cause: "invalid credentials" });
  }

  if (!response.ok) {
    return err({ kind: "provider_renewal_failed", cause: `JMAP call failed: HTTP ${response.status}` });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return err({ kind: "provider_renewal_failed", cause: "invalid JMAP response" });
  }

  const result = body as { methodResponses?: unknown[][] };
  if (!result.methodResponses || !Array.isArray(result.methodResponses)) {
    return err({ kind: "provider_renewal_failed", cause: "invalid JMAP response" });
  }

  return ok(result.methodResponses);
}

// ---------------------------------------------------------------------------
// JmapAdapter
// ---------------------------------------------------------------------------

interface JmapAdapterDeps {
  encryptionManager: EncryptionManager;
  db: ExchangesDatabase;
  signalQueue: SignalQueue;
  logger: Logger;
}

export class JmapAdapter implements ProviderAdapter {
  private readonly encryptionManager: EncryptionManager;
  private readonly db: ExchangesDatabase;
  private readonly signalQueue: SignalQueue;
  private readonly logger: Logger;

  constructor(deps: JmapAdapterDeps) {
    this.encryptionManager = deps.encryptionManager;
    this.db = deps.db;
    this.signalQueue = deps.signalQueue;
    this.logger = deps.logger;
  }

  async activate(emx: ExternalMailExchange, _identity?: ActivationIdentity): Promise<Result<ActivationResult, ProviderActivationError>> {
    const jmapConfig = emx.jmapConfig;
    if (!jmapConfig) {
      return err({ kind: "provider_activation_failed", cause: "Missing jmapConfig" });
    }

    const auth = buildBasicAuth(jmapConfig.username, jmapConfig.encryptedPassword);

    const sessionResult = await fetchSession(jmapConfig.sessionUrl, auth, 10_000);
    if (sessionResult.isErr()) return err(sessionResult.error);
    const session = sessionResult.value;

    const jmapAccountId = session.primaryAccounts[MAIL_CAPABILITY]!;

    const inboxResult = await jmapCall(session.apiUrl, auth, JMAP_USING, [
      ["Mailbox/query", { accountId: jmapAccountId, filter: { role: "inbox" } }, "mq0"],
    ], 10_000);
    if (inboxResult.isErr()) {
      return err({ kind: "provider_activation_failed", cause: inboxResult.error.cause });
    }

    const inboxResponse = inboxResult.value[0] as [string, Record<string, unknown>, string] | undefined;
    if (!inboxResponse || inboxResponse[0] === "error") {
      return err({ kind: "provider_activation_failed", cause: "Mailbox/query failed" });
    }
    const inboxIds = (inboxResponse[1] as { ids?: string[] }).ids;
    if (!inboxIds || inboxIds.length === 0) {
      return err({ kind: "provider_activation_failed", cause: "INBOX not found" });
    }
    const inboxId = inboxIds[0]!;

    const queryResult = await jmapCall(session.apiUrl, auth, JMAP_USING, [
      ["Email/query", {
        accountId: jmapAccountId,
        filter: { inMailbox: inboxId },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit: 1,
      }, "q0"],
    ], 10_000);
    if (queryResult.isErr()) {
      return err({ kind: "provider_activation_failed", cause: queryResult.error.cause });
    }

    const queryResponse = queryResult.value[0] as [string, Record<string, unknown>, string] | undefined;
    if (!queryResponse || queryResponse[0] === "error") {
      return err({ kind: "provider_activation_failed", cause: "Email/query failed" });
    }
    const queryState = (queryResponse[1] as { queryState?: string }).queryState;
    if (!queryState) {
      return err({ kind: "provider_activation_failed", cause: "Missing queryState" });
    }

    emx.jmapConfig!.apiUrl = session.apiUrl;
    emx.jmapConfig!.downloadUrl = session.downloadUrl;
    emx.jmapConfig!.jmapAccountId = jmapAccountId;
    emx.jmapConfig!.inboxId = inboxId;

    return ok({
      syncCursor: queryState,
      expiresAt: DateTime.utc().plus({ minutes: POLL_INTERVAL_MINUTES }).toISO()!,
      providerSubscriptionId: "poll",
      emailAddress: jmapConfig.username,
    });
  }

  async renew(emx: ExternalMailExchange): Promise<Result<void, ProviderRenewalError>> {
    const jmapConfig = emx.jmapConfig;
    if (!jmapConfig) {
      return err({ kind: "provider_renewal_failed", cause: "Missing jmapConfig" });
    }

    const decryptResult = await this.encryptionManager.decrypt(jmapConfig.encryptedPassword);
    if (decryptResult.isErr()) return err({ kind: "provider_renewal_failed", cause: "decryption failed" });
    const password = decryptResult.value;

    const auth = buildBasicAuth(jmapConfig.username, password);

    const sessionResult = await fetchSession(jmapConfig.sessionUrl, auth, 30_000);
    if (sessionResult.isErr()) {
      return this.handleRenewalFailure(emx, sessionResult.error.cause);
    }
    const session = sessionResult.value;
    const jmapAccountId = session.primaryAccounts[MAIL_CAPABILITY]!;

    // --- JMAP Push Subscription: register or verify ---
    const pushResult = await this.handlePushSubscription(emx, session, auth, jmapAccountId);
    if (pushResult === "handled") {
      return ok(undefined);
    }

    const sinceQueryState = emx.syncCursor!;
    const queryChangesResult = await jmapCall(session.apiUrl, auth, JMAP_USING, [
      ["Email/queryChanges", {
        accountId: jmapAccountId,
        filter: { inMailbox: jmapConfig.inboxId },
        sort: [{ property: "receivedAt", isAscending: false }],
        sinceQueryState,
        maxChanges: 500,
      }, "qc0"],
    ], 30_000);
    if (queryChangesResult.isErr()) {
      return this.handleRenewalFailure(emx, queryChangesResult.error.cause);
    }

    const qcResponse = queryChangesResult.value[0] as [string, Record<string, unknown>, string] | undefined;

    if (qcResponse && qcResponse[0] === "error") {
      const errorType = (qcResponse[1] as { type?: string }).type;
      if (errorType === "cannotCalculateChanges") {
        return this.renewFallback(session.apiUrl, auth, jmapAccountId, jmapConfig.inboxId, emx);
      }
      return this.handleRenewalFailure(emx, "JMAP error: " + errorType);
    }

    if (!qcResponse) {
      return err({ kind: "provider_renewal_failed", cause: "Empty JMAP response" });
    }

    const responseData = qcResponse[1] as { added?: Array<{ id: string; index: number }>; newQueryState?: string };
    const added = responseData.added ?? [];
    const newQueryState = responseData.newQueryState;

    if (!newQueryState) {
      return err({ kind: "provider_renewal_failed", cause: "Missing newQueryState" });
    }

    // Enqueue emx_inbound via batch (capped at 500 by maxChanges)
    const entries = added.map((entry, i) => ({
      id: `jmap-${i}`,
      payload: { source: "jmap", providerMessageId: entry.id, emxId: emx.id, accountId: emx.accountId },
    }));
    const batchResult = await this.signalQueue.sendBatch("emx_inbound", entries);
    if (batchResult.isErr()) {
      this.logger.error(`JMAP: failed to enqueue emx_inbound batch: ${batchResult.error.message}`, { code: "jmap.renew.batch_failed", emxId: emx.id, count: entries.length, error: batchResult.error });
      return err({ kind: "provider_renewal_failed", cause: "SQS batch send failed" });
    }

    const cursorResult = await this.db.updateExternalExchange(emx.accountId, emx.id, emx.status, DateTime.utc().plus({ minutes: POLL_INTERVAL_MINUTES }).toISO()!, {
      syncCursor: newQueryState,
      lastSyncAt: DateTime.utc().toISO()!,
      consecutiveFailures: 0,
    });
    if (cursorResult.isErr()) { this.logger.warn("Failed to update JMAP sync cursor", { code: "jmap.renew.cursor_update_failed", emxId: emx.id, error: cursorResult.error }); }

    this.logger.info("JMAP sync complete", { code: "jmap.renew.synced", emxId: emx.id, newMessages: added.length, newQueryState });

    return ok(undefined);
  }

  deactivate(_emx: ExternalMailExchange): Promise<Result<void, ProviderDeactivationError>> {
    return Promise.resolve(ok(undefined));
  }

  // ---------------------------------------------------------------------------
  // Public: JMAP push webhook handler (moved from app.ts)
  // ---------------------------------------------------------------------------

  async handleWebhook(body: Record<string, unknown>, token: string): Promise<Result<void, { kind: "malformed_body" }>> {
    const type = body["@type"] as string | undefined;
    const deviceClientId = body["deviceClientId"] as string | undefined;

    if (!deviceClientId || !token) {
      this.logger.track("JMAP webhook: missing deviceClientId or token", { code: "emx.jmap.webhook.missing_params" });
      return ok(undefined);
    }

    // Parse compound deviceClientId → [accountId, emxId]
    const colonIdx = deviceClientId.indexOf(":");
    if (colonIdx < 1) {
      this.logger.track("JMAP webhook: malformed deviceClientId", { code: "emx.jmap.webhook.unknown_device", deviceClientId });
      return ok(undefined);
    }
    const accountId = deviceClientId.slice(0, colonIdx);
    const emxId = deviceClientId.slice(colonIdx + 1);

    // Validate HMAC — timing-safe comparison
    const hashResult = await this.encryptionManager.hash(deviceClientId);
    if (hashResult.isErr()) {
      this.logger.error("JMAP webhook: hash computation failed", { code: "emx.jmap.webhook.hash_failed", deviceClientId, error: hashResult.error });
      return ok(undefined);
    }
    const expectedToken = hashResult.value;
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expectedToken);
    if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
      this.logger.track("JMAP webhook: invalid HMAC token", { code: "emx.jmap.webhook.invalid_hmac", deviceClientId });
      return ok(undefined);
    }

    // Direct lookup by accountId + emxId
    const emxResult = await this.db.getExternalExchange(accountId, emxId);
    if (emxResult.isErr()) {
      this.logger.error("JMAP webhook: DB lookup failed", { code: "emx.jmap.webhook.db_error", error: emxResult.error });
      return ok(undefined);
    }

    const emx = emxResult.value;
    if (!emx || emx.platform !== "jmap") {
      this.logger.track("JMAP webhook: unknown deviceClientId", { code: "emx.jmap.webhook.unknown_device", deviceClientId });
      return ok(undefined);
    }

    if (emx.status !== "active") {
      this.logger.track("JMAP webhook: exchange no longer active", { code: "emx.jmap.webhook.inactive_exchange", emxId: emx.id, status: emx.status });
      return ok(undefined);
    }

    if (type === "PushVerification") {
      const verificationCode = body["verificationCode"] as string | undefined;
      if (!verificationCode || !emx.pushSubscriptionId) {
        return ok(undefined);
      }

      const jmapConfig = emx.jmapConfig;
      if (!jmapConfig) {
        return ok(undefined);
      }

      const webhookDecryptResult = await this.encryptionManager.decrypt(jmapConfig.encryptedPassword);
      if (webhookDecryptResult.isErr()) {
        this.logger.error("JMAP webhook: failed to decrypt password for verification", { code: "emx.jmap.webhook.decrypt_failed", emxId: emx.id, error: webhookDecryptResult.error });
        return ok(undefined);
      }
      const password = webhookDecryptResult.value;

      const auth = buildBasicAuth(jmapConfig.username, password);
      const sessionResult = await fetchSession(jmapConfig.sessionUrl, auth, 30_000);
      if (sessionResult.isErr()) {
        this.logger.warn("JMAP webhook: failed to fetch session for verification", { code: "emx.jmap.webhook.session_failed", emxId: emx.id, cause: sessionResult.error.cause });
        return ok(undefined);
      }

      const confirmResult = await jmapCall(sessionResult.value.apiUrl, auth, JMAP_USING, [
        ["PushSubscription/set", {
          update: { [emx.pushSubscriptionId]: { verificationCode } },
        }, "pv0"],
      ], 30_000);

      if (confirmResult.isErr()) {
        this.logger.warn("JMAP webhook: PushSubscription/set verification failed", { code: "emx.jmap.webhook.verify_failed", emxId: emx.id, cause: confirmResult.error.cause });
      }

      return ok(undefined);
    }

    if (type === "StateChange") {
      const enqueueResult = await this.signalQueue.send("emx_dispatch", { emxId: emx.id, accountId: emx.accountId });
      if (enqueueResult.isErr()) {
        this.logger.error("JMAP webhook: failed to enqueue emx_dispatch", { code: "emx.jmap.webhook.enqueue_failed", emxId: emx.id, error: enqueueResult.error });
      }
      return ok(undefined);
    }

    // Unknown @type — accept silently
    return ok(undefined);
  }

  async fetchMessage(providerMessageId: string, emx: ExternalMailExchange): Promise<Result<RawMimeResult, ProviderFetchError>> {
    const jmapConfig = emx.jmapConfig;
    if (!jmapConfig) {
      return err({ kind: "provider_fetch_failed", cause: "EMX missing jmapConfig" });
    }

    const decryptResult = await this.encryptionManager.decrypt(jmapConfig.encryptedPassword);
    if (decryptResult.isErr()) return err({ kind: "provider_fetch_failed", cause: decryptResult.error });
    const password = decryptResult.value;

    const auth = buildBasicAuth(jmapConfig.username, password);

    const getResult = await jmapCall(jmapConfig.apiUrl, auth, JMAP_USING, [
      ["Email/get", {
        accountId: jmapConfig.jmapAccountId,
        ids: [providerMessageId],
        properties: ["blobId", "receivedAt"],
      }, "g0"],
    ], 30_000);
    if (getResult.isErr()) {
      return err({ kind: "provider_fetch_failed", cause: getResult.error.cause });
    }

    const getResponse = getResult.value[0] as [string, Record<string, unknown>, string] | undefined;
    if (!getResponse || getResponse[0] === "error") {
      return err({ kind: "provider_fetch_failed", cause: "Email/get failed" });
    }

    const responseData = getResponse[1] as { list?: Array<{ blobId: string; receivedAt: string }>; notFound?: string[] };

    if (responseData.notFound && responseData.notFound.includes(providerMessageId)) {
      return err({ kind: "provider_message_not_found" });
    }

    const email = responseData.list?.[0];
    if (!email) {
      return err({ kind: "provider_message_not_found" });
    }

    const downloadUrl = jmapConfig.downloadUrl
      .replace("{accountId}", jmapConfig.jmapAccountId)
      .replace("{blobId}", email.blobId)
      .replace("{name}", "email.eml");

    let mimeResponse: Response;
    try {
      mimeResponse = await fetchWithRetry(downloadUrl, {
        method: "GET",
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return err({ kind: "provider_fetch_failed", cause: "server unreachable" });
    }

    if (mimeResponse.status === 401 || mimeResponse.status === 403) {
      return err({ kind: "provider_fetch_failed", cause: "invalid credentials" });
    }

    if (!mimeResponse.ok) {
      return err({ kind: "provider_fetch_failed", cause: `download failed: HTTP ${mimeResponse.status}` });
    }

    const rawMime = new Uint8Array(await mimeResponse.arrayBuffer());
    return ok({ rawMime, receivedAt: email.receivedAt });
  }

  // ---------------------------------------------------------------------------
  // Public: JMAP polling — queryChanges loop (moved from emx-idle-worker)
  // ---------------------------------------------------------------------------

  async poll(emx: ExternalMailExchange, iterations: number, intervalMs: number): Promise<Result<"new_mail" | "timeout", ProviderRenewalError>> {
    const config = emx.jmapConfig;
    if (!config) {
      return err({ kind: "provider_renewal_failed", cause: "Missing jmapConfig" });
    }

    const decryptResult = await this.encryptionManager.decrypt(config.encryptedPassword);
    if (decryptResult.isErr()) return err({ kind: "provider_renewal_failed", cause: "decryption failed" });
    const password = decryptResult.value;

    const auth = buildBasicAuth(config.username, password);

    const sessionResult = await fetchSession(config.sessionUrl, auth, 30_000);
    if (sessionResult.isErr()) {
      return err({ kind: "provider_renewal_failed", cause: sessionResult.error.cause });
    }

    const session = sessionResult.value;
    const jmapAccountId = session.primaryAccounts[MAIL_CAPABILITY]!;
    const sinceQueryState = emx.syncCursor;

    if (!sinceQueryState) {
      return err({ kind: "provider_renewal_failed", cause: "no syncCursor" });
    }

    for (let i = 0; i < iterations; i++) {
      const changesResult = await jmapCall(session.apiUrl, auth, JMAP_USING, [
        ["Email/queryChanges", {
          accountId: jmapAccountId,
          filter: { inMailbox: config.inboxId },
          sort: [{ property: "receivedAt", isAscending: false }],
          sinceQueryState,
          maxChanges: 1,
        }, "qc0"],
      ], 30_000);

      if (changesResult.isErr()) {
        const cause = changesResult.error.cause;
        if (cause === "invalid credentials") {
          return err({ kind: "provider_renewal_failed", cause: "invalid credentials" });
        }
        // Transient failure — continue to next iteration
        if (i < iterations - 1) {
          await new Promise(r => setTimeout(r, intervalMs));
        }
        continue;
      }

      const response = changesResult.value[0] as [string, Record<string, unknown>, string] | undefined;

      // cannotCalculateChanges — treat as new mail (state diverged)
      if (response && response[0] === "error") {
        const errorType = (response[1] as { type?: string }).type;
        if (errorType === "cannotCalculateChanges") {
          return ok("new_mail" as const);
        }
        return err({ kind: "provider_renewal_failed", cause: `JMAP error: ${errorType}` });
      }

      if (response) {
        const data = response[1] as { added?: unknown[] };
        const addedCount = data.added?.length ?? 0;
        if (addedCount > 0) {
          return ok("new_mail" as const);
        }
      }

      // Sleep between iterations (not after the last one)
      if (i < iterations - 1) {
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }

    return ok("timeout" as const);
  }

  // ---------------------------------------------------------------------------
  // Public: Poll + dispatch (used by EmxIdleWorker)
  // ---------------------------------------------------------------------------
  // INVARIANT: This method is STATELESS — it must NEVER write to the database (no
  // cursor updates, no lastSyncAt, no exchange mutations). The sync cursor (JMAP
  // state string) is owned exclusively by the dispatch/renew path. Poll detects
  // change → enqueues emx_dispatch → renew() does the cursor-aware catch-up.
  // ---------------------------------------------------------------------------

  async pollAndDispatch(emx: ExternalMailExchange, iterations: number, intervalMs: number): Promise<Result<void, never>> {
    const result = await this.poll(emx, iterations, intervalMs);
    if (result.isErr()) {
      const cause = typeof result.error.cause === "string" ? result.error.cause : String(result.error.cause);
      if (cause === "invalid credentials") {
        this.logger.warn("emx_idle: JMAP authentication failed", { code: "emx.idle.jmap_auth_failed", emxId: emx.id });
      } else {
        this.logger.warn("emx_idle: JMAP polling failed", { code: "emx.idle.jmap_session_failed", emxId: emx.id, cause });
      }
      return ok(undefined);
    }

    if (result.value === "timeout") {
      this.logger.info("emx_idle: JMAP polling complete, no new mail", { code: "emx.idle.jmap_timeout", emxId: emx.id });
      return ok(undefined);
    }

    this.logger.info("emx_idle: JMAP new mail detected", { code: "emx.idle.jmap_new_mail", emxId: emx.id });
    const sendResult = await this.signalQueue.send("emx_dispatch", { emxId: emx.id, accountId: emx.accountId });
    if (sendResult.isErr()) {
      this.logger.error("emx_idle: failed to enqueue emx_dispatch after detecting changes", { code: "emx.idle.enqueue_failed", emxId: emx.id, error: sendResult.error });
    }

    return ok(undefined);
  }

  // ---------------------------------------------------------------------------
  // Private: JMAP Push Subscription registration and verification (R5)
  // ---------------------------------------------------------------------------

  private async handlePushSubscription(emx: ExternalMailExchange, session: JmapSession, auth: string, jmapAccountId: string): Promise<"handled" | "fallthrough"> {
    const jmapConfig = emx.jmapConfig!;
    const supportsPush = Object.keys(session.capabilities).some(key => key.includes("push") || key === "urn:ietf:params:jmap:core");

    // Case 1: Server supports push and no existing subscription — attempt registration
    if (supportsPush && !emx.pushSubscriptionId) {
      const deviceClientId = `${emx.accountId}:${emx.id}`;
      const pushHashResult = await this.encryptionManager.hash(deviceClientId);
      if (pushHashResult.isErr()) {
        this.logger.warn("JMAP push: hash computation failed", { code: "jmap.push.hash_failed", emxId: emx.id, error: pushHashResult.error });
        return "fallthrough";
      }
      const token = pushHashResult.value;
      const webhookUrl = `${JMAP_PUSH_WEBHOOK_BASE}?token=${token}`;

      const registerResult = await jmapCall(session.apiUrl, auth, JMAP_USING, [
        ["PushSubscription/set", {
          create: {
            push0: {
              deviceClientId,
              url: webhookUrl,
              types: ["Email"],
            },
          },
        }, "ps0"],
      ], 30_000);

      if (registerResult.isErr()) {
        this.logger.warn("JMAP push registration failed", { code: "jmap.push.registration_failed", emxId: emx.id, cause: registerResult.error.cause });
        return "fallthrough";
      }

      const psResponse = registerResult.value[0] as [string, Record<string, unknown>, string] | undefined;
      if (!psResponse || psResponse[0] === "error") {
        const errorType = psResponse ? (psResponse[1] as { type?: string }).type : "unknown";
        this.logger.warn("JMAP push registration failed", { code: "jmap.push.registration_failed", emxId: emx.id, cause: errorType });
        return "fallthrough";
      }

      const created = (psResponse[1] as { created?: Record<string, { id?: string }> }).created;
      const pushId = created?.["push0"]?.id;
      if (!pushId) {
        this.logger.warn("JMAP push registration failed", { code: "jmap.push.registration_failed", emxId: emx.id, cause: "no id in created response" });
        return "fallthrough";
      }

      // Registration succeeded — store subscription ID, set nextSyncTime to +4 days
      const updateResult = await this.db.updateExternalExchange(emx.accountId, emx.id, emx.status, DateTime.utc().plus({ days: 4 }).toISO()!, {
        pushSubscriptionId: pushId,
        consecutiveFailures: 0,
      });
      if (updateResult.isErr()) {
        this.logger.warn("Failed to store push subscription ID", { code: "jmap.push.store_failed", emxId: emx.id, error: updateResult.error });
      }

      // Do one queryChanges sync now
      await this.performQueryChanges(session.apiUrl, auth, jmapAccountId, jmapConfig.inboxId, emx);
      return "handled";
    }

    // Case 2: Existing pushSubscriptionId — verify still active
    if (emx.pushSubscriptionId) {
      const verifyResult = await jmapCall(session.apiUrl, auth, JMAP_USING, [
        ["PushSubscription/get", { ids: [emx.pushSubscriptionId] }, "pg0"],
      ], 30_000);

      if (verifyResult.isErr()) {
        // Cannot verify — clear subscription, fall through to polling
        const clearResult = await this.db.updateExternalExchange(emx.accountId, emx.id, emx.status, emx.nextSyncTime!, {}, ["pushSubscriptionId"]);
        if (clearResult.isErr()) {
          this.logger.warn("Failed to clear unverifiable push subscription", { code: "jmap.push.clear_failed", emxId: emx.id, error: clearResult.error });
        }
        return "fallthrough";
      }

      const pgResponse = verifyResult.value[0] as [string, Record<string, unknown>, string] | undefined;
      const notFound = pgResponse ? (pgResponse[1] as { notFound?: string[] }).notFound : undefined;

      if (pgResponse && pgResponse[0] === "error" || (notFound && notFound.includes(emx.pushSubscriptionId))) {
        // Subscription gone — clear and fall through
        const clearResult = await this.db.updateExternalExchange(emx.accountId, emx.id, emx.status, emx.nextSyncTime!, {}, ["pushSubscriptionId"]);
        if (clearResult.isErr()) {
          this.logger.warn("Failed to clear gone push subscription", { code: "jmap.push.clear_failed", emxId: emx.id, error: clearResult.error });
        }
        return "fallthrough";
      }

      // Subscription still active — renew nextSyncTime, do queryChanges sync
      const renewResult = await this.db.updateExternalExchange(emx.accountId, emx.id, emx.status, DateTime.utc().plus({ days: 4 }).toISO()!, {
        consecutiveFailures: 0,
      });
      if (renewResult.isErr()) {
        this.logger.warn("Failed to renew push subscription timing", { code: "jmap.push.renew_failed", emxId: emx.id, error: renewResult.error });
      }

      await this.performQueryChanges(session.apiUrl, auth, jmapAccountId, jmapConfig.inboxId, emx);
      return "handled";
    }

    return "fallthrough";
  }

  // ---------------------------------------------------------------------------
  // Private: perform a queryChanges cycle (shared between push and polling paths)
  // ---------------------------------------------------------------------------

  private async performQueryChanges(apiUrl: string, auth: string, jmapAccountId: string, inboxId: string, emx: ExternalMailExchange): Promise<void> {
    const sinceQueryState = emx.syncCursor!;
    const queryChangesResult = await jmapCall(apiUrl, auth, JMAP_USING, [
      ["Email/queryChanges", {
        accountId: jmapAccountId,
        filter: { inMailbox: inboxId },
        sort: [{ property: "receivedAt", isAscending: false }],
        sinceQueryState,
        maxChanges: 500,
      }, "qc0"],
    ], 30_000);

    if (queryChangesResult.isErr()) {
      this.logger.warn("JMAP push sync queryChanges failed", { code: "jmap.push.sync_failed", emxId: emx.id, cause: queryChangesResult.error.cause });
      return;
    }

    const qcResponse = queryChangesResult.value[0] as [string, Record<string, unknown>, string] | undefined;
    if (!qcResponse || qcResponse[0] === "error") {
      return;
    }

    const responseData = qcResponse[1] as { added?: Array<{ id: string; index: number }>; newQueryState?: string };
    const added = responseData.added ?? [];
    const newQueryState = responseData.newQueryState;

    if (!newQueryState) {
      return;
    }

    if (added.length > 0) {
      const entries = added.map((entry, i) => ({
        id: `jmap-${i}`,
        payload: { source: "jmap", providerMessageId: entry.id, emxId: emx.id, accountId: emx.accountId },
      }));
      const batchResult = await this.signalQueue.sendBatch("emx_inbound", entries);
      if (batchResult.isErr()) {
        this.logger.error(`JMAP push sync: failed to enqueue emx_inbound batch: ${batchResult.error.message}`, { code: "jmap.push.batch_failed", emxId: emx.id, count: entries.length, error: batchResult.error });
      }
    }

    const cursorResult = await this.db.updateExternalExchange(emx.accountId, emx.id, emx.status, emx.nextSyncTime!, {
      syncCursor: newQueryState,
      lastSyncAt: DateTime.utc().toISO()!,
    });
    if (cursorResult.isErr()) {
      this.logger.warn("Failed to update JMAP push sync cursor", { code: "jmap.push.cursor_update_failed", emxId: emx.id, error: cursorResult.error });
    }

    this.logger.info("JMAP push sync complete", { code: "jmap.push.synced", emxId: emx.id, newMessages: added.length, newQueryState });
  }

  // ---------------------------------------------------------------------------
  // Private: handle renewal failure with consecutive failure tracking
  // ---------------------------------------------------------------------------

  private async handleRenewalFailure(emx: ExternalMailExchange, cause: string | unknown): Promise<Result<void, ProviderRenewalError>> {
    const causeStr = typeof cause === "string" ? cause : String(cause);
    this.logger.info("JMAP renewal failed", { code: "jmap.renew.failed", emxId: emx.id, cause: causeStr });
    const failures = (emx.consecutiveFailures ?? 0) + 1;
    if (failures >= 3) {
      const deactivateResult = await this.db.updateExternalExchange(emx.accountId, emx.id, "activation_failed", emx.nextSyncTime!, { errorReason: causeStr, consecutiveFailures: failures });
      if (deactivateResult.isErr()) { this.logger.warn("Failed to deactivate JMAP exchange", { code: "jmap.renew.deactivate_write_failed", emxId: emx.id, error: deactivateResult.error }); }
      this.logger.error("JMAP deactivated after 3 consecutive failures", { code: "jmap.renew.deactivated", emxId: emx.id, failures });
    } else {
      const failureResult = await this.db.updateExternalExchange(emx.accountId, emx.id, emx.status, emx.nextSyncTime!, { consecutiveFailures: failures });
      if (failureResult.isErr()) { this.logger.warn("Failed to update JMAP consecutive failures", { code: "jmap.renew.failure_write_failed", emxId: emx.id, error: failureResult.error }); }
    }
    return err({ kind: "provider_renewal_failed", cause: causeStr });
  }

  // ---------------------------------------------------------------------------
  // Private: fallback when cannotCalculateChanges
  // ---------------------------------------------------------------------------

  private async renewFallback(apiUrl: string, auth: string, jmapAccountId: string, inboxId: string, emx: ExternalMailExchange): Promise<Result<void, ProviderRenewalError>> {
    const queryResult = await jmapCall(apiUrl, auth, JMAP_USING, [
      ["Email/query", {
        accountId: jmapAccountId,
        filter: { inMailbox: inboxId },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit: 500,
      }, "q0"],
    ], 30_000);
    if (queryResult.isErr()) return err(queryResult.error);

    const queryResponse = queryResult.value[0] as [string, Record<string, unknown>, string] | undefined;
    if (!queryResponse || queryResponse[0] === "error") {
      return err({ kind: "provider_renewal_failed", cause: "Email/query fallback failed" });
    }

    const responseData = queryResponse[1] as { ids?: string[]; queryState?: string };
    const ids = responseData.ids ?? [];
    const newQueryState = responseData.queryState;

    if (!newQueryState) {
      return err({ kind: "provider_renewal_failed", cause: "Missing queryState in fallback" });
    }

    // Enqueue all IDs via batch — pipeline deduplicates
    const entries = ids.map((emailId, i) => ({
      id: `jmap-fb-${i}`,
      payload: { source: "jmap", providerMessageId: emailId, emxId: emx.id, accountId: emx.accountId },
    }));
    const batchResult = await this.signalQueue.sendBatch("emx_inbound", entries);
    if (batchResult.isErr()) {
      this.logger.error(`JMAP fallback: failed to enqueue emx_inbound batch: ${batchResult.error.message}`, { code: "jmap.renew.fallback_batch_failed", emxId: emx.id, count: entries.length, error: batchResult.error });
      return err({ kind: "provider_renewal_failed", cause: "SQS batch send failed" });
    }

    const fallbackCursorResult = await this.db.updateExternalExchange(emx.accountId, emx.id, emx.status, DateTime.utc().plus({ minutes: POLL_INTERVAL_MINUTES }).toISO()!, {
      syncCursor: newQueryState,
      lastSyncAt: DateTime.utc().toISO()!,
      consecutiveFailures: 0,
    });
    if (fallbackCursorResult.isErr()) { this.logger.warn("Failed to update JMAP fallback sync cursor", { code: "jmap.renew.fallback_cursor_update_failed", emxId: emx.id, error: fallbackCursorResult.error }); }

    this.logger.info("JMAP sync fallback complete", { code: "jmap.renew.fallback_synced", emxId: emx.id, newMessages: ids.length, newQueryState });

    return ok(undefined);
  }
}
