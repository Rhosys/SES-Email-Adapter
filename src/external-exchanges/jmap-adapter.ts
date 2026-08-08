import { DateTime } from "luxon";
import { ok, err } from "../errors.js";
import type { Result } from "../errors.js";
import type { ExternalMailExchange } from "../types/index.js";
import type {
  ProviderAdapter,
  ActivationResult,
  ActivationIdentity,
  RawMimeResult,
  ProviderActivationError,
  ProviderRenewalError,
  ProviderDeactivationError,
  ProviderFetchError,
} from "./provider-adapter.js";
import type { EncryptionManager } from "../secrets/encryption-manager.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { SignalQueue } from "../messaging/signal-queue.js";
import type { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// JMAP types
// ---------------------------------------------------------------------------

interface JmapSession {
  apiUrl: string;
  downloadUrl: string;
  primaryAccounts: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const JMAP_USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"] as const;
const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";

export function buildBasicAuth(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

export async function fetchSession(sessionUrl: string, auth: string, timeout: number): Promise<Result<JmapSession, ProviderActivationError>> {
  let response: Response;
  try {
    response = await fetch(sessionUrl, {
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

  return ok({
    apiUrl: session["apiUrl"] as string,
    downloadUrl: session["downloadUrl"] as string,
    primaryAccounts,
  });
}

async function jmapCall(apiUrl: string, auth: string, using: readonly string[], methodCalls: unknown[][], timeout: number): Promise<Result<unknown[][], ProviderRenewalError>> {
  let response: Response;
  try {
    response = await fetch(apiUrl, {
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
  db: AccountDatabase;
  signalQueue: SignalQueue;
  logger: Logger;
}

export class JmapAdapter implements ProviderAdapter {
  private readonly encryptionManager: EncryptionManager;
  private readonly db: AccountDatabase;
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
      expiresAt: DateTime.utc().plus({ hours: 1 }).toISO()!,
      providerSubscriptionId: "poll",
      emailAddress: jmapConfig.username,
    });
  }

  async renew(emx: ExternalMailExchange): Promise<Result<void, ProviderRenewalError>> {
    const jmapConfig = emx.jmapConfig;
    if (!jmapConfig) {
      return err({ kind: "provider_renewal_failed", cause: "Missing jmapConfig" });
    }

    let password: string;
    try {
      password = this.encryptionManager.decrypt(jmapConfig.encryptedPassword);
    } catch (e) {
      return err({ kind: "provider_renewal_failed", cause: e });
    }

    const auth = buildBasicAuth(jmapConfig.username, password);

    const sessionResult = await fetchSession(jmapConfig.sessionUrl, auth, 30_000);
    if (sessionResult.isErr()) {
      const failures = (emx.consecutiveFailures ?? 0) + 1;
      if (failures >= 3) {
        await this.db.updateExternalExchange(emx.accountId, emx.id, {
          status: "activation_failed",
          errorReason: String(sessionResult.error.cause),
          consecutiveFailures: failures,
        });
        this.logger.error("JMAP deactivated after 3 consecutive failures", { code: "jmap.renew.deactivated", emxId: emx.id, failures });
      } else {
        await this.db.updateExternalExchange(emx.accountId, emx.id, { consecutiveFailures: failures });
        this.logger.warn("JMAP session fetch failed", { code: "jmap.renew.session_failed", emxId: emx.id, failures, cause: sessionResult.error.cause });
      }
      return err({ kind: "provider_renewal_failed", cause: sessionResult.error.cause });
    }
    const session = sessionResult.value;
    const jmapAccountId = session.primaryAccounts[MAIL_CAPABILITY]!;

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
      const failures = (emx.consecutiveFailures ?? 0) + 1;
      if (failures >= 3) {
        await this.db.updateExternalExchange(emx.accountId, emx.id, {
          status: "activation_failed",
          errorReason: String(queryChangesResult.error.cause),
          consecutiveFailures: failures,
        });
        this.logger.error("JMAP deactivated after 3 consecutive failures", { code: "jmap.renew.deactivated", emxId: emx.id, failures });
      } else {
        await this.db.updateExternalExchange(emx.accountId, emx.id, { consecutiveFailures: failures });
        this.logger.warn("JMAP queryChanges failed", { code: "jmap.renew.query_changes_failed", emxId: emx.id, failures, cause: queryChangesResult.error.cause });
      }
      return err(queryChangesResult.error);
    }

    const qcResponse = queryChangesResult.value[0] as [string, Record<string, unknown>, string] | undefined;

    if (qcResponse && qcResponse[0] === "error") {
      const errorType = (qcResponse[1] as { type?: string }).type;
      if (errorType === "cannotCalculateChanges") {
        return this.renewFallback(session.apiUrl, auth, jmapAccountId, jmapConfig.inboxId, emx);
      }
      const failures = (emx.consecutiveFailures ?? 0) + 1;
      if (failures >= 3) {
        await this.db.updateExternalExchange(emx.accountId, emx.id, {
          status: "activation_failed",
          errorReason: `JMAP error: ${errorType}`,
          consecutiveFailures: failures,
        });
        this.logger.error("JMAP deactivated after 3 consecutive failures", { code: "jmap.renew.deactivated", emxId: emx.id, failures });
      } else {
        await this.db.updateExternalExchange(emx.accountId, emx.id, { consecutiveFailures: failures });
      }
      return err({ kind: "provider_renewal_failed", cause: `JMAP error: ${errorType}` });
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
      this.logger.error("JMAP: failed to enqueue emx_inbound batch", { code: "jmap.renew.batch_failed", emxId: emx.id, count: entries.length, error: batchResult.error });
      return err({ kind: "provider_renewal_failed", cause: "SQS batch send failed" });
    }

    await this.db.updateExternalExchange(emx.accountId, emx.id, {
      syncCursor: newQueryState,
      lastSyncAt: DateTime.utc().toISO()!,
      nextSyncTime: DateTime.utc().plus({ hours: 1 }).toISO()!,
      consecutiveFailures: 0,
    });

    this.logger.info("JMAP sync complete", { code: "jmap.renew.synced", emxId: emx.id, newMessages: added.length, newQueryState });

    return ok(undefined);
  }

  async deactivate(_emx: ExternalMailExchange): Promise<Result<void, ProviderDeactivationError>> {
    return ok(undefined);
  }

  async fetchMessage(providerMessageId: string, emx: ExternalMailExchange): Promise<Result<RawMimeResult, ProviderFetchError>> {
    const jmapConfig = emx.jmapConfig;
    if (!jmapConfig) {
      return err({ kind: "provider_fetch_failed", cause: "EMX missing jmapConfig" });
    }

    let password: string;
    try {
      password = this.encryptionManager.decrypt(jmapConfig.encryptedPassword);
    } catch (e) {
      return err({ kind: "provider_fetch_failed", cause: e });
    }

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
      mimeResponse = await fetch(downloadUrl, {
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
      this.logger.error("JMAP fallback: failed to enqueue emx_inbound batch", { code: "jmap.renew.fallback_batch_failed", emxId: emx.id, count: entries.length, error: batchResult.error });
      return err({ kind: "provider_renewal_failed", cause: "SQS batch send failed" });
    }

    await this.db.updateExternalExchange(emx.accountId, emx.id, {
      syncCursor: newQueryState,
      lastSyncAt: DateTime.utc().toISO()!,
      nextSyncTime: DateTime.utc().plus({ hours: 1 }).toISO()!,
      consecutiveFailures: 0,
    });

    this.logger.info("JMAP sync fallback complete", { code: "jmap.renew.fallback_synced", emxId: emx.id, newMessages: ids.length, newQueryState });

    return ok(undefined);
  }
}
