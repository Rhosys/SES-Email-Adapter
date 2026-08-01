import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { DateTime } from "luxon";
import { generateId } from "../utils/id.js";
import { getDomain } from "tldts";
import { validateRecipientMx } from "../dns/mx-validator.js";
import { computeUndoWindowSeconds } from "./undo-window.js";
import { zParse } from "./validate.js";
import { toApiThread, toApiSignal } from "./transform.js";
import { buildScheduleName } from "../scheduler/schedule-name.js";
import { durationToSeconds } from "../retention.js";
import { isCalendarEventSignal, isEmailSignal } from "../types/index.js";
import type { EmailContentStore } from "./content-store.js";
import type { Thread, Signal, AnySignal, Attachment, PageParams, ThreadStatus, Workflow } from "../types/index.js";
import type { CalendarEventData, CalendarResponseData, DomainMisconfigurationData, Pagination } from "../types/index.js";
import type { UpdateThreadFields, ThreadDatabase } from "../database/thread-database.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";
import type { DraftSendDispatcher } from "../processor/draft-send-dispatcher.js";
import type { EmailService } from "../email/email-service.js";
import type { sendRsvp as SendRsvpFn } from "../processor/calendar/rsvp-composer.js";
import type { PostApprovalCalendarHandlerDeps } from "../processor/calendar/post-approval-handler.js";
import type { SchedulerClient } from "../scheduler/scheduler-client.js";
import { getPrimaryThreadMatcherRegistry } from "../embedding/cluster-registry.js";
import type { EmbeddingGenerator } from "../embedding/embedding-generator.js";
import type { ThreadMatcher } from "../database/thread-matcher.js";
import type { ProcessorError, NotFoundError } from "../errors.js";
import type { Result } from "neverthrow";
import {
  UpdateThreadRequest, ReplaceDraftSignalRequest,
  CreateDraftSignalRequest, RsvpRequest, UpdateSignalRequest,
} from "./requests.js";
import {
  Thread as ThreadSchema, Signal as SignalSchema,
  ListThreadsResponse, ListSignalsResponse,
} from "./schemas.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";

export interface SignalReprocessor {
  reprocessSignal(accountId: string, signalId: string, threadId: string): Promise<Result<Signal, ProcessorError | NotFoundError>>;
}

export interface ListThreadsParams extends PageParams {
  workflow?: Workflow;
  label?: string;
  status?: ThreadStatus;
}

function page<K extends string, T>(key: K, items: T[], nextCursor?: string): Record<K, T[]> & { pagination: Pagination } {
  return { [key]: items, pagination: { cursor: nextCursor ?? null } } as Record<K, T[]> & { pagination: Pagination };
}

function withAttachmentUrls<T extends AnySignal>(signal: T, cdnBase: string): T {
  if (!isEmailSignal(signal)) return signal;
  return { ...signal, data: { ...signal.data, attachments: signal.data.attachments.map((a: Attachment) => ({ ...a, url: `${cdnBase}/${a.s3Key}` })) } };
}

export class ThreadsApi {
  constructor(
    private readonly threadDb: ThreadDatabase,
    private readonly accountDb: AccountDatabase,
    private readonly logger: Logger,
    private readonly draftSendDispatcher: DraftSendDispatcher,
    private readonly schedulerClient: SchedulerClient,
    private readonly emailService: EmailService,
    private readonly rsvpComposer: typeof SendRsvpFn,
    private readonly postApprovalCalendarDeps: PostApprovalCalendarHandlerDeps,
    private readonly signalReprocessor: SignalReprocessor,
    private readonly emailContentStore: EmailContentStore,
    private readonly contentCdnBaseUrl: string,
    private readonly embeddingGenerator: EmbeddingGenerator,
    private readonly threadMatcher: ThreadMatcher,
  ) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { threadDb, accountDb, logger, draftSendDispatcher, schedulerClient, emailService, rsvpComposer, postApprovalCalendarDeps, signalReprocessor, emailContentStore, contentCdnBaseUrl, embeddingGenerator, threadMatcher } = this;

    // -------------------------------------------------------------------------
    // 1. GET /accounts/{accountId}/threads — list threads
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/threads",
      tags: ["Threads"],
      request: {
        params: z.object({ accountId: z.string() }),
        query: z.object({ workflow: z.string().optional(), label: z.string().optional(), status: z.string().optional(), cursor: z.string().optional(), limit: z.string().optional(), q: z.string().optional() }),
      },
      middleware: [authz("threads:read", c => `accounts/${c.req.param("accountId")!}/threads`)] as const,
      responses: { 200: { content: { "application/json": { schema: ListThreadsResponse } }, description: "List threads" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const query = c.req.query();
      const q = query["q"];
      if (q) {
        if (q.length < 3 || q.length > 64) {
          return err(c, 400, "Query must be between 3 and 64 characters");
        }

        const embeddingResult = await embeddingGenerator.generateForModel(
          q, getPrimaryThreadMatcherRegistry().modelId
        );
        if (embeddingResult.isErr()) {
          logger.error("Embedding generation failed for search.", { code: "api.threads.search_embed_failed", error: embeddingResult.error });
          return err(c, 503, "Search temporarily unavailable");
        }

        const threadIdsResult = await threadMatcher.searchByVector(
          accountId, embeddingResult.value.vector, 10
        );
        if (threadIdsResult.isErr()) {
          logger.error("Vector search failed.", { code: "api.threads.search_vector_failed", error: threadIdsResult.error });
          return err(c, 503, "Search temporarily unavailable");
        }

        if (threadIdsResult.value.length === 0) {
          return c.json(page("threads", [], undefined), 200);
        }

        const threadsResult = await threadDb.batchGetThreads(accountId, threadIdsResult.value);
        if (threadsResult.isErr()) {
          logger.error("Failed to hydrate search results.", { code: "api.threads.search_hydrate_failed", error: threadsResult.error });
          return err(c, 500, "Internal Server Error");
        }

        return c.json(page("threads", threadsResult.value.map(toApiThread), undefined), 200);
      }
      const params: ListThreadsParams = {
        ...(query["workflow"] ? { workflow: query["workflow"] as Workflow } : {}),
        ...(query["label"] ? { label: query["label"] } : {}),
        ...(query["status"] ? { status: query["status"] as ThreadStatus } : {}),
        ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
        ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
      };
      const result = await threadDb.listThreads(accountId, params);
      if (result.isErr()) {
        logger.error("Failed to list threads.", { code: "api.threads.list_failed", error: result.error });
        return err(c, 500, "Internal Server Error");
      }
      return c.json(page("threads", result.value.items.map(toApiThread), result.value.nextCursor), 200);
    });

    // -------------------------------------------------------------------------
    // 2. GET /accounts/{accountId}/threads/{threadId} — get thread
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/threads/{threadId}",
      tags: ["Threads"],
      request: { params: z.object({ accountId: z.string(), threadId: z.string() }) },
      middleware: [authz("threads:read", c => `accounts/${c.req.param("accountId")!}/threads/${c.req.param("threadId")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: ThreadSchema } }, description: "Get thread" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      const threadResult = await threadDb.getThread(accountId, threadId);
      if (threadResult.isErr()) {
        logger.error("Failed to get thread.", { code: "api.thread.get_failed", error: threadResult.error });
        return err(c, 500, "Internal Server Error");
      }
      const thread = threadResult.value;
      if (!thread) return err(c, 404, "Thread not found", "THREAD_NOT_FOUND");
      return c.json(toApiThread(thread), 200);
    });

    // -------------------------------------------------------------------------
    // 3. PATCH /accounts/{accountId}/threads/{threadId} — update thread
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "patch",
      path: "/accounts/{accountId}/threads/{threadId}",
      tags: ["Threads"],
      request: { params: z.object({ accountId: z.string(), threadId: z.string() }) },
      middleware: [authz("threads:write", c => `accounts/${c.req.param("accountId")!}/threads/${c.req.param("threadId")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: ThreadSchema } }, description: "Update thread" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      const threadResult = await threadDb.getThread(accountId, threadId);
      if (threadResult.isErr()) {
        logger.error("Failed to get thread for update.", { code: "api.thread.patch_failed", error: threadResult.error });
        return err(c, 500, "Internal Server Error");
      }
      const thread = threadResult.value;
      if (!thread) return err(c, 404, "Thread not found", "THREAD_NOT_FOUND");
      const body = await zParse(UpdateThreadRequest, c.req.raw);

      if (body.status === "report_violation") {
        const signalsResult = await threadDb.listSignals(accountId, thread.id, { limit: 1 });
        if (signalsResult.isErr()) {
          logger.error("Failed to list signals for report violation.", { code: "api.thread.report_violation.list_signals_failed", error: signalsResult.error });
          return err(c, 500, "Internal Server Error");
        }
        const signal = signalsResult.value.items[0];
        if (signal) {
          const senderDomain = signal.data.from.address.includes("@") ? signal.data.from.address.split("@").pop()! : signal.data.from.address;
          const senderETLD1 = getDomain(senderDomain) ?? senderDomain;
          const recipientAddress = signal.data.recipientAddress;
          const saveSenderResult = await accountDb.saveSender(accountId, recipientAddress, senderETLD1, "report_violation");
          if (saveSenderResult.isErr()) {
            logger.error("Failed to save sender for report violation.", { code: "api.thread.report_violation.save_sender_failed", error: saveSenderResult.error });
            return err(c, 500, "Internal Server Error");
          }
          logger.track("Thread reported as GDPR violation. Sender domain blocked with report_violation policy and thread deleted.", {
            code: "api.thread.report_violation", signal, thread, senderDomain: senderETLD1,
          });
        }
        const updateResult = await threadDb.updateThread(accountId, thread.id, "deleted", thread.lastSignalAt, {});
        if (updateResult.isErr()) {
          logger.error("Failed to update thread for report violation.", { code: "api.thread.report_violation.update_failed", error: updateResult.error });
          return err(c, 500, "Internal Server Error");
        }
        return c.json(toApiThread(updateResult.value), 200);
      }

      const fields: UpdateThreadFields = {};
      if (body.urgency !== undefined) fields.urgency = body.urgency;
      if (body.labels !== undefined) fields.labels = body.labels;
      if (body.followupAt !== undefined) fields.followupAt = body.followupAt;
      const status = body.status ?? thread.status;
      const lastSignalAt = body.lastSignalAt ?? thread.lastSignalAt;

      if (body.followupAt) {
        const followupTime = new Date(body.followupAt).getTime();
        const now = Date.now();
        if (followupTime <= now) return err(c, 400, "followupAt must be in the future");
        if (thread.retentionDuration) {
          const retentionSeconds = durationToSeconds(thread.retentionDuration);
          if (retentionSeconds != null) {
            const expiresAt = new Date(thread.createdAt).getTime() + retentionSeconds * 1000;
            if (followupTime > expiresAt) return err(c, 400, "followupAt exceeds thread retention expiration");
          }
        }
      }

      const statusChanged = body.status !== undefined && body.status !== thread.status;
      const updateResult = await threadDb.updateThread(accountId, thread.id, status, lastSignalAt, fields);
      if (updateResult.isErr()) {
        logger.error("Failed to update thread.", { code: "api.thread.update_failed", error: updateResult.error });
        return err(c, 500, "Internal Server Error");
      }

      if (body.followupAt && schedulerClient) {
        const signalsResult = await threadDb.listSignals(accountId, thread.id, { limit: 1 });
        const signalId = signalsResult.isOk() ? signalsResult.value.items[0]?.id ?? thread.id : thread.id;
        const scheduleResult = await schedulerClient.createFollowup({
          accountId, signalId, threadId: thread.id, fireAt: body.followupAt,
          suffix: "followup", sqsMessageAttributeMessageType: "signal_followup",
        });
        if (scheduleResult.isErr()) {
          logger.error("Failed to create followup schedule.", { code: "api.thread.followup_schedule_failed", error: scheduleResult.error });
          if (statusChanged) await threadDb.updateThread(accountId, thread.id, thread.status, thread.lastSignalAt, {});
          return err(c, 500, "Failed to create followup schedule");
        }
      }

      return c.json(toApiThread(updateResult.value), 200);
    });

    // -------------------------------------------------------------------------
    // 4. GET /accounts/{accountId}/threads/{threadId}/signals — list signals
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/threads/{threadId}/signals",
      tags: ["Threads"],
      request: {
        params: z.object({ accountId: z.string(), threadId: z.string() }),
        query: z.object({ cursor: z.string().optional(), limit: z.string().optional() }),
      },
      middleware: [authz("signals:read", c => `accounts/${c.req.param("accountId")!}/threads/${c.req.param("threadId")!}/signals`)] as const,
      responses: { 200: { content: { "application/json": { schema: ListSignalsResponse } }, description: "List signals for thread" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      const threadResult = await threadDb.getThread(accountId, threadId);
      if (threadResult.isErr()) {
        logger.error("Failed to get thread for listing signals.", { code: "api.thread.list_signals_failed", error: threadResult.error });
        return err(c, 500, "Internal Server Error");
      }
      const thread = threadResult.value;
      if (!thread) return err(c, 404, "Thread not found", "THREAD_NOT_FOUND");
      const query = c.req.query();
      const params: PageParams = {
        ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
        ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
      };
      const result = await threadDb.listSignals(accountId, thread.id, params);
      if (result.isErr()) {
        logger.error("Failed to list signals.", { code: "api.thread.list_signals_failed", error: result.error });
        return err(c, 500, "Internal Server Error");
      }

      const signals = result.value.items as unknown as AnySignal[];
      const calendarEventSignals = signals.filter(isCalendarEventSignal);
      const enrichments = new Map<string, { decision: CalendarResponseData["decision"]; respondedAt: string }>();

      if (calendarEventSignals.length > 0) {
        const veventUids = new Set(calendarEventSignals.map(s => s.data.veventUid));
        for (const veventUid of veventUids) {
          const responseResult = await threadDb.getLatestCalendarResponse(accountId, thread.id, veventUid);
          if (responseResult.isOk() && responseResult.value) {
            const resp = responseResult.value.data;
            enrichments.set(veventUid, { decision: resp.decision, respondedAt: resp.respondedAt });
          }
        }
      }

      const enrichedSignals = signals.map(signal => {
        const withUrls = contentCdnBaseUrl ? withAttachmentUrls(signal, contentCdnBaseUrl) : signal;
        const apiSignal = toApiSignal(withUrls);
        if (isCalendarEventSignal(withUrls) && enrichments.has(withUrls.data.veventUid)) {
          return { ...apiSignal, latestResponse: enrichments.get(withUrls.data.veventUid) };
        }
        return apiSignal;
      });

      return c.json(page("signals", enrichedSignals, result.value.nextCursor), 200);
    });

    // -------------------------------------------------------------------------
    // 5. POST /accounts/{accountId}/threads/{threadId}/signals — create draft
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/threads/{threadId}/signals",
      tags: ["Threads"],
      request: { params: z.object({ accountId: z.string(), threadId: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/threads/${c.req.param("threadId")!}/signals`)] as const,
      responses: { 201: { content: { "application/json": { schema: SignalSchema } }, description: "Create draft signal" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      const threadResult = await threadDb.getThread(accountId, threadId);
      if (threadResult.isErr()) {
        logger.error("Failed to get thread for creating signal.", { code: "api.thread.create_signal_failed", error: threadResult.error });
        return err(c, 500, "Internal Server Error");
      }
      const thread = threadResult.value;
      if (!thread || thread.status === "deleted") return err(c, 404, "Thread not found", "THREAD_NOT_FOUND");
      const body = await zParse(CreateDraftSignalRequest, c.req.raw);
      const now = DateTime.utc().toISO()!;
      const id = generateId("sgn-");
      const signal: Signal = {
        id,
        signalLookupId: id,
        threadId: thread.id,
        accountId,
        source: "user",
        type: "email",
        status: "draft",
        labels: [],
        createdAt: now,
        data: {
          receivedAt: now,
          from: body.from as Signal["data"]["from"],
          to: body.to as Signal["data"]["to"],
          cc: [],
          subject: body.subject,
          ...(body.textBody != null ? { textBody: body.textBody } : {}),
          attachments: [],
          headers: {},
          recipientAddress: body.from.address,
          workflow: thread.workflow,
          workflowData: { workflow: thread.workflow } as Signal["data"]["workflowData"],
          actions: [],
          tags: [],
          summary: "",
          s3Key: "",
        },
      };
      const createResult = await threadDb.createSignal(signal);
      if (createResult.isErr()) {
        logger.error("Failed to create draft signal.", { code: "api.thread.create_signal_failed", error: createResult.error });
        return err(c, 500, "Internal Server Error");
      }
      await threadDb.updateThread(accountId, thread.id, thread.status, now, {});
      return c.json(toApiSignal(createResult.value), 201);
    });

    // -------------------------------------------------------------------------
    // 6. PUT /accounts/{accountId}/threads/{threadId}/signals/{id} — replace draft
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "put",
      path: "/accounts/{accountId}/threads/{threadId}/signals/{id}",
      tags: ["Threads"],
      request: { params: z.object({ accountId: z.string(), threadId: z.string(), id: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/threads/${c.req.param("threadId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: SignalSchema } }, description: "Replace draft signal" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      const threadResult = await threadDb.getThread(accountId, threadId);
      if (threadResult.isErr()) {
        logger.error("Failed to get thread for replacing signal.", { code: "api.signal.update_failed", error: threadResult.error });
        return err(c, 500, "Internal Server Error");
      }
      const thread = threadResult.value;
      if (!thread) return err(c, 404, "Thread not found", "THREAD_NOT_FOUND");
      const signalResult = await threadDb.getSignalById(accountId, c.req.param("id")!, threadId);
      if (signalResult.isErr()) {
        logger.error("Failed to get signal for replacement.", { code: "api.signal.get_failed", error: signalResult.error });
        return err(c, 500, "Internal Server Error");
      }
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (signal.threadId !== thread.id) return err(c, 400, "Signal does not belong to this thread", "SIGNAL_THREAD_MISMATCH");
      if (signal.status === "sent") return err(c, 400, "Signal already sent", "SIGNAL_ALREADY_SENT");
      if (signal.status !== "draft") return err(c, 400, "Only draft signals can be replaced", "SIGNAL_NOT_DRAFT");
      const body = await zParse(ReplaceDraftSignalRequest, c.req.raw);
      const updateResult = await threadDb.updateSignal(accountId, signal.signalLookupId, {
        from: body.from as Signal["data"]["from"],
        to: body.to as Signal["data"]["to"],
        subject: body.subject,
        ...(body.textBody != null ? { textBody: body.textBody } : {}),
      });
      if (updateResult.isErr()) {
        logger.error("Failed to replace draft signal.", { code: "api.signal.update_failed", error: updateResult.error });
        return err(c, 500, "Internal Server Error");
      }
      return c.json(toApiSignal(updateResult.value), 200);
    });

    // -------------------------------------------------------------------------
    // 7. POST /accounts/{accountId}/threads/{threadId}/signals/{id}/send
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/threads/{threadId}/signals/{id}/send",
      tags: ["Threads"],
      request: { params: z.object({ accountId: z.string(), threadId: z.string(), id: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/threads/${c.req.param("threadId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: z.object({}) } }, description: "Send draft signal" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;

      const threadResult = await threadDb.getThread(accountId, threadId);
      if (threadResult.isErr()) {
        logger.error("Failed to get thread for signal send.", { code: "api.signal_send.get_thread_failed", error: threadResult.error });
        return err(c, 500, "Internal Server Error");
      }
      const thread = threadResult.value;
      if (!thread) return err(c, 404, "Thread not found", "THREAD_NOT_FOUND");

      const signalResult = await threadDb.getSignalById(accountId, c.req.param("id")!, threadId);
      if (signalResult.isErr()) {
        logger.error("Failed to get signal for send.", { code: "api.signal_send.get_signal_failed", error: signalResult.error });
        return err(c, 500, "Internal Server Error");
      }
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (signal.threadId !== thread.id) return err(c, 400, "Signal does not belong to this thread", "SIGNAL_THREAD_MISMATCH");
      if (signal.status !== "draft") return err(c, 400, "Only draft signals can be sent", "SIGNAL_NOT_DRAFT");

      const mxResult = await validateRecipientMx(signal.data.to);
      if (mxResult.isErr()) {
        return err(c, 422, "Invalid recipient domain", "INVALID_RECIPIENT_DOMAIN", { invalidDomains: mxResult.error.invalidDomains });
      }

      if (signal.data.from.address !== thread.recipientAddress) {
        logger.track("Draft send: from address does not match thread alias — rejecting.", {
          code: "draft_send.from_address_mismatch", signal, thread,
          fromAddress: signal.data.from.address, threadRecipientAddress: thread.recipientAddress,
        });
        return err(c, 422, "From address does not match thread alias");
      }

      // ── Undo-send mechanism ──────────────────────────────────────────────
      // SQS delay = undo window. If user cancels (PATCHes back to draft),
      // the delayed SQS message fires but DraftSendWorker discards it.
      const undoWindowSeconds = computeUndoWindowSeconds("textBody" in signal.data ? signal.data.textBody : undefined);
      const sendInitiatedAt = DateTime.utc().toISO()!;
      const undoExpiresAt = DateTime.utc().plus({ seconds: undoWindowSeconds }).toISO()!;

      if (!draftSendDispatcher) {
        logger.error("Service dependency not configured at runtime — this indicates a missing environment variable or initialization failure.", { code: "api.signal_send.not_configured" });
        return err(c, 501, "Send not configured");
      }
      const sqsResult = await draftSendDispatcher.dispatch({ signalId: signal.id, accountId, threadId, sendInitiatedAt }, undoWindowSeconds);
      if (sqsResult.isErr()) {
        logger.error("Failed to dispatch draft send.", { code: "api.signal_send.dispatch_failed", error: sqsResult.error });
        return err(c, 500, "Internal Server Error");
      }

      const updateResult = await threadDb.updateSignalSendStatus(accountId, signal.signalLookupId, { status: "pending_send", sendInitiatedAt });
      if (updateResult.isErr()) {
        logger.error("Failed to update signal send status.", { code: "api.signal_send.status_update_failed", error: updateResult.error });
        return err(c, 500, "Internal Server Error");
      }

      return c.json({ ...toApiSignal(updateResult.value), undoExpiresAt }, 200);
    });

    // -------------------------------------------------------------------------
    // 8. POST /accounts/{accountId}/threads/{threadId}/unsubscribe
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/threads/{threadId}/unsubscribe",
      tags: ["Threads"],
      request: { params: z.object({ accountId: z.string(), threadId: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/threads/${c.req.param("threadId")!}`)] as const,
      responses: {
        200: { content: { "application/json": { schema: z.object({ status: z.string(), url: z.string().optional() }) } }, description: "Unsubscribe initiated and thread archived" },
      },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      const threadResult = await threadDb.getThread(accountId, threadId);
      if (threadResult.isErr()) {
        logger.error("Failed to get thread for unsubscribe.", { code: "api.unsubscribe.get_thread_failed", error: threadResult.error });
        return err(c, 500, "Internal Server Error");
      }
      const thread = threadResult.value;
      if (!thread) return err(c, 404, "Thread not found", "THREAD_NOT_FOUND");

      const signalsResult = await threadDb.listSignals(accountId, thread.id, { limit: 20 });
      if (signalsResult.isErr()) {
        logger.error("Failed to list signals for unsubscribe.", { code: "api.unsubscribe.list_signals_failed", error: signalsResult.error });
        return err(c, 500, "Internal Server Error");
      }

      const emailSignal = signalsResult.value.items.find(
        (s): s is Signal => s.type === "email" && s.source === "email" && Boolean((s.data as Signal["data"]).unsubscribe),
      );
      if (!emailSignal) return err(c, 400, "No unsubscribe info available for this thread");

      const unsubscribe = emailSignal.data.unsubscribe!;

      if (unsubscribe.type === "server") {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch(unsubscribe.url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "List-Unsubscribe=One-Click",
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (!response.ok) {
            logger.warn("Unsubscribe POST returned non-2xx.", {
              code: "unsubscribe.post_failed", signal: emailSignal, thread, url: unsubscribe.url, statusCode: response.status,
            });
            return err(c, 503, "Unsubscribe endpoint returned an error");
          }
        } catch (e) {
          clearTimeout(timeout);
          logger.warn("Unsubscribe POST failed — network error or timeout.", {
            code: "unsubscribe.post_error", signal: emailSignal, thread, url: unsubscribe.url, error: e,
          });
          return err(c, 503, "Failed to reach unsubscribe endpoint");
        }
      }

      if (unsubscribe.type === "mailto") {
        logger.track("Unsubscribe via mailto — user must complete externally.", {
          code: "unsubscribe.mailto_pending", signal: emailSignal, thread, url: unsubscribe.url,
        });
      }

      const archiveResult = await threadDb.updateThread(accountId, thread.id, "archived", thread.lastSignalAt, {});
      if (archiveResult.isErr()) {
        logger.error("Failed to archive thread after unsubscribe.", { code: "api.unsubscribe.archive_failed", error: archiveResult.error });
        return err(c, 500, "Internal Server Error");
      }

      const responseUrl = unsubscribe.type !== "server" ? unsubscribe.url : undefined;
      return c.json({ status: "unsubscribed", ...(responseUrl ? { url: responseUrl } : {}) }, 200);
    });

    // -------------------------------------------------------------------------
    // 9. POST /accounts/{accountId}/threads/{threadId}/signals/{id}/rsvp
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/threads/{threadId}/signals/{id}/rsvp",
      tags: ["Threads"],
      request: { params: z.object({ accountId: z.string(), threadId: z.string(), id: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/threads/${c.req.param("threadId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: SignalSchema } }, description: "RSVP to calendar invite" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      if (!emailService || !rsvpComposer) {
        logger.error("Service dependency not configured at runtime — this indicates a missing environment variable or initialization failure.", { code: "api.rsvp.not_configured" });
        return err(c, 501, "RSVP not configured");
      }

      const threadResult = await threadDb.getThread(accountId, threadId);
      if (threadResult.isErr()) {
        logger.error("Failed to get thread for RSVP.", { code: "api.rsvp.get_thread_failed", error: threadResult.error });
        return err(c, 500, "Internal Server Error");
      }
      const thread = threadResult.value;
      if (!thread) return err(c, 404, "Thread not found", "THREAD_NOT_FOUND");

      const signalResult = await threadDb.getSignalById(accountId, c.req.param("id")!, threadId);
      if (signalResult.isErr()) {
        logger.error("Failed to get signal for RSVP.", { code: "api.rsvp.get_signal_failed", error: signalResult.error });
        return err(c, 500, "Internal Server Error");
      }
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (signal.threadId !== thread.id) return err(c, 400, "Signal does not belong to this thread", "SIGNAL_THREAD_MISMATCH");
      if (!isCalendarEventSignal(signal)) return err(c, 400, "Signal is not a calendar event", "NOT_CALENDAR_EVENT");

      const calendarData = signal.data;
      const body = await zParse(RsvpRequest, c.req.raw);

      const emailSignalResult = await threadDb.getSignalById(accountId, calendarData.linkedSignalId, thread.id);
      const emailSignal = emailSignalResult.isOk() ? emailSignalResult.value : null;
      const recipientAddress = emailSignal?.data && "recipientAddress" in emailSignal.data ? (emailSignal.data as { recipientAddress: string }).recipientAddress : "";

      if (!recipientAddress) return err(c, 400, "Cannot determine alias address for RSVP", "NO_ALIAS_ADDRESS");

      const aliasDomain = recipientAddress.split("@")[1] ?? "";
      const domainResult = await accountDb.getDomainByName(accountId, aliasDomain);
      if (domainResult.isErr()) {
        logger.error("Failed to get domain for RSVP.", { code: "api.rsvp.get_domain_failed", error: domainResult.error });
        return err(c, 500, "Internal Server Error");
      }
      const domain = domainResult.value;

      if (!domain?.senderSetupComplete) {
        const now = DateTime.utc().toISO()!;
        const misconfigSignalId = generateId("sgn-");
        const misconfigSignal: Signal<DomainMisconfigurationData> = {
          id: misconfigSignalId,
          signalLookupId: misconfigSignalId,
          threadId: thread.id,
          accountId,
          source: "signal",
          type: "domain_misconfiguration",
          status: "active",
          labels: [],
          createdAt: now,
          data: {
            reason: "DKIM + SPF not configured for alias domain",
            linkedSignalId: signal.id,
            aliasAddress: recipientAddress,
            domain: aliasDomain,
          },
        };
        await threadDb.saveSignal(misconfigSignal);
        return err(c, 422, "Domain misconfiguration", "DOMAIN_MISCONFIGURATION", { domain: aliasDomain, reason: "DKIM + SPF not configured for alias domain" });
      }

      const rsvpResult = await rsvpComposer(
        {
          decision: body.decision,
          originalCalendarData: calendarData,
          aliasAddress: recipientAddress,
          organizerAddress: calendarData.organizer,
          fromAddress: recipientAddress,
          accountId,
        },
        { emailService, logger },
      );

      if (rsvpResult.isErr()) return err(c, 422, "Failed to send RSVP", "RSVP_SEND_FAILED");

      const now = DateTime.utc().toISO()!;
      const responseSignalId = generateId("sgn-");
      const responseSignal: Signal<CalendarResponseData> = {
        id: responseSignalId,
        signalLookupId: responseSignalId,
        threadId: thread.id,
        accountId,
        source: "user",
        type: "calendar_response",
        status: "active",
        labels: [],
        createdAt: now,
        data: {
          decision: body.decision,
          respondedAt: now,
          veventUid: calendarData.originalVeventUid,
          linkedSignalId: signal.id,
          sendStatus: "sent",
        },
      };

      const saveResult = await threadDb.saveSignal(responseSignal);
      if (saveResult.isErr()) {
        logger.error("Failed to save RSVP response signal.", { code: "api.rsvp.save_failed", error: saveResult.error });
        return err(c, 500, "Internal Server Error");
      }

      if (schedulerClient && calendarData.startTime) {
        const eventStart = DateTime.fromISO(calendarData.startTime, { zone: "utc" });
        if (eventStart.isValid && eventStart > DateTime.utc()) {
          const scheduleName = buildScheduleName(accountId, signal.id, `rsvp.${eventStart.toFormat("yyyyMMdd")}`);
          const deleteResult = await schedulerClient.deleteFollowup(scheduleName);
          if (deleteResult.isErr()) {
            logger.warn("Failed to delete RSVP reminder schedule — fire-time check will handle.", { code: "rsvp.cancel.delete_failed", signal, thread, scheduleName, error: deleteResult.error });
          }
        }
      } else if (schedulerClient && !calendarData.startTime) {
        logger.track("Calendar event has no startTime — skipping RSVP schedule cancellation.", { code: "rsvp.cancel.no_start_time", signal, thread });
      }

      return c.json(toApiSignal(responseSignal), 200);
    });

    // -------------------------------------------------------------------------
    // 10. GET /accounts/{accountId}/threads/{threadId}/signals/{id} — get single signal
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/threads/{threadId}/signals/{id}",
      tags: ["Threads"],
      request: { params: z.object({ accountId: z.string(), threadId: z.string(), id: z.string() }) },
      middleware: [authz("signals:read", c => `accounts/${c.req.param("accountId")!}/threads/${c.req.param("threadId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: SignalSchema } }, description: "Get signal" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      const signalResult = await threadDb.getSignalById(accountId, c.req.param("id")!, threadId);
      if (signalResult.isErr()) {
        logger.error("Failed to get signal.", { code: "api.signal.get_failed", error: signalResult.error });
        return err(c, 500, "Internal Server Error");
      }
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      const withUrls = contentCdnBaseUrl ? withAttachmentUrls(signal, contentCdnBaseUrl) : signal;
      return c.json(toApiSignal(withUrls), 200);
    });

    // -------------------------------------------------------------------------
    // 11. GET /accounts/{accountId}/threads/{threadId}/signals/{id}/raw — raw email redirect
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/threads/{threadId}/signals/{id}/raw",
      tags: ["Threads"],
      request: { params: z.object({ accountId: z.string(), threadId: z.string(), id: z.string() }) },
      middleware: [authz("signals:read", c => `accounts/${c.req.param("accountId")!}/threads/${c.req.param("threadId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 307: { description: "Redirect to presigned S3 URL for the raw email" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      const signalResult = await threadDb.getSignalById(accountId, c.req.param("id")!, threadId);
      if (signalResult.isErr()) {
        logger.error("Failed to get signal for raw email.", { code: "api.signal.get_failed", error: signalResult.error });
        return err(c, 500, "Internal Server Error");
      }
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (!isEmailSignal(signal)) return err(c, 400, "Signal is not an email", "SIGNAL_NOT_FOUND");
      if (!signal.data.s3Key) return err(c, 404, "Raw email not available", "SIGNAL_NOT_FOUND");

      const url = await emailContentStore.getRawEmailUrl(signal);
      return c.redirect(url, 307);
    });

    // -------------------------------------------------------------------------
    // 12. PATCH /accounts/{accountId}/threads/{threadId}/signals/{id} — update signal
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "patch",
      path: "/accounts/{accountId}/threads/{threadId}/signals/{id}",
      tags: ["Threads"],
      request: { params: z.object({ accountId: z.string(), threadId: z.string(), id: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/threads/${c.req.param("threadId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: SignalSchema } }, description: "Update signal" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      const signalResult = await threadDb.getSignalById(accountId, c.req.param("id")!, threadId);
      if (signalResult.isErr()) {
        logger.error("Failed to get signal for update.", { code: "api.signal.get_failed", error: signalResult.error });
        return err(c, 500, "Internal Server Error");
      }
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
        if (updateResult.isErr()) {
          logger.error("Failed to revert signal to draft.", { code: "api.signal.update_failed", error: updateResult.error });
          return err(c, 500, "Internal Server Error");
        }
        return c.json(toApiSignal(updateResult.value), 200);
      }

      // Normal draft edit (subject, textBody, from, to)
      const updateResult = await threadDb.updateSignal(accountId, signal.signalLookupId, body as Parameters<typeof threadDb.updateSignal>[2]);
      if (updateResult.isErr()) {
        logger.error("Failed to update signal.", { code: "api.signal.update_failed", error: updateResult.error });
        return err(c, 500, "Internal Server Error");
      }
      return c.json(toApiSignal(updateResult.value), 200);
    });

    // -------------------------------------------------------------------------
    // 13. DELETE /accounts/{accountId}/threads/{threadId}/signals/{id} — delete signal
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "delete",
      path: "/accounts/{accountId}/threads/{threadId}/signals/{id}",
      tags: ["Threads"],
      request: { params: z.object({ accountId: z.string(), threadId: z.string(), id: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/threads/${c.req.param("threadId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 204: { description: "Signal deleted" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      const signalResult = await threadDb.getSignalById(accountId, c.req.param("id")!, threadId);
      if (signalResult.isErr()) {
        logger.error("Failed to get signal for deletion.", { code: "api.signal.delete_failed", error: signalResult.error });
        return err(c, 500, "Internal Server Error");
      }
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (signal.status === "sent") return err(c, 400, "Signal already sent", "SIGNAL_ALREADY_SENT");
      if (signal.status !== "draft") return err(c, 400, "Only draft signals can be deleted", "SIGNAL_NOT_DRAFT");
      const deleteResult = await threadDb.deleteSignal(accountId, signal.signalLookupId);
      if (deleteResult.isErr()) {
        logger.error("Failed to delete signal.", { code: "api.signal.delete_failed", error: deleteResult.error });
        return err(c, 500, "Internal Server Error");
      }
      return new Response(null, { status: 204 });
    });

    // -------------------------------------------------------------------------
    // 14. POST /accounts/{accountId}/threads/{threadId}/signals/{id}/reprocess
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/threads/{threadId}/signals/{id}/reprocess",
      tags: ["Admin"],
      request: { params: z.object({ accountId: z.string(), threadId: z.string(), id: z.string() }) },
      middleware: [authz("management:write", "reindex")] as const,
      responses: { 200: { content: { "application/json": { schema: SignalSchema } }, description: "Signal reprocessed" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      const id = c.req.param("id")!;
      const result = await signalReprocessor.reprocessSignal(accountId, id, threadId);
      if (result.isErr()) {
        const { error } = result;
        if (error.kind === "not_found") return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
        if (error.message === "Only email signals can be reprocessed" || error.message === "Signal has no s3Key — cannot reprocess") {
          return err(c, 400, error.message);
        }
        logger.error("Signal reprocess failed with an unexpected processor error.", { code: "api.reprocess.failed", accountId, signalId: id, threadId, error });
        return err(c, 500, "Reprocess failed", undefined, error.message);
      }
      return c.json(toApiSignal(result.value), 200);
    });
  }
}
