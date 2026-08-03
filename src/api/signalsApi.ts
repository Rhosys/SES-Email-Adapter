import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { DateTime } from "luxon";
import { getDomain } from "tldts";
import { zParse } from "./validate.js";
import { toApiThread, toApiSignal } from "./transform.js";
import { deriveGroupingKey } from "../grouping-key.js";
import { handlePostApprovalCalendar } from "../processor/calendar/post-approval-handler.js";
import { resolveRetention } from "../retention.js";
import { buildActiveThread } from "../thread-factory.js";
import { isEmailSignal } from "../types/index.js";
import type { Result } from "neverthrow";
import type { Thread, Signal, AnySignal, Attachment, PageParams } from "../types/index.js";
import type { Pagination } from "../types/index.js";
import type { ThreadDatabase } from "../database/thread-database.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";
import type { PostApprovalCalendarHandlerDeps } from "../processor/calendar/post-approval-handler.js";
import type { NotFoundError, ProcessorError } from "../errors.js";
import { QuarantineResponse } from "./requests.js";
import { Signal as SignalSchema, ListSignalsResponse } from "./schemas.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";

export interface SignalReprocessor {
  reprocessSignal(accountId: string, signalId: string, threadId: string): Promise<Result<Signal, ProcessorError | NotFoundError>>;
}

function page<K extends string, T>(key: K, items: T[], nextCursor?: string): Record<K, T[]> & { pagination: Pagination } {
  return { [key]: items, pagination: { cursor: nextCursor ?? null } } as Record<K, T[]> & { pagination: Pagination };
}

function withAttachmentUrls<T extends AnySignal>(signal: T, cdnBase: string): T {
  if (!isEmailSignal(signal)) return signal;
  return { ...signal, data: { ...signal.data, attachments: signal.data.attachments.map((a: Attachment) => ({ ...a, url: `${cdnBase}/${a.s3Key}` })) } };
}

export class SignalsApi {
  constructor(
    private readonly threadDb: ThreadDatabase,
    private readonly accountDb: AccountDatabase,
    private readonly logger: Logger,
    private readonly postApprovalCalendarDeps: PostApprovalCalendarHandlerDeps,
    private readonly contentCdnBaseUrl: string,
  ) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { threadDb, accountDb, logger, postApprovalCalendarDeps, contentCdnBaseUrl } = this;

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

      const itemsWithUrls = contentCdnBaseUrl ? items.map(s => withAttachmentUrls(s, contentCdnBaseUrl)) : items;
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

      const body = await zParse(QuarantineResponse, c.req.raw);
      // Reaching this handler means the signal is quarantined, so the user is making an explicit
      // sender decision — always record it. The alias record is guaranteed to exist (created as an
      // invariant during ingest), so there is nothing to ensure and no rule-evaluation to consult.
      const senderDomain = signal.data.from.address.includes("@") ? signal.data.from.address.split("@").pop()! : signal.data.from.address;
      const senderETLD1 = getDomain(senderDomain) ?? senderDomain;

      if (body.status === "block_hidden" || body.status === "block_reject" || body.status === "report_violation" || body.status === "dismiss") {
        const effectiveStatus = body.status === "dismiss" ? "block_hidden" : body.status;
        const blockResult = await threadDb.updateSignalStatus(accountId, signal.signalLookupId, effectiveStatus);
        if (blockResult.isErr()) { logger.error("Failed to block signal.", { code: "api.quarantine_response.block_failed", error: blockResult.error }); return err(c, 500, "Internal Server Error"); }

        // Dismiss = no sender opinion recorded. Block/reject/violation = persist sender disposition.
        if (body.status !== "dismiss") {
          const saveSenderResult = await accountDb.saveSender(accountId, signal.data.recipientAddress, senderETLD1, body.status);
          if (saveSenderResult.isErr()) { logger.error("Failed to save sender disposition.", { code: "api.quarantine_response.save_sender_failed", error: saveSenderResult.error }); return err(c, 500, "Internal Server Error"); }
        }

        logger.info("Signal blocked", { code: "api.signals.blocked", accountId, signalId, decision: effectiveStatus });
        return c.json(blockResult.value, 200);
      }

      // status === "active": find existing thread or create one

      // Prefer the thread the processor already resolved at receive time via full grouping-key /
      // in-reply-to / similarity matching. Re-deriving here would only cover grouping-key matches
      // (null for conversation/crm/etc.) and would spawn a duplicate thread for everything else.
      let matchedThread: Thread | null = null;
      if (signal.data.matchedThreadId) {
        const byIdResult = await threadDb.getThread(accountId, signal.data.matchedThreadId);
        if (byIdResult.isErr()) { logger.error("Failed to get matched thread for quarantine approval.", { code: "api.quarantine_response.get_matched_thread_failed", error: byIdResult.error }); return err(c, 500, "Internal Server Error"); }
        matchedThread = byIdResult.value;
      }

      // Fallback grouping-key lookup — covers signals quarantined before matchedThreadId was recorded.
      const groupingKey = deriveGroupingKey(signal.data.workflow, signal.data.workflowData, signal.data.recipientAddress, senderETLD1);
      if (!matchedThread && groupingKey) {
        const matchedThreadResult = await threadDb.findThreadByGroupingKey(accountId, groupingKey);
        if (matchedThreadResult.isErr()) { logger.error("Failed to find thread by grouping key.", { code: "api.quarantine_response.find_thread_failed", error: matchedThreadResult.error }); return err(c, 500, "Internal Server Error"); }
        matchedThread = matchedThreadResult.value;
      }

      let thread: Thread;

      // Resolve retention — need account config for the effective duration
      const accountResult = await accountDb.getAccount(accountId);
      const accountRetention = accountResult.isOk() ? accountResult.value?.retentionDuration : undefined;
      const effectiveRetention = resolveRetention(accountRetention ? { retentionDuration: accountRetention } : {}, null);

      if (matchedThread) {
        const updateResult = await threadDb.updateThread(accountId, matchedThread.id, "active", signal.data.receivedAt, { retentionDuration: effectiveRetention });
        if (updateResult.isErr()) { logger.error("Failed to update thread for quarantine approval.", { code: "api.quarantine_response.update_thread_failed", error: updateResult.error }); return err(c, 500, "Internal Server Error"); }
        thread = updateResult.value;
      } else {
        thread = buildActiveThread({
          accountId,
          workflow: signal.data.workflow,
          summary: signal.data.summary,
          lastSignalAt: signal.data.receivedAt,
          sender: { address: (signal.data as { from?: { address?: string } }).from?.address ?? "", ...(((signal.data as { from?: { name?: string } }).from?.name) ? { name: (signal.data as { from?: { name?: string } }).from!.name } : {}) },
          recipientAddress: (signal.data as { recipientAddress?: string }).recipientAddress ?? "",
          subject: (signal.data as { subject?: string }).subject ?? "",
          retentionDuration: effectiveRetention,
          groupingKey: groupingKey ?? undefined,
        });
        const createResult = await threadDb.createThread(thread);
        if (createResult.isErr()) { logger.error("Failed to create thread for quarantine approval.", { code: "api.quarantine_response.create_thread_failed", error: createResult.error }); return err(c, 500, "Internal Server Error"); }
      }

      const unblockResult = await threadDb.unblockSignal(accountId, signal.signalLookupId, thread.id);
      if (unblockResult.isErr()) { logger.error("Failed to unblock signal.", { code: "api.quarantine_response.unblock_failed", error: unblockResult.error }); return err(c, 500, "Internal Server Error"); }

      // Record the user's explicit sender approval — always. The alias already exists (ingest invariant).
      const saveSenderResult = await accountDb.saveSender(accountId, signal.data.recipientAddress, senderETLD1, "allow");
      if (saveSenderResult.isErr()) { logger.error("Failed to save sender approval.", { code: "api.quarantine_response.save_sender_failed", error: saveSenderResult.error }); return err(c, 500, "Internal Server Error"); }

      // Post-approval calendar forwarding
      if (postApprovalCalendarDeps) {
        const approvedSignal: Signal = { ...signal, status: "active", threadId: thread.id };
        try {
          await handlePostApprovalCalendar(approvedSignal, thread, postApprovalCalendarDeps);
        } catch (e) {
          logger.warn("Post-approval calendar handler threw unexpectedly.", {
            code: "api.quarantine_response.calendar_error",
            signal, thread,
            error: e,
          });
        }
      }

      const signalWithUrls = contentCdnBaseUrl ? withAttachmentUrls(signal, contentCdnBaseUrl) : signal;
      logger.info("Signal activated", { code: "api.signals.activated", accountId, signalId, threadId: thread.id });
      return c.json({ thread: toApiThread(thread), signal: toApiSignal({ ...signalWithUrls, status: "active", threadId: thread.id }) }, 200);
    });
  }
}
