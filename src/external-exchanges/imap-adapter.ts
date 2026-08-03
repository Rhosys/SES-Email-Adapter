import { ImapFlow } from "imapflow";
import { DateTime } from "luxon";
import { ok, err } from "../errors.js";
import type { Result } from "../errors.js";
import type { ExternalMailExchange } from "../types/index.js";
import type {
  ProviderAdapter,
  ActivationResult,
  RenewalResult,
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
// ImapConnection — pure IMAP operations, no business logic
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
      // DISABLED: plaintext on port 143, no STARTTLS upgrade
      this.client = new ImapFlow({ ...options, doSTARTTLS: false });
    }
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async getInboxState(): Promise<{ uidvalidity: number; uidNext: number; exists: number }> {
    const lock = await this.client.getMailboxLock("INBOX");
    try {
      const mailbox = this.client.mailbox;
      if (!mailbox) throw new Error("INBOX unavailable");
      return {
        uidvalidity: Number(mailbox.uidValidity),
        uidNext: mailbox.uidNext,
        exists: mailbox.exists,
      };
    } finally {
      lock.release();
    }
  }

  async searchNewUids(afterUid: number): Promise<number[]> {
    const lock = await this.client.getMailboxLock("INBOX");
    try {
      const searchResults = await this.client.search({ uid: `${afterUid + 1}:*` }, { uid: true }) as number[];
      return searchResults.filter(uid => uid > afterUid).sort((a, b) => a - b);
    } finally {
      lock.release();
    }
  }

  async fetchEnvelopes(startUid: number, limit: number): Promise<Array<{ uid: number; subject: string; from: string }>> {
    const lock = await this.client.getMailboxLock("INBOX");
    try {
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
      return results;
    } finally {
      lock.release();
    }
  }

  async fetchRawMessage(uid: number): Promise<{ rawMime: Uint8Array; receivedAt: string } | undefined> {
    const lock = await this.client.getMailboxLock("INBOX");
    try {
      const msg = await this.client.fetchOne(uid.toString(), { source: true, internalDate: true }, { uid: true });
      if (!msg) return undefined;
      return {
        rawMime: msg.source as Uint8Array,
        receivedAt: (msg.internalDate as Date).toISOString(),
      };
    } finally {
      lock.release();
    }
  }

  async listMailboxes(): Promise<Array<{ path: string; flags: string[] }>> {
    const mailboxes = await this.client.list();
    return mailboxes.map(mb => ({ path: mb.path, flags: [...(mb.flags || [])] }));
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

  async activate(_token: string, emx: ExternalMailExchange): Promise<Result<ActivationResult, ProviderActivationError>> {
    const imapConfig = emx.imapConfig;
    if (!imapConfig) {
      return err({ kind: "provider_activation_failed", cause: "Missing imapConfig" });
    }

    // During activation, encryptedPassword holds the raw password (caller encrypts after activation succeeds)
    const conn = new ImapConnection({
      host: imapConfig.host,
      tlsConfig: imapConfig.tlsConfig,
      username: imapConfig.username,
      password: imapConfig.encryptedPassword,
      timeout: 10_000,
    });

    try {
      await conn.connect();
      const { uidvalidity, uidNext } = await conn.getInboxState();
      const lastUid = uidNext > 1 ? uidNext - 1 : 0;
      const syncCursor = formatSyncCursor(uidvalidity, lastUid);
      const expiresAt = DateTime.utc().plus({ hours: 1 }).toISO()!;
      return ok({ syncCursor, expiresAt, providerSubscriptionId: "poll" });
    } catch (e: unknown) {
      const reason = classifyActivationError(e);
      return err({ kind: "provider_activation_failed", cause: reason });
    } finally {
      await conn.logout();
    }
  }

  async renew(_token: string, emx: ExternalMailExchange): Promise<Result<RenewalResult, ProviderRenewalError>> {
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

    try {
      await conn.connect();
      const { uidvalidity: currentUidvalidity } = await conn.getInboxState();

      const { uidvalidity: storedUidvalidity, lastUid } = parseSyncCursor(emx.syncCursor!);

      if (currentUidvalidity !== storedUidvalidity) {
        return err({ kind: "provider_renewal_failed", cause: "Mailbox was rebuilt on the server (UIDVALIDITY changed)" });
      }

      const newUids = await conn.searchNewUids(lastUid);

      if (newUids.length > 0) {
        // Cap at 500 (take the lowest 500)
        const batch = newUids.slice(0, 500);

        // Enqueue emx_inbound per UID
        for (const uid of batch) {
          await this.signalQueue.send("emx_inbound", {
            source: "imap",
            providerMessageId: String(uid),
            emxId: emx.id,
            accountId: emx.accountId,
          });
        }

        // Update syncCursor to highest UID in batch
        const highestUid = batch[batch.length - 1]!;
        await this.db.updateExternalExchange(emx.accountId, emx.id, {
          syncCursor: formatSyncCursor(currentUidvalidity, highestUid),
          lastSyncAt: DateTime.utc().toISO()!,
        });
      }

      return ok({ expiresAt: DateTime.utc().plus({ hours: 1 }).toISO()! });
    } catch (e: unknown) {
      const cause = e instanceof Error ? e.message : "IMAP renewal failed";
      return err({ kind: "provider_renewal_failed", cause });
    } finally {
      await conn.logout();
    }
  }

  async deactivate(_token: string, _emx: ExternalMailExchange): Promise<Result<void, ProviderDeactivationError>> {
    return ok(undefined);
  }

  async fetchMessage(_token: string, providerMessageId: string, emx: ExternalMailExchange): Promise<Result<RawMimeResult, ProviderFetchError>> {
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

    try {
      await conn.connect();
      const result = await conn.fetchRawMessage(uid);
      if (!result) {
        return err({ kind: "provider_message_not_found" });
      }
      return ok(result);
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("does not exist")) {
        return err({ kind: "provider_message_not_found" });
      }
      return err({ kind: "provider_fetch_failed", cause: e });
    } finally {
      await conn.logout();
    }
  }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyActivationError(e: unknown): string {
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
