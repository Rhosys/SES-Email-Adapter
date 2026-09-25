import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { DateTime } from "luxon";
import { getDomain } from "tldts";
import { zParse } from "./validate.js";
import { toApiThread, toApiSignal, withResolvedContentUrls } from "./signal-transforms.js";
import { isEmailSignal, isInboundEmailSignalData } from "../types/index.js";
import type { Result } from "neverthrow";
import type { Signal, MatchedRuleResult, PageParams } from "../types/index.js";
import type { Pagination } from "../types/index.js";
import type { ThreadDatabase } from "../database/thread-database.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";
import type { NotFoundError, ProcessorError } from "../errors.js";
import { QuarantineResponse } from "./requests.js";
import { ListSignalsResponse } from "./schemas.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";

export interface SignalReprocessor {
  reprocessSignal(accountId: string, signalLookupId: string, opts?: { skipNotify?: boolean }): Promise<Result<Signal, ProcessorError | NotFoundError>>;
}

function page<K extends string, T>(key: K, items: T[], nextCursor?: string): Record<K, T[]> & { pagination: Pagination } {
  return { [key]: items, pagination: { cursor: nextCursor ?? null } } as Record<K, T[]> & { pagination: Pagination };
}

export class SignalsApi {
  constructor(
    private readonly threadDb: ThreadDatabase,
    private readonly accountDb: AccountDatabase,
    private readonly logger: Logger,
    private readonly contentCdnBaseUrl: string,
    private readonly signalReprocessor: SignalReprocessor,
  ) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { threadDb, accountDb, logger, contentCdnBaseUrl, signalReprocessor } = this;

    // -------------------------------------------------------------------------
    // 1. GET /accounts/{accountId}/signals — list quarantined signals
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/signals",
      tags: ["Signals"],
      request: {
        params: z.object({ accountId: z.string() }),
        query: z.object({ status: z.string(), cursor: z.string().optional(), limit: z.string().optional() }),
      },
      middleware: [authz("signals:read", c => `accounts/${c.req.param("accountId")!}/signals`)] as const,
      responses: { 200: { content: { "application/json": { schema: ListSignalsResponse } }, description: "List quarantined signals" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const query = c.req.query();
      const status = query["status"];
      const validStatuses = ["quarantined", "quarantine_visible", "quarantine_hidden", "blocked", "block_hidden", "block_reject"] as const;
      if (!validStatuses.includes(status as typeof validStatuses[number])) {
        return err(c, 400, "status query param must be one of: quarantined, quarantine_visible, quarantine_hidden, blocked, block_hidden, block_reject", "INVALID_STATUS");
      }
      const params: PageParams = {
        ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
        ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
      };
      const partition = (status === "blocked" || status === "block_hidden" || status === "block_reject") ? "blocked" : "quarantined";
      const result = await threadDb.listPreThreadSignals(accountId, partition, params);
      if (result.isErr()) { logger.error("Failed to list signals.", { code: "api.signals.list_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
      let items = (status === "quarantine_visible" || status === "quarantine_hidden" || status === "block_hidden" || status === "block_reject")
        ? result.value.items.filter(s => s.status === status)
        : result.value.items;

      // Hard cap: never return blocked/violation signals older than 30 days
      if (partition === "blocked") {
        const thirtyDaysAgo = DateTime.utc().minus({ days: 30 }).toISO()!;
        items = items.filter(s => s.createdAt >= thirtyDaysAgo);
      }

      // Apply after/before/sender filters (post-query — GSI sort key is signal.id, not a date)
      const afterParam = query["after"];
      const beforeParam = query["before"];
      const senderParam = query["sender"];
      if (afterParam) {
        items = items.filter(s => s.createdAt >= afterParam);
      }
      if (beforeParam) {
        items = items.filter(s => s.createdAt <= beforeParam);
      }
      if (senderParam) {
        const senderLower = senderParam.toLowerCase();
        items = items.filter(s => isEmailSignal(s) && s.data.from.address.toLowerCase().includes(senderLower));
      }

      const itemsWithUrls = items.map(s => withResolvedContentUrls(s, contentCdnBaseUrl));
      return c.json(page("signals", itemsWithUrls.map(toApiSignal), result.value.nextCursor), 200);
    });

    // -------------------------------------------------------------------------
    // 2. POST /accounts/{accountId}/signals/{id}/quarantineResponse
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/signals/{id}/quarantineResponse",
      tags: ["Signals"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: z.object({}) } }, description: "Quarantine response" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const signalId = c.req.param("id")!;
      logger.info("Processing quarantine response", { code: "api.signals.quarantine_response", accountId, signalId });

      // Signal is quarantined or blocked — try both partitions
      let signalResult = await threadDb.getSignalById(accountId, signalId, "QUARANTINED");
      if (signalResult.isErr()) { logger.error("Failed to get quarantined signal.", { code: "api.quarantine_response.get_signal_failed", error: signalResult.error }); return err(c, 500, "Internal Server Error"); }
      if (!signalResult.value) {
        signalResult = await threadDb.getSignalById(accountId, signalId, "BLOCKED");
        if (signalResult.isErr()) { logger.error("Failed to get blocked signal.", { code: "api.quarantine_response.get_signal_failed", error: signalResult.error }); return err(c, 500, "Internal Server Error"); }
      }

      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (signal.status !== "quarantine_visible" && signal.status !== "quarantine_hidden") {
        return err(c, 400, "Only quarantined signals can have their status updated", "SIGNAL_NOT_REVIEWABLE");
      }
      // Quarantined signals are always inbound received email — narrow so workflow/workflowData
      // (inbound-only classification) are accessible for grouping-key derivation below.
      if (!isInboundEmailSignalData(signal.data)) {
        return err(c, 400, "Only inbound email signals can be reviewed from quarantine", "SIGNAL_NOT_REVIEWABLE");
      }

      const body = await zParse(QuarantineResponse, c.req.raw);
      // Reaching this handler means the signal is quarantined, so the user is making an explicit
      // sender decision — always record it. The alias record is guaranteed to exist (created as an
      // invariant during ingest), so there is nothing to ensure and no rule-evaluation to consult.
      const senderDomain = signal.data.from.address.includes("@") ? signal.data.from.address.split("@").pop()! : signal.data.from.address;
      const senderETLD1 = getDomain(senderDomain) ?? senderDomain;
      const recipientAddress = signal.data.recipientAddress;

      // Enumerate the OTHER quarantine_visible signals this same decision must cascade to: same
      // alias + same sender eTLD+1, inbound email, excluding the primary. The user made one decision
      // about a sender; every visible quarantined message from that sender to that alias inherits it.
      // One page (limit 100) only — a sender with >100 quarantined messages to one alias is
      // pathological; the tail resolves on a later action. Best-effort: a failure to enumerate must
      // not fail the primary decision, so on error we log and cascade to nothing.
      const collectSiblings = async (): Promise<Signal[]> => {
        const listResult = await threadDb.listPreThreadSignals(accountId, "quarantined", { limit: 100 });
        if (listResult.isErr()) {
          logger.warn("Failed to enumerate sibling quarantined signals — cascading to primary only.", { code: "api.quarantine_response.sibling_list_failed", accountId, signalId, error: listResult.error });
          return [];
        }
        return listResult.value.items.filter((s) => {
          if (s.signalLookupId === signal.signalLookupId) return false;
          if (s.status !== "quarantine_visible") return false;
          if (!isInboundEmailSignalData(s.data)) return false;
          if (s.data.recipientAddress !== recipientAddress) return false;
          const sSenderDomain = s.data.from.address.includes("@") ? s.data.from.address.split("@").pop()! : s.data.from.address;
          return (getDomain(sSenderDomain) ?? sSenderDomain) === senderETLD1;
        });
      };

      if (body.status === "dismiss") {
        // Dismiss carries no sender opinion, so unlike a real block/reject/violation it would otherwise
        // leave no trace of why the signal ended up in the blocked partition. Record a synthetic
        // matchedRules entry under the same SR-00 id the processor already uses for rule-less
        // explanations, rather than minting a new id. matchedRules is an append-only trace, and the
        // API layer collapses same-id entries down to the last one on read (see collapseMatchedRules
        // in signal-transforms.ts) — so fold the prior SR-00 explanation (why it was quarantined) into
        // this one's text (that the user then dismissed it), and the collapsed view reads as a single
        // coherent story instead of the dismiss silently replacing the original reason.
        const dismiss = (s: Signal): Signal => {
          const priorSR00Text = s.data.matchedRules?.find(r => r.ruleId === "SR-00")?.text;
          const dismissText = priorSR00Text ? `${priorSR00Text} — dismissed by user from quarantine` : "Dismissed by user from quarantine";
          const dismissRule: MatchedRuleResult = { ruleId: "SR-00", actions: [{ type: "block_hidden" }], labelsAdded: [], statusChange: "block_hidden", text: dismissText };
          return { ...s, status: "block_hidden", data: { ...s.data, matchedRules: [...(s.data.matchedRules ?? []), dismissRule] } };
        };

        const dismissedSignal = dismiss(signal);
        const saveResult = await threadDb.saveSignal(dismissedSignal);
        if (saveResult.isErr()) { logger.error("Failed to dismiss signal.", { code: "api.quarantine_response.block_failed", error: saveResult.error }); return err(c, 500, "Internal Server Error"); }

        // Dismiss carries no sender opinion, so there is no saveSender to repeat — just fold each
        // sibling into the blocked partition too. Best-effort per sibling: log and continue.
        for (const sibling of await collectSiblings()) {
          const siblingSaveResult = await threadDb.saveSignal(dismiss(sibling));
          if (siblingSaveResult.isErr()) logger.warn("Failed to dismiss sibling quarantined signal — skipping.", { code: "api.quarantine_response.sibling_dismiss_failed", accountId, siblingSignalId: sibling.id, error: siblingSaveResult.error });
        }

        logger.info("Signal blocked", { code: "api.signals.blocked", accountId, signalId, decision: "block_hidden" });
        return c.json(dismissedSignal, 200);
      }

      if (body.status === "block_hidden" || body.status === "block_reject" || body.status === "report_violation") {
        const blockResult = await threadDb.updateSignalStatus(accountId, signal.signalLookupId, body.status);
        if (blockResult.isErr()) { logger.error("Failed to block signal.", { code: "api.quarantine_response.block_failed", error: blockResult.error }); return err(c, 500, "Internal Server Error"); }

        // Record the sender disposition ONCE — it is keyed by (alias, sender), so repeating it per
        // sibling would be a meaningless rewrite of the identical record. Blocking writes no Aurora
        // embedding, so there is no serial dependency: a plain status flip per sibling suffices.
        const saveSenderResult = await accountDb.saveSender(accountId, recipientAddress, senderETLD1, body.status);
        if (saveSenderResult.isErr()) { logger.error("Failed to save sender disposition.", { code: "api.quarantine_response.save_sender_failed", error: saveSenderResult.error }); return err(c, 500, "Internal Server Error"); }

        for (const sibling of await collectSiblings()) {
          const siblingBlockResult = await threadDb.updateSignalStatus(accountId, sibling.signalLookupId, body.status);
          if (siblingBlockResult.isErr()) logger.warn("Failed to block sibling quarantined signal — skipping.", { code: "api.quarantine_response.sibling_block_failed", accountId, siblingSignalId: sibling.id, error: siblingBlockResult.error });
        }

        logger.info("Signal blocked", { code: "api.signals.blocked", accountId, signalId, decision: body.status });
        return c.json(blockResult.value, 200);
      }

      // status === "active": approve the sender, then replay each affected signal through the
      // full ingest pipeline (reprocessSignal). Replay — rather than a bespoke thread build here —
      // is required because ingest is where embeddings are generated, the Aurora thread match runs,
      // and the embedding is persisted to Aurora. A quarantined signal has none of that (no vector,
      // no thread), so approving one has to run ingest for it to land on the right thread AND to
      // seed Aurora for the NEXT approved sibling to match against.

      // 1. Record the sender approval ONCE, up front. Keyed by (alias, sender) — repeating it per
      //    sibling is a meaningless rewrite. Writing it before any replay is what makes each replay
      //    resolve the now-trusted sender to `active` instead of re-quarantining.
      const saveSenderResult = await accountDb.saveSender(accountId, recipientAddress, senderETLD1, "allow");
      if (saveSenderResult.isErr()) { logger.error("Failed to save sender approval.", { code: "api.quarantine_response.save_sender_failed", error: saveSenderResult.error }); return err(c, 500, "Internal Server Error"); }

      // 2. Replay the PRIMARY first. Its Aurora embedding must exist before any sibling runs its
      //    thread match, so siblings collapse onto the thread the primary anchors. skipNotify: the
      //    user is live in-app performing this action and does not want a notification per signal.
      //    The primary drives the HTTP response — its failure is the only one that fails the request.
      const primaryResult = await signalReprocessor.reprocessSignal(accountId, signal.signalLookupId, { skipNotify: true });
      if (primaryResult.isErr()) { logger.error("Failed to reprocess primary signal on quarantine approval.", { code: "api.quarantine_response.reprocess_primary_failed", accountId, signalId, error: primaryResult.error }); return err(c, 500, "Internal Server Error"); }
      const activatedSignal = primaryResult.value;
      if (!activatedSignal.threadId) { logger.error("Primary reprocess produced a signal with no threadId.", { code: "api.quarantine_response.reprocess_no_thread", accountId, signalId, signal: activatedSignal }); return err(c, 500, "Internal Server Error"); }

      // 3. Replay each sibling IN SERIES (never Promise.all): each iteration's Aurora upsert must be
      //    visible to the next iteration's similarity search. Best-effort — a sibling failure is
      //    logged and skipped, never rolls back, never affects the response.
      for (const sibling of await collectSiblings()) {
        const siblingResult = await signalReprocessor.reprocessSignal(accountId, sibling.signalLookupId, { skipNotify: true });
        if (siblingResult.isErr()) logger.warn("Failed to reprocess sibling quarantined signal on approval — skipping.", { code: "api.quarantine_response.reprocess_sibling_failed", accountId, siblingSignalId: sibling.id, error: siblingResult.error });
      }

      // 4. Response derives from the primary only. Fetch the thread it landed on for the client's
      //    navigation target.
      const threadResult = await threadDb.getThread(accountId, activatedSignal.threadId);
      if (threadResult.isErr() || !threadResult.value) { logger.error("Failed to load thread after primary reprocess.", { code: "api.quarantine_response.get_thread_failed", accountId, signalId, threadId: activatedSignal.threadId, error: threadResult.isErr() ? threadResult.error : undefined }); return err(c, 500, "Internal Server Error"); }

      const signalWithUrls = withResolvedContentUrls(activatedSignal, contentCdnBaseUrl);
      logger.info("Signal activated", { code: "api.signals.activated", accountId, signalId, threadId: activatedSignal.threadId });
      return c.json({ thread: toApiThread(threadResult.value), signal: toApiSignal(signalWithUrls) }, 200);
    });
  }
}
