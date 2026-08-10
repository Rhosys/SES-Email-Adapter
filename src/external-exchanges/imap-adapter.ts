import { ImapFlow } from "imapflow";
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
// Sync cursor utilities
// ---------------------------------------------------------------------------

export function formatSyncCursor(uidvalidity: number, lastUid: number): string {
  return `${uidvalidity}:${lastUid}`;
}

export function parseSyncCursor(cursor: string): { uidvalidity: number; lastUid: number } {
  const idx = cursor.indexOf(":");
  if (idx < 1) throw new Error(`Invalid sync cursor: ${cursor}`);
  const uidvalidity = Number(cursor.slice(0, idx));
  const lastUid = Number(cursor.slice(idx + 1));
  if (!Number.isFinite(uidvalidity) || uidvalidity < 0 || !Number.isFinite(lastUid) || lastUid < 0) {
    throw new Error(`Invalid sync cursor values: ${cursor}`);
  }
  return { uidvalidity, lastUid };
}

// ---------------------------------------------------------------------------
// IMAP connection config
// ---------------------------------------------------------------------------

export interface ImapConnectionConfig {
  host: string;
  tlsConfig: "TLS" | "DISABLED";
  username: string;
  password: string;
  timeout: number;
}

// ---------------------------------------------------------------------------
// IMAP error type — replaces all thrown exceptions from imapflow
// ---------------------------------------------------------------------------

export type ImapError = { kind: "imap_error"; reason: string; cause: unknown };

function imapErr(e: unknown): ImapError {
  const reason = e instanceof Error ? e.message : String(e);
  return { kind: "imap_error", reason, cause: e };
}

function classifyImapError(e: unknown): string {
  if (e instanceof Error) {
    if ("authenticationFailed" in e && (e as { authenticationFailed: boolean }).authenticationFailed) {
      return "invalid credentials";
    }
    const msg = e.message.toLowerCase();
    if (msg.includes("timeout") || msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("ehostunreach")) {
      return "host unreachable";
    }
    if (msg.includes("certificate") || msg.includes("cert") || msg.includes("ssl") || msg.includes("tls") || msg.includes("self.signed") || msg.includes("self-signed")) {
      return e.message.slice(0, 256);
    }
    if (msg.includes("inbox") && (msg.includes("not found") || msg.includes("does not exist") || msg.includes("no such"))) {
      return "INBOX unavailable";
    }
    return e.message.slice(0, 256);
  }
  if (e && typeof e === "object" && "code" in e) {
    const code = (e as { code: string }).code;
    if (code === "CONNECT_TIMEOUT" || code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH") {
      return "host unreachable";
    }
  }
  return String(e).slice(0, 256);
}

// ---------------------------------------------------------------------------
// ImapConnection — pure IMAP operations, never throws
// ---------------------------------------------------------------------------

export class ImapConnection {
  private client: ImapFlow;

  constructor(config: ImapConnectionConfig) {
    const options = {
      host: config.host,
      port: config.tlsConfig === "TLS" ? 993 : 143,
      secure: config.tlsConfig === "TLS",
      auth: { user: config.username, pass: config.password },
      connectionTimeout: config.timeout,
      greetingTimeout: config.timeout,
      socketTimeout: config.timeout,
      logger: false as const,
    };

    if (config.tlsConfig === "TLS") {
      this.client = new ImapFlow({ ...options, tls: { minVersion: "TLSv1.2", rejectUnauthorized: true } });
    } else {
      this.client = new ImapFlow({ ...options, doSTARTTLS: false });
    }
  }

  async connect(): Promise<Result<void, ImapError>> {
    try {
      await this.client.connect();
      return ok(undefined);
    } catch (e) {
      return err(imapErr(e));
    }
  }

  async getInboxState(): Promise<Result<{ uidvalidity: number; uidNext: number; exists: number }, ImapError>> {
    try {
      const mailbox = await this.client.mailboxOpen("INBOX", { readOnly: true });
      return ok({
        uidvalidity: Number(mailbox.uidValidity),
        uidNext: mailbox.uidNext,
        exists: mailbox.exists,
      });
    } catch (e) {
      return err(imapErr(e));
    }
  }

  async searchNewUids(lastKnownUid: number): Promise<Result<number[], ImapError>> {
    try {
      await this.client.mailboxOpen("INBOX", { readOnly: true });
      const searchResults = await this.client.search({ uid: `${lastKnownUid + 1}:*` }, { uid: true }) as number[];
      return ok(searchResults.filter(uid => uid > lastKnownUid).sort((a, b) => a - b));
    } catch (e) {
      return err(imapErr(e));
    }
  }

  async fetchEnvelopes(startUid: number, limit: number): Promise<Result<Array<{ uid: number; subject: string; from: string }>, ImapError>> {
    try {
      await this.client.mailboxOpen("INBOX", { readOnly: true });
      const results: Array<{ uid: number; subject: string; from: string }> = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const msg of this.client.fetch(`${startUid}:*`, { envelope: true, uid: true }) as AsyncIterable<any>) {
        const envelope = msg.envelope;
        const from = envelope?.from?.[0];
        results.push({
          uid: msg.uid as number,
          subject: (envelope?.subject as string) || "(no subject)",
          from: from ? `${from.name || ""} <${from.address || ""}>`.trim() : "(unknown)",
        });
        if (results.length >= limit) break;
      }
      return ok(results);
    } catch (e) {
      return err(imapErr(e));
    }
  }

  async fetchRawMessage(uid: number): Promise<Result<{ rawMime: Uint8Array; receivedAt: string } | null, ImapError>> {
    try {
      await this.client.mailboxOpen("INBOX", { readOnly: true });
      const msg = await this.client.fetchOne(uid.toString(), { source: true, internalDate: true }, { uid: true });
      if (!msg) return ok(null);
      return ok({
        rawMime: msg.source as Uint8Array,
        receivedAt: (msg.internalDate as Date).toISOString(),
      });
    } catch (e) {
      return err(imapErr(e));
    }
  }

  async listMailboxes(): Promise<Result<Array<{ path: string; flags: string[] }>, ImapError>> {
    try {
      const mailboxes = await this.client.list();
      return ok(mailboxes.map(mb => ({ path: mb.path, flags: [...(mb.flags || [])] })));
    } catch (e) {
      return err(imapErr(e));
    }
  }

  /**
   * Enter IMAP IDLE on INBOX and wait for new mail (EXISTS event) or timeout.
   * imapflow enters IDLE automatically when a mailbox lock is held and no commands are running.
   * We listen for the 'exists' event which fires when the server sends an untagged EXISTS response.
   */
  async idle(timeoutMs: number): Promise<Result<"new_mail" | "timeout", ImapError>> {
    let lock: { release: () => void } | undefined;
    try {
      lock = await this.client.getMailboxLock("INBOX");
      return await new Promise<Result<"new_mail" | "timeout", ImapError>>((resolve) => {
        const timer = setTimeout(() => {
          this.client.removeAllListeners("exists");
          lock!.release();
          resolve(ok("timeout" as const));
        }, timeoutMs);

        this.client.on("exists", (_data: { path: string; count: number; prevCount: number }) => {
          clearTimeout(timer);
          this.client.removeAllListeners("exists");
          lock!.release();
          resolve(ok("new_mail" as const));
        });
      });
    } catch (e) {
      if (lock) lock.release();
      return err(imapErr(e));
    }
  }

  async logout(): Promise<void> {
    try { await this.client.logout(); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Legacy factory (kept for any direct callers during migration)
// ---------------------------------------------------------------------------

export function createImapClient(config: ImapConnectionConfig): ImapFlow {
  const conn = new ImapConnection(config);
  return (conn as unknown as { client: ImapFlow }).client;
}

// ---------------------------------------------------------------------------
// ImapAdapter
// ---------------------------------------------------------------------------

interface ImapAdapterDeps {
  encryptionManager: EncryptionManager;
  db: AccountDatabase;
  signalQueue: SignalQueue;
  logger: Logger;
}

export class ImapAdapter implements ProviderAdapter {
  private readonly encryptionManager: EncryptionManager;
  private readonly db: AccountDatabase;
  private readonly signalQueue: SignalQueue;
  private readonly logger: Logger;

  constructor(deps: ImapAdapterDeps) {
    this.encryptionManager = deps.encryptionManager;
    this.db = deps.db;
    this.signalQueue = deps.signalQueue;
    this.logger = deps.logger;
  }

  async activate(emx: ExternalMailExchange, _identity?: ActivationIdentity): Promise<Result<ActivationResult, ProviderActivationError>> {
    const imapConfig = emx.imapConfig;
    if (!imapConfig) {
      return err({ kind: "provider_activation_failed", cause: "Missing imapConfig" });
    }

    const conn = new ImapConnection({
      host: imapConfig.host,
      tlsConfig: imapConfig.tlsConfig,
      username: imapConfig.username,
      password: imapConfig.encryptedPassword,
      timeout: 10_000,
    });

    const connectResult = await conn.connect();
    if (connectResult.isErr()) {
      const reason = classifyImapError(connectResult.error.cause);
      this.logger.info("IMAP activation failed", { code: "imap.activate.failed", host: imapConfig.host, username: imapConfig.username, reason });
      await conn.logout();
      return err({ kind: "provider_activation_failed", cause: reason });
    }

    const stateResult = await conn.getInboxState();
    await conn.logout();
    if (stateResult.isErr()) {
      const reason = classifyImapError(stateResult.error.cause);
      this.logger.info("IMAP activation failed", { code: "imap.activate.failed", host: imapConfig.host, username: imapConfig.username, reason });
      return err({ kind: "provider_activation_failed", cause: reason });
    }

    const { uidvalidity, uidNext } = stateResult.value;
    const lastUid = uidNext > 1 ? uidNext - 1 : 0;
    const syncCursor = formatSyncCursor(uidvalidity, lastUid);
    const expiresAt = DateTime.utc().plus({ minutes: 15 }).toISO()!;
    this.logger.info("IMAP activation succeeded", { code: "imap.activate.success", host: imapConfig.host, username: imapConfig.username, uidvalidity, lastUid });
    return ok({ syncCursor, expiresAt, providerSubscriptionId: "poll", emailAddress: imapConfig.username });
  }

  async renew(emx: ExternalMailExchange): Promise<Result<void, ProviderRenewalError>> {
    const imapConfig = emx.imapConfig;
    if (!imapConfig) {
      return err({ kind: "provider_renewal_failed", cause: "Missing imapConfig" });
    }

    const password = this.encryptionManager.decrypt(imapConfig.encryptedPassword);

    const conn = new ImapConnection({
      host: imapConfig.host,
      tlsConfig: imapConfig.tlsConfig,
      username: imapConfig.username,
      password,
      timeout: 30_000,
    });

    const connectResult = await conn.connect();
    if (connectResult.isErr()) {
      return this.handleRenewalFailure(emx, classifyImapError(connectResult.error.cause));
    }

    const stateResult = await conn.getInboxState();
    if (stateResult.isErr()) {
      await conn.logout();
      return this.handleRenewalFailure(emx, classifyImapError(stateResult.error.cause));
    }

    const { uidvalidity: currentUidvalidity } = stateResult.value;
    const { uidvalidity: storedUidvalidity, lastUid } = parseSyncCursor(emx.syncCursor!);

    if (currentUidvalidity !== storedUidvalidity) {
      await conn.logout();
      return this.handleRenewalFailure(emx, "Mailbox was rebuilt on the server (UIDVALIDITY changed)");
    }

    // Back up cursor by 10 to catch any messages that landed between cursor-write and this poll.
    // Pipeline deduplicates, so re-enqueuing already-processed UIDs is safe.
    const searchFrom = Math.max(0, lastUid - 10);
    const searchResult = await conn.searchNewUids(searchFrom);
    await conn.logout();

    if (searchResult.isErr()) {
      return this.handleRenewalFailure(emx, classifyImapError(searchResult.error.cause));
    }

    const newUids = searchResult.value;

    if (newUids.length > 0) {
      // Cap at 500 (take the lowest 500)
      const batch = newUids.slice(0, 500);

      // Enqueue emx_inbound via batch
      const entries = batch.map(uid => ({
        id: String(uid),
        payload: { source: "imap", providerMessageId: String(uid), emxId: emx.id, accountId: emx.accountId },
      }));
      const batchResult = await this.signalQueue.sendBatch("emx_inbound", entries);
      if (batchResult.isErr()) {
        this.logger.error("IMAP: failed to enqueue emx_inbound batch", { code: "imap.renew.batch_failed", emxId: emx.id, count: entries.length, error: batchResult.error });
        return err({ kind: "provider_renewal_failed", cause: "SQS batch send failed" });
      }

      // Update syncCursor to highest UID in batch
      const highestUid = batch[batch.length - 1]!;
      const cursorUpdateResult = await this.db.updateExternalExchange(emx.accountId, emx.id, {
        syncCursor: formatSyncCursor(currentUidvalidity, highestUid),
        lastSyncAt: DateTime.utc().toISO()!,
        nextSyncTime: DateTime.utc().plus({ minutes: 15 }).toISO()!,
        consecutiveFailures: 0,
      });
      if (cursorUpdateResult.isErr()) { this.logger.warn("Failed to update IMAP sync cursor after batch", { code: "imap.renew.cursor_update_failed", emxId: emx.id, error: cursorUpdateResult.error }); }

      this.logger.info("IMAP sync complete", { code: "imap.renew.synced", emxId: emx.id, newMessages: batch.length, highestUid });
    } else {
      // No new messages — just update timing
      const timingUpdateResult = await this.db.updateExternalExchange(emx.accountId, emx.id, {
        nextSyncTime: DateTime.utc().plus({ minutes: 15 }).toISO()!,
        consecutiveFailures: 0,
      });
      if (timingUpdateResult.isErr()) { this.logger.warn("Failed to update IMAP timing after empty sync", { code: "imap.renew.timing_update_failed", emxId: emx.id, error: timingUpdateResult.error }); }
      this.logger.info("IMAP sync complete, no new messages", { code: "imap.renew.synced", emxId: emx.id, newMessages: 0 });
    }

    return ok(undefined);
  }

  async deactivate(_emx: ExternalMailExchange): Promise<Result<void, ProviderDeactivationError>> {
    return ok(undefined);
  }

  async fetchMessage(providerMessageId: string, emx: ExternalMailExchange): Promise<Result<RawMimeResult, ProviderFetchError>> {
    const imapConfig = emx.imapConfig;
    if (!imapConfig) {
      return err({ kind: "provider_fetch_failed", cause: "EMX missing imapConfig" });
    }

    const uid = Number(providerMessageId);
    if (!Number.isFinite(uid) || uid < 1) {
      return err({ kind: "provider_fetch_failed", cause: "Invalid providerMessageId: expected a UID number" });
    }

    let password: string;
    try {
      password = this.encryptionManager.decrypt(imapConfig.encryptedPassword);
    } catch (e) {
      return err({ kind: "provider_fetch_failed", cause: e });
    }

    const conn = new ImapConnection({
      host: imapConfig.host,
      tlsConfig: imapConfig.tlsConfig,
      username: imapConfig.username,
      password,
      timeout: 30_000,
    });

    const connectResult = await conn.connect();
    if (connectResult.isErr()) {
      return err({ kind: "provider_fetch_failed", cause: connectResult.error.cause });
    }

    const fetchResult = await conn.fetchRawMessage(uid);
    await conn.logout();

    if (fetchResult.isErr()) {
      const reason = fetchResult.error.reason;
      if (reason.includes("does not exist")) {
        return err({ kind: "provider_message_not_found" });
      }
      return err({ kind: "provider_fetch_failed", cause: fetchResult.error.cause });
    }

    const message = fetchResult.value;
    if (!message) {
      return err({ kind: "provider_message_not_found" });
    }
    return ok(message);
  }

  // ---------------------------------------------------------------------------
  // Private: handle renewal failure with consecutive failure tracking
  // ---------------------------------------------------------------------------

  private async handleRenewalFailure(emx: ExternalMailExchange, cause: string): Promise<Result<void, ProviderRenewalError>> {
    this.logger.info("IMAP renewal failed", { code: "imap.renew.failed", emxId: emx.id, cause });
    const failures = (emx.consecutiveFailures ?? 0) + 1;
    if (failures >= 3) {
      const deactivateResult = await this.db.updateExternalExchange(emx.accountId, emx.id, {
        status: "activation_failed",
        errorReason: cause,
        consecutiveFailures: failures,
      });
      if (deactivateResult.isErr()) { this.logger.warn("Failed to deactivate IMAP exchange", { code: "imap.renew.deactivate_write_failed", emxId: emx.id, error: deactivateResult.error }); }
      this.logger.error("IMAP deactivated after 3 consecutive failures", { code: "imap.renew.deactivated", emxId: emx.id, failures });
    } else {
      const failureResult = await this.db.updateExternalExchange(emx.accountId, emx.id, { consecutiveFailures: failures });
      if (failureResult.isErr()) { this.logger.warn("Failed to update IMAP consecutive failures", { code: "imap.renew.failure_write_failed", emxId: emx.id, error: failureResult.error }); }
    }
    return err({ kind: "provider_renewal_failed", cause });
  }
}
