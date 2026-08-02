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
// Provider message ID utilities
// ---------------------------------------------------------------------------

export function formatProviderMessageId(emxId: string, uid: number): string {
  return `${emxId}:${uid}`;
}

export function parseProviderMessageId(id: string): { emxId: string; uid: number } {
  const lastColon = id.lastIndexOf(":");
  if (lastColon < 1) throw new Error(`Invalid providerMessageId: ${id}`);
  const emxId = id.slice(0, lastColon);
  const uid = Number(id.slice(lastColon + 1));
  if (!Number.isFinite(uid) || uid < 1) throw new Error(`Invalid providerMessageId UID: ${id}`);
  return { emxId, uid };
}

// ---------------------------------------------------------------------------
// IMAP client factory
// ---------------------------------------------------------------------------

export function createImapClient(config: { host: string; tlsConfig: "TLS" | "DISABLED"; username: string; password: string; timeout: number }): ImapFlow {
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
    return new ImapFlow({ ...options, tls: { minVersion: "TLSv1.2", rejectUnauthorized: true } });
  }
  return new ImapFlow(options);
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
    const client = createImapClient({
      host: imapConfig.host,
      tlsConfig: imapConfig.tlsConfig,
      username: imapConfig.username,
      password: imapConfig.encryptedPassword,
      timeout: 10_000,
    });

    try {
      await client.connect();

      const lock = await client.getMailboxLock("INBOX");
      try {
        const mailbox = client.mailbox;
        if (!mailbox) {
          return err({ kind: "provider_activation_failed", cause: "INBOX unavailable" });
        }

        const uidvalidity = Number(mailbox.uidValidity);
        const uidNext = mailbox.uidNext;
        const lastUid = uidNext > 1 ? uidNext - 1 : 0;

        const syncCursor = formatSyncCursor(uidvalidity, lastUid);
        const expiresAt = DateTime.utc().plus({ hours: 1 }).toISO()!;

        return ok({ syncCursor, expiresAt, providerSubscriptionId: "poll" });
      } finally {
        lock.release();
      }
    } catch (e: unknown) {
      const reason = classifyActivationError(e);
      return err({ kind: "provider_activation_failed", cause: reason });
    } finally {
      try { await client.logout(); } catch { /* best-effort logout */ }
    }
  }

  async renew(_token: string, emx: ExternalMailExchange): Promise<Result<RenewalResult, ProviderRenewalError>> {
    const imapConfig = emx.imapConfig;
    if (!imapConfig) {
      return err({ kind: "provider_renewal_failed", cause: "Missing imapConfig" });
    }

    const password = this.encryptionManager.decrypt(imapConfig.encryptedPassword);

    const client = createImapClient({
      host: imapConfig.host,
      tlsConfig: imapConfig.tlsConfig,
      username: imapConfig.username,
      password,
      timeout: 30_000,
    });

    try {
      await client.connect();

      const lock = await client.getMailboxLock("INBOX");
      try {
        const mailbox = client.mailbox;
        if (!mailbox) {
          return err({ kind: "provider_renewal_failed", cause: "INBOX unavailable" });
        }

        const { uidvalidity: storedUidvalidity, lastUid } = parseSyncCursor(emx.syncCursor!);
        const currentUidvalidity = Number(mailbox.uidValidity);

        if (currentUidvalidity !== storedUidvalidity) {
          return err({ kind: "provider_renewal_failed", cause: "Mailbox was rebuilt on the server (UIDVALIDITY changed)" });
        }

        // UID SEARCH for UIDs > lastUid
        const searchResults = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true }) as number[];
        // IMAP search is inclusive — filter to only UIDs actually > lastUid
        const newUids = searchResults.filter(uid => uid > lastUid).sort((a, b) => a - b);

        if (newUids.length > 0) {
          // Cap at 500 (take the lowest 500)
          const batch = newUids.slice(0, 500);

          // Enqueue emx_inbound per UID
          for (const uid of batch) {
            await this.signalQueue.send("emx_inbound", {
              source: "imap",
              providerMessageId: formatProviderMessageId(emx.id, uid),
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
      } finally {
        lock.release();
      }
    } catch (e: unknown) {
      const cause = e instanceof Error ? e.message : "IMAP renewal failed";
      return err({ kind: "provider_renewal_failed", cause });
    } finally {
      try { await client.logout(); } catch { /* best-effort logout */ }
    }
  }

  async deactivate(_token: string, _emx: ExternalMailExchange): Promise<Result<void, ProviderDeactivationError>> {
    return ok(undefined);
  }

  async fetchMessage(_token: string, _providerMessageId: string): Promise<Result<RawMimeResult, ProviderFetchError>> {
    return err({ kind: "provider_fetch_failed", cause: "Not implemented" });
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
    if (msg.includes("inbox") && (msg.includes("not found") || msg.includes("does not exist") || msg.includes("no such"))) {
      return "INBOX unavailable";
    }
  }
  if (e && typeof e === "object" && "code" in e) {
    const code = (e as { code: string }).code;
    if (code === "CONNECT_TIMEOUT" || code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH") {
      return "host unreachable";
    }
  }
  return "host unreachable";
}
