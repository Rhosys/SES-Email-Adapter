import { DateTime } from "luxon";
import { ok } from "../errors.js";
import type { Result } from "../errors.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";

interface EmxDispatchWorkerDeps {
  logger: Logger;
  db: AccountDatabase;
  adapters: Record<string, ProviderAdapter>;
  getProviderToken: (connectionUserId: string, connectionId: string) => Promise<string>;
}

export interface EmxDispatchPayload {
  emxId?: string;
  accountId?: string;
}

export class EmxDispatchWorker {
  private readonly logger: Logger;
  private readonly db: AccountDatabase;
  private readonly adapters: Record<string, ProviderAdapter>;
  private readonly getProviderToken: EmxDispatchWorkerDeps["getProviderToken"];

  constructor(deps: EmxDispatchWorkerDeps) {
    this.logger = deps.logger;
    this.db = deps.db;
    this.adapters = deps.adapters;
    this.getProviderToken = deps.getProviderToken;
  }

  async dispatch(payload?: EmxDispatchPayload): Promise<Result<void, never>> {
    // Targeted dispatch: process only the specified exchange
    if (payload?.emxId && payload.accountId) {
      const getResult = await this.db.getExternalExchange(payload.accountId, payload.emxId);
      if (getResult.isErr()) {
        this.logger.error("emx_dispatch: failed to fetch targeted exchange", { code: "emx.dispatch.targeted_fetch_failed", emxId: payload.emxId, error: getResult.error });
        return ok(undefined);
      }
      const emx = getResult.value;
      if (!emx || emx.status !== "active") {
        this.logger.info("emx_dispatch: targeted exchange not active, skipping", { code: "emx.dispatch.targeted_skip", emxId: payload.emxId, status: emx?.status });
        return ok(undefined);
      }
      await this.processExchange(emx);
      return ok(undefined);
    }

    // Sweep dispatch: process all expiring exchanges
    const horizon = DateTime.utc().plus({ hours: 12 }).toISO()!;

    const expiringResult = await this.db.listExpiringExchanges(horizon);
    if (expiringResult.isErr()) {
      this.logger.error("emx_dispatch: failed to query expiring exchanges", { code: "emx.dispatch.query_failed", error: expiringResult.error });
      return ok(undefined);
    }

    const expiring = expiringResult.value;
    this.logger.info("emx_dispatch: processing expiring exchanges", { code: "emx.dispatch.start", count: expiring.length, horizon });

    for (const emx of expiring) {
      await this.processExchange(emx);
    }

    return ok(undefined);
  }

  private async processExchange(emx: import("../types/index.js").ExternalMailExchange): Promise<void> {
    const adapter = this.adapters[emx.platform];
    if (!adapter) {
      this.logger.warn("emx_dispatch: no adapter for platform", { code: "emx.dispatch.no_adapter", platform: emx.platform, emxId: emx.id });
      return;
    }

    let token: string;
    if (emx.platform === "imap" || emx.platform === "jmap") {
      token = "";
    } else {
      if (!emx.connectionUserId) {
        this.logger.error("emx_dispatch: exchange has no linked connection user, so its provider credentials cannot be fetched. It predates connection-user tracking and must be reconnected by the user.", { code: "emx.dispatch.no_connection_user", emxId: emx.id, platform: emx.platform });
        return;
      }
      try {
        token = await this.getProviderToken(emx.connectionUserId, emx.platform === "gmail" ? "google" : "microsoft");
      } catch (e) {
        this.logger.error("emx_dispatch: failed to get provider token", { code: "emx.dispatch.token_failed", emxId: emx.id, platform: emx.platform, error: e });
        return;
      }
    }

    // Adapters own all DB writes (cursor, timing, failure tracking) internally
    const renewResult = await adapter.renew(token, emx);
    if (renewResult.isErr()) {
      this.logger.error("emx_dispatch: renewal failed", { code: "emx.dispatch.renewal_failed", emxId: emx.id, platform: emx.platform, error: renewResult.error });
      return;
    }

    this.logger.info("emx_dispatch: renewed successfully", { code: "emx.dispatch.renewed", emxId: emx.id, platform: emx.platform });
  }
}
