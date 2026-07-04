import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { DateTime } from "luxon";
import { generateId } from "../utils/id.js";
import { getDomain } from "tldts";
import { validateRecipientMx } from "../dns/mx-validator.js";
import { computeUndoWindowSeconds } from "./undo-window.js";
import { zParse } from "./validate.js";
import { toApiThread, toApiSignal } from "./transform.js";
import { generatePresignedGet } from "../processor/presign.js";
import { deriveGroupingKey } from "../processor/processor.js";
import { handlePostApprovalCalendar } from "../processor/calendar/post-approval-handler.js";
import { buildScheduleName } from "../scheduler/schedule-name.js";
import { durationToSeconds } from "../processor/retention.js";
import { ensureAliasExists } from "./aliasesApi.js";
import { isCalendarEventSignal, isEmailSignal } from "../types/index.js";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Result } from "neverthrow";
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
import type { NotFoundError, ProcessorError } from "../errors.js";
import {
  UpdateThreadRequest, UpdateSignalRequest, UpdateSignalStatusRequest,
  CreateDraftSignalRequest, ReplaceDraftSignalRequest,
  RsvpRequest,
} from "./requests.js";
import {
  Thread as ThreadSchema, Signal as SignalSchema,
  ListThreadsResponse, ListSignalsResponse,
} from "./schemas.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";

export interface SignalReprocessor {
  reprocessSignal(accountId: string, signalId: string): Promise<Result<Signal, ProcessorError | NotFoundError>>;
}

export interface ListArcsParams extends PageParams {
  workflow?: Workflow;
  label?: string;
  status?: ThreadStatus;
}

const MAIL_DOMAIN = process.env["MAIL_DOMAIN"] ?? "platform.email.rhosys.cloud";

function page<K extends string, T>(key: K, items: T[], nextCursor?: string): Record<K, T[]> & { pagination: Pagination } {
  return { [key]: items, pagination: { cursor: nextCursor ?? null } } as Record<K, T[]> & { pagination: Pagination };
}

function withAttachmentUrls<T extends AnySignal>(signal: T, cdnBase: string): T {
  if (!isEmailSignal(signal)) return signal;
  return { ...signal, data: { ...signal.data, attachments: signal.data.attachments.map((a: Attachment) => ({ ...a, url: `${cdnBase}/${a.s3Key}` })) } };
}

export class ArcsApi {
  constructor(
    private readonly arcDb: ThreadDatabase,
    private readonly accountDb: AccountDatabase,
    private readonly logger: Logger,
    private readonly draftSendDispatcher: DraftSendDispatcher,
    private readonly schedulerClient: SchedulerClient,
    private readonly emailService: EmailService,
    private readonly rsvpComposer: typeof SendRsvpFn,
    private readonly postApprovalCalendarDeps: PostApprovalCalendarHandlerDeps,
    private readonly signalReprocessor: SignalReprocessor,
    private readonly s3Client: S3Client,
    private readonly emailBucket: string,
    private readonly contentCdnBaseUrl: string,
  ) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { arcDb, accountDb, logger, draftSendDispatcher, schedulerClient, emailService, rsvpComposer, postApprovalCalendarDeps, signalReprocessor, s3Client, emailBucket, contentCdnBaseUrl } = this;

    // -------------------------------------------------------------------------
    // Arcs  —  /accounts/:accountId/arcs
    // -------------------------------------------------------------------------

    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/arcs",
      tags: ["Arcs"],
      request: {
        params: z.object({ accountId: z.string() }),
        query: z.object({ workflow: z.string().optional(), label: z.string().optional(), status: z.string().optional(), cursor: z.string().optional(), limit: z.string().optional(), q: z.string().optional() }),
      },
      middleware: [authz("arcs:read", c => `accounts/${c.req.param("accountId")!}/arcs`)] as const,
      responses: { 200: { content: { "application/json": { schema: ListThreadsResponse } }, description: "List arcs" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const query = c.req.query();
      const q = query["q"];
      if (q) {
        const params: PageParams = {
          ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
          ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
        };
        const result = await arcDb.searchThreads(accountId, q, params);
        if (result.isErr()) return err(c, 500, "Internal Server Error");
        return c.json(page("arcs", result.value.items.map(toApiThread), result.value.nextCursor), 200);
      }
      const params: ListArcsParams = {
        ...(query["workflow"] ? { workflow: query["workflow"] as Workflow } : {}),
        ...(query["label"] ? { label: query["label"] } : {}),
        ...(query["status"] ? { status: query["status"] as ThreadStatus } : {}),
        ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
        ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
      };
      const result = await arcDb.listThreads(accountId, params);
      if (result.isErr()) return err(c, 500, "Internal Server Error");
      return c.json(page("arcs", result.value.items.map(toApiThread), result.value.nextCursor), 200);
    });

    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/arcs/{id}",
      tags: ["Arcs"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("arcs:read", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: ThreadSchema } }, description: "Get arc" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const arcResult = await arcDb.getThread(accountId, c.req.param("id")!);
      if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
      const arc = arcResult.value;
      if (!arc) return err(c, 404, "Thread not found", "THREAD_NOT_FOUND");
      return c.json(toApiThread(arc), 200);
    });

    app.openapi(route({
      method: "patch",
      path: "/accounts/{accountId}/arcs/{id}",
      tags: ["Arcs"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("arcs:write", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: ThreadSchema } }, description: "Update arc" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const arcResult = await arcDb.getThread(accountId, c.req.param("id")!);
      if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
      const arc = arcResult.value;
      if (!arc) return err(c, 404, "Thread not found", "THREAD_NOT_FOUND");
      const body = await zParse(UpdateThreadRequest, c.req.raw);

      // report_violation: block the sender domain and delete the arc
      if (body.status === "report_violation") {
        const signalsResult = await arcDb.listSignals(accountId, arc.id, { limit: 1 });
        if (signalsResult.isErr()) return err(c, 500, "Internal Server Error");
        const signal = signalsResult.value.items[0];
        if (signal) {
          const senderDomain = signal.data.from.address.includes("@") ? signal.data.from.address.split("@").pop()! : signal.data.from.address;
          const senderETLD1 = getDomain(senderDomain) ?? senderDomain;
          const recipientAddress = signal.data.recipientAddress;
          const saveSenderResult = await accountDb.saveSender(accountId, recipientAddress, senderETLD1, "report_violation");
          if (saveSenderResult.isErr()) return err(c, 500, "Internal Server Error");
          logger.track("Thread reported as GDPR violation. Sender domain blocked with report_violation policy and thread deleted.", {
            code: "api.thread.report_violation",
            signal, arc,
            senderDomain: senderETLD1,
          });
        }
        // Persist as deleted — report_violation is the user intent, deleted is the arc state
        const updateResult = await arcDb.updateThread(accountId, arc.id, "deleted", arc.lastSignalAt, {});
        if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
        return c.json(toApiThread(updateResult.value), 200);
      }

      const fields: UpdateThreadFields = {};
      if (body.urgency !== undefined) fields.urgency = body.urgency;
      if (body.labels !== undefined) fields.labels = body.labels;
      if (body.followupAt !== undefined) fields.followupAt = body.followupAt;
      const status = body.status ?? arc.status;
      const lastSignalAt = body.lastSignalAt ?? arc.lastSignalAt;

      // followupAt validation
      if (body.followupAt) {
        const followupTime = new Date(body.followupAt).getTime();
        const now = Date.now();
        if (followupTime <= now) {
          return err(c, 400, "followupAt must be in the future");
        }
        if (arc.retentionDuration) {
          const retentionSeconds = durationToSeconds(arc.retentionDuration);
          if (retentionSeconds != null) {
            const expiresAt = new Date(arc.createdAt).getTime() + retentionSeconds * 1000;
            if (followupTime > expiresAt) {
              return err(c, 400, "followupAt exceeds thread retention expiration");
            }
          }
        }
      }

      // Apply status change (if any)
      const statusChanged = body.status !== undefined && body.status !== arc.status;
      const updateResult = await arcDb.updateThread(accountId, arc.id, status, lastSignalAt, fields);
      if (updateResult.isErr()) return err(c, 500, "Internal Server Error");

      // Create followup schedule (if requested)
      if (body.followupAt && schedulerClient) {
        // Get the most recent signal for the arc to use as signalId
        const signalsResult = await arcDb.listSignals(accountId, arc.id, { limit: 1 });
        const signalId = signalsResult.isOk() ? signalsResult.value.items[0]?.id ?? arc.id : arc.id;

        const scheduleResult = await schedulerClient.createFollowup({
          accountId,
          signalId,
          threadId: arc.id,
          fireAt: body.followupAt,
          suffix: "followup",
          sqsMessageAttributeMessageType: "signal_followup",
        });

        if (scheduleResult.isErr()) {
          // Rollback status change if one was applied
          if (statusChanged) {
            await arcDb.updateThread(accountId, arc.id, arc.status, arc.lastSignalAt, {});
          }
          return err(c, 500, "Failed to create followup schedule");
        }
      }

      return c.json(toApiThread(updateResult.value), 200);
    });

    // -------------------------------------------------------------------------
    // Signals  —  /accounts/:accountId/arcs/:arcId/signals  &  /signals/:id
    // -------------------------------------------------------------------------

    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/arcs/{arcId}/signals",
      tags: ["Signals"],
      request: {
        params: z.object({ accountId: z.string(), arcId: z.string() }),
        query: z.object({ cursor: z.string().optional(), limit: z.string().optional() }),
      },
      middleware: [authz("signals:read", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("arcId")!}/signals`)] as const,
      responses: { 200: { content: { "application/json": { schema: ListSignalsResponse } }, description: "List signals for arc" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const arcResult = await arcDb.getThread(accountId, c.req.param("arcId")!);
      if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
      const arc = arcResult.value;
      if (!arc) return err(c, 404, "Thread not found", "THREAD_NOT_FOUND");
      const query = c.req.query();
      const params: PageParams = {
        ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
        ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
      };
      const result = await arcDb.listSignals(accountId, arc.id, params);
      if (result.isErr()) return err(c, 500, "Internal Server Error");

      // Enrich calendar_event signals with the most recent calendar_response decision
      const signals = result.value.items as unknown as import("../types/index.js").AnySignal[];
      const calendarEventSignals = signals.filter(isCalendarEventSignal);
      const enrichments = new Map<string, { decision: CalendarResponseData["decision"]; respondedAt: string }>();

      if (calendarEventSignals.length > 0) {
        const veventUids = new Set(calendarEventSignals.map(s => s.data.veventUid));
        for (const veventUid of veventUids) {
          const responseResult = await arcDb.getLatestCalendarResponse(accountId, arc.id, veventUid);
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

    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/arcs/{arcId}/signals",
      tags: ["Signals"],
      request: { params: z.object({ accountId: z.string(), arcId: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("arcId")!}/signals`)] as const,
      responses: { 201: { content: { "application/json": { schema: SignalSchema } }, description: "Create draft signal" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const arcResult = await arcDb.getThread(accountId, c.req.param("arcId")!);
      if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
      const arc = arcResult.value;
      if (!arc || arc.status === "deleted") return err(c, 404, "Thread not found", "THREAD_NOT_FOUND");
      const body = await zParse(CreateDraftSignalRequest, c.req.raw);
      const now = DateTime.utc().toISO()!;
      const id = generateId("sgn-");
      const signal: Signal = {
        id,
        signalLookupId: id,
        threadId: arc.id,
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
          workflow: arc.workflow,
          workflowData: { workflow: arc.workflow } as Signal["data"]["workflowData"],
          tags: [],
          summary: "",
          s3Key: "",
        },
      };
      const createResult = await arcDb.createSignal(signal);
      if (createResult.isErr()) return err(c, 500, "Internal Server Error");
      await arcDb.updateThread(accountId, arc.id, arc.status, now, {});
      return c.json(toApiSignal(createResult.value), 201);
    });

    app.openapi(route({
      method: "put",
      path: "/accounts/{accountId}/arcs/{arcId}/signals/{id}",
      tags: ["Signals"],
      request: { params: z.object({ accountId: z.string(), arcId: z.string(), id: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("arcId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: SignalSchema } }, description: "Replace draft signal" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const arcResult = await arcDb.getThread(accountId, c.req.param("arcId")!);
      if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
      const arc = arcResult.value;
      if (!arc) return err(c, 404, "Thread not found", "THREAD_NOT_FOUND");
      const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!, c.req.param("arcId")!);
      if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (signal.threadId !== arc.id) return err(c, 400, "Signal does not belong to this thread", "SIGNAL_THREAD_MISMATCH");
      if (signal.status === "sent") return err(c, 400, "Signal already sent", "SIGNAL_ALREADY_SENT");
      if (signal.status !== "draft") return err(c, 400, "Only draft signals can be replaced", "SIGNAL_NOT_DRAFT");
      const body = await zParse(ReplaceDraftSignalRequest, c.req.raw);
      const updateResult = await arcDb.updateSignal(accountId, signal.signalLookupId, {
        from: body.from as Signal["data"]["from"],
        to: body.to as Signal["data"]["to"],
        subject: body.subject,
        ...(body.textBody != null ? { textBody: body.textBody } : {}),
      });
      if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
      return c.json(toApiSignal(updateResult.value), 200);
    });

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
      const result = await arcDb.listPreThreadSignals(accountId, "quarantined", params);
      if (result.isErr()) return err(c, 500, "Internal Server Error");
      const items = (status === "quarantine_visible" || status === "quarantine_hidden")
        ? result.value.items.filter(s => s.status === status)
        : result.value.items;
      const itemsWithUrls = contentCdnBaseUrl ? items.map(s => withAttachmentUrls(s, contentCdnBaseUrl)) : items;
      return c.json(page("signals", itemsWithUrls.map(toApiSignal), result.value.nextCursor), 200);
    });

    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/signals/{id}/quarantineResponse",
      tags: ["Signals"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: z.object({}) } }, description: "Quarantine response" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!);
      if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (signal.status !== "quarantine_visible" && signal.status !== "quarantine_hidden") {
        return err(c, 400, "Only quarantined signals can have their status updated", "SIGNAL_NOT_REVIEWABLE");
      }

      const body = await zParse(UpdateSignalStatusRequest, c.req.raw);
      const wasQuarantinedByUnknownSender = !(signal.data.matchedRules ?? []).some(r => r.statusChange);

      if (body.status === "block_hidden" || body.status === "block_reject" || body.status === "report_violation") {
        const blockResult = await arcDb.updateSignalStatus(accountId, signal.signalLookupId, body.status);
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

      // status === "active": find existing arc or create one
      const senderDomain = signal.data.from.address.includes("@") ? signal.data.from.address.split("@").pop()! : signal.data.from.address;
      const senderETLD1 = getDomain(senderDomain) ?? senderDomain;
      const groupingKey = deriveGroupingKey(signal.data.workflow, signal.data.workflowData, signal.data.recipientAddress, senderETLD1);
      const matchedArcResult = groupingKey ? await arcDb.findThreadByGroupingKey(accountId, groupingKey) : null;
      if (matchedArcResult && matchedArcResult.isErr()) return err(c, 500, "Internal Server Error");
      const matchedArc = matchedArcResult ? matchedArcResult.value : null;

      const now = DateTime.utc().toISO()!;
      let arc: Arc;
      if (matchedArc) {
        const updateResult = await arcDb.updateThread(accountId, matchedArc.id, "active", signal.data.receivedAt, {});
        if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
        arc = updateResult.value;
      } else {
        arc = {
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
        const createResult = await arcDb.createThread(arc);
        if (createResult.isErr()) return err(c, 500, "Internal Server Error");
      }

      const unblockResult = await arcDb.unblockSignal(accountId, signal.signalLookupId, arc.id);
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
        const approvedSignal: Signal = { ...signal, status: "active", threadId: arc.id };
        try {
          await handlePostApprovalCalendar(approvedSignal, arc, postApprovalCalendarDeps);
        } catch (e) {
          logger.warn("Post-approval calendar handler threw unexpectedly.", {
            code: "api.quarantine_response.calendar_error",
            signal, arc,
            error: e,
          });
        }
      }

      const signalWithUrls = contentCdnBaseUrl ? withAttachmentUrls(signal, contentCdnBaseUrl) : signal;
      return c.json({ arc: toApiThread(arc), signal: toApiSignal({ ...signalWithUrls, status: "active", threadId: arc.id }) }, 200);
    });

    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/signals/{id}",
      tags: ["Signals"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("signals:read", c => `accounts/${c.req.param("accountId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: SignalSchema } }, description: "Get signal" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!);
      if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      const withUrls = contentCdnBaseUrl ? withAttachmentUrls(signal, contentCdnBaseUrl) : signal;
      return c.json(toApiSignal(withUrls), 200);
    });

    // Raw email source — 307 redirect to presigned S3 URL
    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/signals/{id}/raw",
      tags: ["Signals"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("signals:read", c => `accounts/${c.req.param("accountId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 307: { description: "Redirect to presigned S3 URL for the raw email" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!);
      if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (!isEmailSignal(signal)) return err(c, 400, "Signal is not an email", "SIGNAL_NOT_FOUND");
      if (!signal.data.s3Key) return err(c, 404, "Raw email not available", "SIGNAL_NOT_FOUND");

      const url = await generatePresignedGet(s3Client, emailBucket, signal.data.s3Key);
      return c.redirect(url, 307);
    });

    app.openapi(route({
      method: "patch",
      path: "/accounts/{accountId}/signals/{id}",
      tags: ["Signals"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: SignalSchema } }, description: "Update signal" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!);
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
        const updateResult = await arcDb.updateSignalSendStatus(accountId, signal.signalLookupId, { status: "draft", sendInitiatedAt: null });
        if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
        return c.json(toApiSignal(updateResult.value), 200);
      }

      // Normal draft edit (subject, textBody, from, to)
      const updateResult = await arcDb.updateSignal(accountId, signal.signalLookupId, body as Parameters<typeof arcDb.updateSignal>[2]);
      if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
      return c.json(toApiSignal(updateResult.value), 200);
    });

    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/arcs/{arcId}/signals/{id}/send",
      tags: ["Signals"],
      request: { params: z.object({ accountId: z.string(), arcId: z.string(), id: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("arcId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: z.object({}) } }, description: "Send draft signal" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;

      // Arc validation
      const arcResult = await arcDb.getThread(accountId, c.req.param("arcId")!);
      if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
      const arc = arcResult.value;
      if (!arc) return err(c, 404, "Thread not found", "THREAD_NOT_FOUND");

      // Signal validation
      const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!, c.req.param("arcId")!);
      if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (signal.threadId !== arc.id) return err(c, 400, "Signal does not belong to this thread", "SIGNAL_THREAD_MISMATCH");
      if (signal.status !== "draft") return err(c, 400, "Only draft signals can be sent", "SIGNAL_NOT_DRAFT");

      // MX validation
      const mxResult = await validateRecipientMx(signal.data.to);
      if (mxResult.isErr()) {
        return err(c, 422, "Invalid recipient domain", "INVALID_RECIPIENT_DOMAIN", { invalidDomains: mxResult.error.invalidDomains });
      }

      // Verify the from address matches the thread's alias
      if (signal.data.from.address !== arc.recipientAddress) {
        logger.track("Draft send: from address does not match thread alias — rejecting.", {
          code: "draft_send.from_address_mismatch",
          signal, arc,
          fromAddress: signal.data.from.address,
          threadRecipientAddress: arc.recipientAddress,
        });
        return err(c, 422, "From address does not match thread alias");
      }

      // ── Undo-send mechanism ──────────────────────────────────────────────
      // The undo window is computed from email body length (longer emails get
      // longer windows: 10s/60s/180s/300s — see undo-window.ts).
      //
      // Flow:
      // 1. Compute undoExpiresAt (absolute timestamp = now + window duration)
      // 2. Enqueue SQS message with DelaySeconds = window duration. The message
      //    won't be delivered to the DraftSendWorker until the delay elapses.
      // 3. Write signal status → "pending_send" with sendInitiatedAt timestamp.
      // 4. Return undoExpiresAt to the frontend (drives countdown display).
      //
      // If the user cancels: frontend PATCHes signal back to "draft". When the
      // SQS message fires, DraftSendWorker sees status !== "pending_send" and
      // discards. No email is sent.
      //
      // If the user doesn't cancel: SQS message fires after delay, worker sees
      // "pending_send" + matching sendInitiatedAt, sends via SES, transitions
      // to "sent".
      const undoWindowSeconds = computeUndoWindowSeconds(signal.data.textBody);
      const sendInitiatedAt = DateTime.utc().toISO()!;
      const undoExpiresAt = DateTime.utc().plus({ seconds: undoWindowSeconds }).toISO()!;

      // SQS FIRST — before DDB write
      if (!draftSendDispatcher) return err(c, 501, "Send not configured");
      const sqsResult = await draftSendDispatcher.dispatch({ signalId: signal.id, accountId, sendInitiatedAt }, undoWindowSeconds);
      if (sqsResult.isErr()) return err(c, 500, "Internal Server Error");

      // DDB write — transition to pending_send
      const updateResult = await arcDb.updateSignalSendStatus(accountId, signal.signalLookupId, { status: "pending_send", sendInitiatedAt });
      if (updateResult.isErr()) return err(c, 500, "Internal Server Error");

      return c.json({ ...toApiSignal(updateResult.value), undoExpiresAt }, 200);
    });

    app.openapi(route({
      method: "delete",
      path: "/accounts/{accountId}/signals/{id}",
      tags: ["Signals"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 204: { description: "Signal deleted" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!);
      if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (signal.status === "sent") return err(c, 400, "Signal already sent", "SIGNAL_ALREADY_SENT");
      if (signal.status !== "draft") return err(c, 400, "Only draft signals can be deleted", "SIGNAL_NOT_DRAFT");
      const deleteResult = await arcDb.deleteSignal(accountId, signal.signalLookupId);
      if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
      return new Response(null, { status: 204 });
    });

    // -------------------------------------------------------------------------
    // Unsubscribe  —  /accounts/:accountId/arcs/:arcId/unsubscribe
    // -------------------------------------------------------------------------

    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/arcs/{arcId}/unsubscribe",
      tags: ["Signals"],
      request: { params: z.object({ accountId: z.string(), arcId: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("arcId")!}`)] as const,
      responses: {
        200: { content: { "application/json": { schema: z.object({ status: z.string(), url: z.string().optional() }) } }, description: "Unsubscribe initiated and arc archived" },
      },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const arcResult = await arcDb.getThread(accountId, c.req.param("arcId")!);
      if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
      const arc = arcResult.value;
      if (!arc) return err(c, 404, "Thread not found", "THREAD_NOT_FOUND");

      const signalsResult = await arcDb.listSignals(accountId, arc.id, { limit: 20 });
      if (signalsResult.isErr()) return err(c, 500, "Internal Server Error");

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
              code: "unsubscribe.post_failed",
              signal: emailSignal, arc,
              url: unsubscribe.url,
              statusCode: response.status,
            });
            return err(c, 503, "Unsubscribe endpoint returned an error");
          }
        } catch (e) {
          clearTimeout(timeout);
          logger.warn("Unsubscribe POST failed — network error or timeout.", {
            code: "unsubscribe.post_error",
            signal: emailSignal, arc,
            url: unsubscribe.url,
            error: e,
          });
          return err(c, 503, "Failed to reach unsubscribe endpoint");
        }
      }

      if (unsubscribe.type === "mailto") {
        logger.track("Unsubscribe via mailto — user must complete externally.", {
          code: "unsubscribe.mailto_pending",
          signal: emailSignal, arc,
          url: unsubscribe.url,
        });
      }

      // Archive the arc regardless of unsubscribe type
      const archiveResult = await arcDb.updateThread(accountId, arc.id, "archived", arc.lastSignalAt, {});
      if (archiveResult.isErr()) return err(c, 500, "Internal Server Error");

      const responseUrl = unsubscribe.type !== "server" ? unsubscribe.url : undefined;
      return c.json({ status: "unsubscribed", ...(responseUrl ? { url: responseUrl } : {}) }, 200);
    });

    // -------------------------------------------------------------------------
    // Calendar RSVP  —  /accounts/:accountId/arcs/:arcId/signals/:id/rsvp
    // -------------------------------------------------------------------------

    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/arcs/{arcId}/signals/{id}/rsvp",
      tags: ["Signals"],
      request: { params: z.object({ accountId: z.string(), arcId: z.string(), id: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("arcId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: SignalSchema } }, description: "RSVP to calendar invite" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      if (!emailService || !rsvpComposer) return err(c, 501, "RSVP not configured");

      const arcResult = await arcDb.getThread(accountId, c.req.param("arcId")!);
      if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
      const arc = arcResult.value;
      if (!arc) return err(c, 404, "Thread not found", "THREAD_NOT_FOUND");

      const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!, c.req.param("arcId")!);
      if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (signal.threadId !== arc.id) return err(c, 400, "Signal does not belong to this thread", "SIGNAL_THREAD_MISMATCH");
      if (!isCalendarEventSignal(signal)) return err(c, 400, "Signal is not a calendar event", "NOT_CALENDAR_EVENT");

      const calendarData = signal.data;
      const body = await zParse(RsvpRequest, c.req.raw);

      const emailSignalResult = await arcDb.getSignalById(accountId, calendarData.linkedSignalId, arc.id);
      const emailSignal = emailSignalResult.isOk() ? emailSignalResult.value : null;
      const recipientAddress = emailSignal?.data && "recipientAddress" in emailSignal.data ? (emailSignal.data as { recipientAddress: string }).recipientAddress : "";

      if (!recipientAddress) return err(c, 400, "Cannot determine alias address for RSVP", "NO_ALIAS_ADDRESS");

      const aliasDomain = recipientAddress.split("@")[1] ?? "";
      const domainResult = await accountDb.getDomainByName(accountId, aliasDomain);
      if (domainResult.isErr()) return err(c, 500, "Internal Server Error");
      const domain = domainResult.value;

      if (!domain?.senderSetupComplete) {
        const now = DateTime.utc().toISO()!;
        const misconfigSignalId = generateId("sgn-");
        const misconfigSignal: Signal<DomainMisconfigurationData> = {
          id: misconfigSignalId,
          signalLookupId: misconfigSignalId,
          threadId: arc.id,
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
        await arcDb.saveSignal(misconfigSignal);
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
        { emailService },
      );

      if (rsvpResult.isErr()) {
        return err(c, 422, "Failed to send RSVP", "RSVP_SEND_FAILED");
      }

      const now = DateTime.utc().toISO()!;
      const responseSignalId = generateId("sgn-");
      const responseSignal: Signal<CalendarResponseData> = {
        id: responseSignalId,
        signalLookupId: responseSignalId,
        threadId: arc.id,
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

      const saveResult = await arcDb.saveSignal(responseSignal);
      if (saveResult.isErr()) return err(c, 500, "Internal Server Error");

      // Non-blocking RSVP schedule cancellation
      if (schedulerClient && calendarData.startTime) {
        const eventStart = DateTime.fromISO(calendarData.startTime, { zone: "utc" });
        if (eventStart.isValid && eventStart > DateTime.utc()) {
          const scheduleName = buildScheduleName(accountId, signal.id, `rsvp.${eventStart.toFormat("yyyyMMdd")}`);
          const deleteResult = await schedulerClient.deleteFollowup(scheduleName);
          if (deleteResult.isErr()) {
            logger.warn("Failed to delete RSVP reminder schedule — fire-time check will handle.", { code: "rsvp.cancel.delete_failed", signal, arc, scheduleName, error: deleteResult.error });
          }
        }
      } else if (schedulerClient && !calendarData.startTime) {
        logger.track("Calendar event has no startTime — skipping RSVP schedule cancellation.", { code: "rsvp.cancel.no_start_time", signal, arc });
      }

      return c.json(toApiSignal(responseSignal), 200);
    });

    // ---------------------------------------------------------------------------
    // Signal reprocess
    // ---------------------------------------------------------------------------

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
