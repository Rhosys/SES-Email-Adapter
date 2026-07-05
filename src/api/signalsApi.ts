import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { DateTime } from "luxon";
import { generateId } from "../utils/id.js";
import { getDomain } from "tldts";
import { zParse } from "./validate.js";
import { toApiThread, toApiSignal } from "./transform.js";
import { generatePresignedGet } from "../processor/presign.js";
import { deriveGroupingKey } from "../processor/processor.js";
import { handlePostApprovalCalendar } from "../processor/calendar/post-approval-handler.js";
import { ensureAliasExists } from "./aliasesApi.js";
import { isEmailSignal } from "../types/index.js";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Result } from "neverthrow";
import type { Thread, Signal, AnySignal, Attachment, PageParams } from "../types/index.js";
import type { Pagination } from "../types/index.js";
import type { ThreadDatabase } from "../database/thread-database.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";
import type { PostApprovalCalendarHandlerDeps } from "../processor/calendar/post-approval-handler.js";
import type { NotFoundError, ProcessorError } from "../errors.js";
import { UpdateSignalRequest, UpdateSignalStatusRequest } from "./requests.js";
import { Signal as SignalSchema, ListSignalsResponse } from "./schemas.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";

export interface SignalReprocessor {
  reprocessSignal(accountId: string, signalId: string): Promise<Result<Signal, ProcessorError | NotFoundError>>;
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
    private readonly signalReprocessor: SignalReprocessor,
    private readonly s3Client: S3Client,
    private readonly emailBucket: string,
    private readonly contentCdnBaseUrl: string,
  ) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { threadDb, accountDb, logger, postApprovalCalendarDeps, signalReprocessor, s3Client, emailBucket, contentCdnBaseUrl } = this;

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
      if (status !== "quarantined" && status !== "quarantine_visible" && status !== "quarantine_hidden") {
        return err(c, 400, "status query param must be 'quarantined', 'quarantine_visible', or 'quarantine_hidden'", "INVALID_STATUS");
      }
      const params: PageParams = {
        ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
        ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
      };
      const result = await threadDb.listPreThreadSignals(accountId, "quarantined", params);
      if (result.isErr()) return err(c, 500, "Internal Server Error");
      const items = (status === "quarantine_visible" || status === "quarantine_hidden")
        ? result.value.items.filter(s => s.status === status)
        : result.value.items;
      const itemsWithUrls = contentCdnBaseUrl ? items.map(s => withAttachmentUrls(s, contentCdnBaseUrl)) : items;
      return c.json(page("signals", itemsWithUrls.map(toApiSignal), result.value.nextCursor), 200);
    });

    // -------------------------------------------------------------------------
    // 2. GET /accounts/{accountId}/signals/{id} — get single signal
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/signals/{id}",
      tags: ["Signals"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("signals:read", c => `accounts/${c.req.param("accountId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: SignalSchema } }, description: "Get signal" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const signalResult = await threadDb.getSignalById(accountId, c.req.param("id")!);
      if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      const withUrls = contentCdnBaseUrl ? withAttachmentUrls(signal, contentCdnBaseUrl) : signal;
      return c.json(toApiSignal(withUrls), 200);
    });

    // -------------------------------------------------------------------------
    // 3. GET /accounts/{accountId}/signals/{id}/raw — raw email redirect
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/signals/{id}/raw",
      tags: ["Signals"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("signals:read", c => `accounts/${c.req.param("accountId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 307: { description: "Redirect to presigned S3 URL for the raw email" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const signalResult = await threadDb.getSignalById(accountId, c.req.param("id")!);
      if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (!isEmailSignal(signal)) return err(c, 400, "Signal is not an email", "SIGNAL_NOT_FOUND");
      if (!signal.data.s3Key) return err(c, 404, "Raw email not available", "SIGNAL_NOT_FOUND");

      const url = await generatePresignedGet(s3Client, emailBucket, signal.data.s3Key);
      return c.redirect(url, 307);
    });

    // -------------------------------------------------------------------------
    // 4. PATCH /accounts/{accountId}/signals/{id} — update signal
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "patch",
      path: "/accounts/{accountId}/signals/{id}",
      tags: ["Signals"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: SignalSchema } }, description: "Update signal" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const signalResult = await threadDb.getSignalById(accountId, c.req.param("id")!);
      if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (signal.status === "sent") return err(c, 400, "Signal already sent", "SIGNAL_ALREADY_SENT");
      if (signal.status !== "draft" && signal.status !== "pending_send") return err(c, 400, "Only draft or pending signals can be updated", "SIGNAL_NOT_EDITABLE");

      const body = await zParse(UpdateSignalRequest, c.req.raw);

      // If pending_send, only status change to "draft" is allowed
      if (signal.status === "pending_send") {
        const hasContentFields = body.subject !== undefined || body.textBody !== undefined || body.from !== undefined || body.to !== undefined;
        if (hasContentFields && body.status !== "draft") return err(c, 400, "Pending signals can only be reverted to draft", "INVALID_STATUS_TRANSITION");
        if (body.status !== "draft") return err(c, 400, "Pending signals can only be reverted to draft", "INVALID_STATUS_TRANSITION");
        const updateResult = await threadDb.updateSignalSendStatus(accountId, signal.signalLookupId, { status: "draft", sendInitiatedAt: null });
        if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
        return c.json(toApiSignal(updateResult.value), 200);
      }

      // Normal draft edit (subject, textBody, from, to)
      const updateResult = await threadDb.updateSignal(accountId, signal.signalLookupId, body as Parameters<typeof threadDb.updateSignal>[2]);
      if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
      return c.json(toApiSignal(updateResult.value), 200);
    });

    // -------------------------------------------------------------------------
    // 5. DELETE /accounts/{accountId}/signals/{id} — delete signal
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "delete",
      path: "/accounts/{accountId}/signals/{id}",
      tags: ["Signals"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 204: { description: "Signal deleted" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const signalResult = await threadDb.getSignalById(accountId, c.req.param("id")!);
      if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (signal.status === "sent") return err(c, 400, "Signal already sent", "SIGNAL_ALREADY_SENT");
      if (signal.status !== "draft") return err(c, 400, "Only draft signals can be deleted", "SIGNAL_NOT_DRAFT");
      const deleteResult = await threadDb.deleteSignal(accountId, signal.signalLookupId);
      if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
      return new Response(null, { status: 204 });
    });

    // -------------------------------------------------------------------------
    // 6. POST /accounts/{accountId}/signals/{id}/quarantineResponse
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
      const signalResult = await threadDb.getSignalById(accountId, c.req.param("id")!);
      if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (signal.status !== "quarantine_visible" && signal.status !== "quarantine_hidden") {
        return err(c, 400, "Only quarantined signals can have their status updated", "SIGNAL_NOT_REVIEWABLE");
      }

      const body = await zParse(UpdateSignalStatusRequest, c.req.raw);
      const wasQuarantinedByUnknownSender = !(signal.data.matchedRules ?? []).some(r => r.statusChange);

      if (body.status === "block_hidden" || body.status === "block_reject" || body.status === "report_violation") {
        const blockResult = await threadDb.updateSignalStatus(accountId, signal.signalLookupId, body.status);
        if (blockResult.isErr()) return err(c, 500, "Internal Server Error");

        if (wasQuarantinedByUnknownSender) {
          const senderDomain = signal.data.from.address.includes("@") ? signal.data.from.address.split("@").pop()! : signal.data.from.address;
          const senderETLD1 = getDomain(senderDomain) ?? senderDomain;
          const recipientAddress = signal.data.recipientAddress;
          const ensureAliasResult = await ensureAliasExists(accountDb, accountId, recipientAddress, signal.id);
          if (ensureAliasResult.isErr()) return err(c, 500, "Internal Server Error");
          const saveSenderResult = await accountDb.saveSender(accountId, recipientAddress, senderETLD1, body.status);
          if (saveSenderResult.isErr()) return err(c, 500, "Internal Server Error");
        }

        return c.json(blockResult.value, 200);
      }

      // status === "active": find existing thread or create one
      const senderDomain = signal.data.from.address.includes("@") ? signal.data.from.address.split("@").pop()! : signal.data.from.address;
      const senderETLD1 = getDomain(senderDomain) ?? senderDomain;
      const groupingKey = deriveGroupingKey(signal.data.workflow, signal.data.workflowData, signal.data.recipientAddress, senderETLD1);
      const matchedThreadResult = groupingKey ? await threadDb.findThreadByGroupingKey(accountId, groupingKey) : null;
      if (matchedThreadResult && matchedThreadResult.isErr()) return err(c, 500, "Internal Server Error");
      const matchedThread = matchedThreadResult ? matchedThreadResult.value : null;

      const now = DateTime.utc().toISO()!;
      let thread: Thread;
      if (matchedThread) {
        const updateResult = await threadDb.updateThread(accountId, matchedThread.id, "active", signal.data.receivedAt, {});
        if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
        thread = updateResult.value;
      } else {
        thread = {
          id: generateId("thr-"),
          accountId,
          workflow: signal.data.workflow,
          labels: [],
          status: "active",
          summary: signal.data.summary,
          lastSignalAt: signal.data.receivedAt,
          senderAddress: (signal.data as { from?: { address?: string } }).from?.address ?? "",
          recipientAddress: (signal.data as { recipientAddress?: string }).recipientAddress ?? "",
          subject: (signal.data as { subject?: string }).subject ?? "",
          createdAt: now,
          updatedAt: now,
          ...(groupingKey ? { groupingKey } : {}),
        };
        const createResult = await threadDb.createThread(thread);
        if (createResult.isErr()) return err(c, 500, "Internal Server Error");
      }

      const unblockResult = await threadDb.unblockSignal(accountId, signal.signalLookupId, thread.id);
      if (unblockResult.isErr()) return err(c, 500, "Internal Server Error");

      // When quarantined by unknown sender, approve the sender for future emails
      if (wasQuarantinedByUnknownSender) {
        const ensureAliasResult = await ensureAliasExists(accountDb, accountId, signal.data.recipientAddress, signal.id);
        if (ensureAliasResult.isErr()) return err(c, 500, "Internal Server Error");
        const saveSenderResult = await accountDb.saveSender(accountId, signal.data.recipientAddress, senderETLD1, "allow");
        if (saveSenderResult.isErr()) return err(c, 500, "Internal Server Error");
      }

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
      return c.json({ thread: toApiThread(thread), signal: toApiSignal({ ...signalWithUrls, status: "active", threadId: thread.id }) }, 200);
    });

    // -------------------------------------------------------------------------
    // 7. POST /accounts/{accountId}/signals/{id}/reprocess
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/signals/{id}/reprocess",
      tags: ["Admin"],
      request: {
        params: z.object({ accountId: z.string(), id: z.string() }),
      },
      middleware: [authz("management:write", "reindex")] as const,
      responses: {
        200: { content: { "application/json": { schema: SignalSchema } }, description: "Signal reprocessed" },
      },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const id = c.req.param("id")!;
      const result = await signalReprocessor.reprocessSignal(accountId, id);
      if (result.isErr()) {
        const { error } = result;
        if (error.kind === "not_found") return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
        if (error.message === "Only email signals can be reprocessed" || error.message === "Signal has no s3Key — cannot reprocess") {
          return err(c, 400, error.message);
        }
        return err(c, 500, "Reprocess failed", undefined, error.message);
      }
      return c.json(toApiSignal(result.value), 200);
    });
  }
}
