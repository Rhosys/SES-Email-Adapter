import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { DateTime } from "luxon";
import { generateId } from "../utils/id.js";
import { getDomain } from "tldts";
import { validateRecipientMx } from "../dns/mx-validator.js";
import { computeUndoWindowSeconds } from "./undo-window.js";
import { zParse } from "./validate.js";
import { toApiArc, toApiSignal } from "./transform.js";
import { buildScheduleName } from "../scheduler/schedule-name.js";
import { durationToSeconds } from "../processor/retention.js";
import { isCalendarEventSignal, isEmailSignal } from "../types/index.js";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Arc, Signal, AnySignal, Attachment, PageParams, ArcStatus, Workflow } from "../types/index.js";
import type { CalendarEventData, CalendarResponseData, DomainMisconfigurationData, Pagination } from "../types/index.js";
import type { UpdateArcFields, ArcDatabase } from "../database/arc-database.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";
import type { DraftSendDispatcher } from "../processor/draft-send-dispatcher.js";
import type { EmailService } from "../email/email-service.js";
import type { sendRsvp as SendRsvpFn } from "../processor/calendar/rsvp-composer.js";
import type { PostApprovalCalendarHandlerDeps } from "../processor/calendar/post-approval-handler.js";
import type { SchedulerClient } from "../scheduler/scheduler-client.js";
import type { ProcessorError } from "../errors.js";
import {
  UpdateArcRequest, ReplaceDraftSignalRequest,
  CreateDraftSignalRequest, RsvpRequest,
} from "./requests.js";
import {
  Arc as ArcSchema, Signal as SignalSchema,
  ListArcsResponse, ListSignalsResponse,
} from "./schemas.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";
import type { SignalReprocessor, ListArcsParams } from "./arcsApi.js";

function page<K extends string, T>(key: K, items: T[], nextCursor?: string): Record<K, T[]> & { pagination: Pagination } {
  return { [key]: items, pagination: { cursor: nextCursor ?? null } } as Record<K, T[]> & { pagination: Pagination };
}

function withAttachmentUrls<T extends AnySignal>(signal: T, cdnBase: string): T {
  if (!isEmailSignal(signal)) return signal;
  return { ...signal, data: { ...signal.data, attachments: signal.data.attachments.map((a: Attachment) => ({ ...a, url: `${cdnBase}/${a.s3Key}` })) } };
}

export class ThreadsApi {
  constructor(
    private readonly arcDb: ArcDatabase,
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
      middleware: [authz("arcs:read", c => `accounts/${c.req.param("accountId")!}/arcs`)] as const,
      responses: { 200: { content: { "application/json": { schema: ListArcsResponse } }, description: "List threads" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const query = c.req.query();
      const q = query["q"];
      if (q) {
        const params: PageParams = {
          ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
          ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
        };
        const result = await arcDb.searchArcs(accountId, q, params);
        if (result.isErr()) return err(c, 500, "Internal Server Error");
        return c.json(page("arcs", result.value.items.map(toApiArc), result.value.nextCursor), 200);
      }
      const params: ListArcsParams = {
        ...(query["workflow"] ? { workflow: query["workflow"] as Workflow } : {}),
        ...(query["label"] ? { label: query["label"] } : {}),
        ...(query["status"] ? { status: query["status"] as ArcStatus } : {}),
        ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
        ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
      };
      const result = await arcDb.listArcs(accountId, params);
      if (result.isErr()) return err(c, 500, "Internal Server Error");
      return c.json(page("arcs", result.value.items.map(toApiArc), result.value.nextCursor), 200);
    });

    // -------------------------------------------------------------------------
    // 2. GET /accounts/{accountId}/threads/{threadId} — get thread
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/threads/{threadId}",
      tags: ["Threads"],
      request: { params: z.object({ accountId: z.string(), threadId: z.string() }) },
      middleware: [authz("arcs:read", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("threadId")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: ArcSchema } }, description: "Get thread" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      const arcResult = await arcDb.getArc(accountId, threadId);
      if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
      const arc = arcResult.value;
      if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
      return c.json(toApiArc(arc), 200);
    });

    // -------------------------------------------------------------------------
    // 3. PATCH /accounts/{accountId}/threads/{threadId} — update thread
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "patch",
      path: "/accounts/{accountId}/threads/{threadId}",
      tags: ["Threads"],
      request: { params: z.object({ accountId: z.string(), threadId: z.string() }) },
      middleware: [authz("arcs:write", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("threadId")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: ArcSchema } }, description: "Update thread" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      const arcResult = await arcDb.getArc(accountId, threadId);
      if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
      const arc = arcResult.value;
      if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
      const body = await zParse(UpdateArcRequest, c.req.raw);

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
          logger.track("Arc reported as GDPR violation. Sender domain blocked with report_violation policy and arc deleted.", {
            code: "api.arc.report_violation", signal, arc, senderDomain: senderETLD1,
          });
        }
        const updateResult = await arcDb.updateArc(accountId, arc.id, "deleted", arc.lastSignalAt, {});
        if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
        return c.json(toApiArc(updateResult.value), 200);
      }

      const fields: UpdateArcFields = {};
      if (body.urgency !== undefined) fields.urgency = body.urgency;
      if (body.labels !== undefined) fields.labels = body.labels;
      if (body.followupAt !== undefined) fields.followupAt = body.followupAt;
      const status = body.status ?? arc.status;
      const lastSignalAt = body.lastSignalAt ?? arc.lastSignalAt;

      if (body.followupAt) {
        const followupTime = new Date(body.followupAt).getTime();
        const now = Date.now();
        if (followupTime <= now) return err(c, 400, "followupAt must be in the future");
        if (arc.retentionDuration) {
          const retentionSeconds = durationToSeconds(arc.retentionDuration);
          if (retentionSeconds != null) {
            const expiresAt = new Date(arc.createdAt).getTime() + retentionSeconds * 1000;
            if (followupTime > expiresAt) return err(c, 400, "followupAt exceeds arc retention expiration");
          }
        }
      }

      const statusChanged = body.status !== undefined && body.status !== arc.status;
      const updateResult = await arcDb.updateArc(accountId, arc.id, status, lastSignalAt, fields);
      if (updateResult.isErr()) return err(c, 500, "Internal Server Error");

      if (body.followupAt && schedulerClient) {
        const signalsResult = await arcDb.listSignals(accountId, arc.id, { limit: 1 });
        const signalId = signalsResult.isOk() ? signalsResult.value.items[0]?.id ?? arc.id : arc.id;
        const scheduleResult = await schedulerClient.createFollowup({
          accountId, signalId, arcId: arc.id, fireAt: body.followupAt,
          suffix: "followup", sqsMessageAttributeMessageType: "signal_followup",
        });
        if (scheduleResult.isErr()) {
          if (statusChanged) await arcDb.updateArc(accountId, arc.id, arc.status, arc.lastSignalAt, {});
          return err(c, 500, "Failed to create followup schedule");
        }
      }

      return c.json(toApiArc(updateResult.value), 200);
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
      middleware: [authz("signals:read", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("threadId")!}/signals`)] as const,
      responses: { 200: { content: { "application/json": { schema: ListSignalsResponse } }, description: "List signals for thread" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      const arcResult = await arcDb.getArc(accountId, threadId);
      if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
      const arc = arcResult.value;
      if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
      const query = c.req.query();
      const params: PageParams = {
        ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
        ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
      };
      const result = await arcDb.listSignals(accountId, arc.id, params);
      if (result.isErr()) return err(c, 500, "Internal Server Error");

      const signals = result.value.items as unknown as AnySignal[];
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

    // -------------------------------------------------------------------------
    // 5. POST /accounts/{accountId}/threads/{threadId}/signals — create draft
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/threads/{threadId}/signals",
      tags: ["Threads"],
      request: { params: z.object({ accountId: z.string(), threadId: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("threadId")!}/signals`)] as const,
      responses: { 201: { content: { "application/json": { schema: SignalSchema } }, description: "Create draft signal" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      const arcResult = await arcDb.getArc(accountId, threadId);
      if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
      const arc = arcResult.value;
      if (!arc || arc.status === "deleted") return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
      const body = await zParse(CreateDraftSignalRequest, c.req.raw);
      const now = DateTime.utc().toISO()!;
      const id = generateId("sgn-");
      const signal: Signal = {
        id,
        signalLookupId: id,
        arcId: arc.id,
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
      await arcDb.updateArc(accountId, arc.id, arc.status, now, {});
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
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("threadId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: SignalSchema } }, description: "Replace draft signal" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      const arcResult = await arcDb.getArc(accountId, threadId);
      if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
      const arc = arcResult.value;
      if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
      const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!, threadId);
      if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (signal.arcId !== arc.id) return err(c, 400, "Signal does not belong to this arc", "SIGNAL_ARC_MISMATCH");
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

    // -------------------------------------------------------------------------
    // 7. POST /accounts/{accountId}/threads/{threadId}/signals/{id}/send
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/threads/{threadId}/signals/{id}/send",
      tags: ["Threads"],
      request: { params: z.object({ accountId: z.string(), threadId: z.string(), id: z.string() }) },
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("threadId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: z.object({}) } }, description: "Send draft signal" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;

      const arcResult = await arcDb.getArc(accountId, threadId);
      if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
      const arc = arcResult.value;
      if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");

      const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!, threadId);
      if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (signal.arcId !== arc.id) return err(c, 400, "Signal does not belong to this arc", "SIGNAL_ARC_MISMATCH");
      if (signal.status !== "draft") return err(c, 400, "Only draft signals can be sent", "SIGNAL_NOT_DRAFT");

      const mxResult = await validateRecipientMx(signal.data.to);
      if (mxResult.isErr()) {
        return err(c, 422, "Invalid recipient domain", "INVALID_RECIPIENT_DOMAIN", { invalidDomains: mxResult.error.invalidDomains });
      }

      if (signal.data.from.address !== arc.recipientAddress) {
        logger.track("Draft send: from address does not match arc alias — rejecting.", {
          code: "draft_send.from_address_mismatch", signal, arc,
          fromAddress: signal.data.from.address, arcRecipientAddress: arc.recipientAddress,
        });
        return err(c, 422, "From address does not match arc alias");
      }

      // ── Undo-send mechanism ──────────────────────────────────────────────
      // See arcsApi.ts send handler for full explanation of the flow.
      // TL;DR: SQS delay = undo window. If user cancels (PATCHes back to draft),
      // the delayed SQS message fires but DraftSendWorker discards it.
      const undoWindowSeconds = computeUndoWindowSeconds(signal.data.textBody);
      const sendInitiatedAt = DateTime.utc().toISO()!;
      const undoExpiresAt = DateTime.utc().plus({ seconds: undoWindowSeconds }).toISO()!;

      if (!draftSendDispatcher) return err(c, 501, "Send not configured");
      const sqsResult = await draftSendDispatcher.dispatch({ signalId: signal.id, accountId, sendInitiatedAt }, undoWindowSeconds);
      if (sqsResult.isErr()) return err(c, 500, "Internal Server Error");

      const updateResult = await arcDb.updateSignalSendStatus(accountId, signal.signalLookupId, { status: "pending_send", sendInitiatedAt });
      if (updateResult.isErr()) return err(c, 500, "Internal Server Error");

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
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("threadId")!}`)] as const,
      responses: {
        200: { content: { "application/json": { schema: z.object({ status: z.string(), url: z.string().optional() }) } }, description: "Unsubscribe initiated and thread archived" },
      },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      const arcResult = await arcDb.getArc(accountId, threadId);
      if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
      const arc = arcResult.value;
      if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");

      const signalsResult = await arcDb.listSignals(accountId, arc.id, { limit: 20 });
      if (signalsResult.isErr()) return err(c, 500, "Internal Server Error");

      const emailSignal = signalsResult.value.items.find(
        (s): s is Signal => s.type === "email" && s.source === "email" && Boolean((s.data as Signal["data"]).unsubscribe),
      );
      if (!emailSignal) return err(c, 400, "No unsubscribe info available for this arc");

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
              code: "unsubscribe.post_failed", signal: emailSignal, arc, url: unsubscribe.url, statusCode: response.status,
            });
            return err(c, 503, "Unsubscribe endpoint returned an error");
          }
        } catch (e) {
          clearTimeout(timeout);
          logger.warn("Unsubscribe POST failed — network error or timeout.", {
            code: "unsubscribe.post_error", signal: emailSignal, arc, url: unsubscribe.url, error: e,
          });
          return err(c, 503, "Failed to reach unsubscribe endpoint");
        }
      }

      if (unsubscribe.type === "mailto") {
        logger.track("Unsubscribe via mailto — user must complete externally.", {
          code: "unsubscribe.mailto_pending", signal: emailSignal, arc, url: unsubscribe.url,
        });
      }

      const archiveResult = await arcDb.updateArc(accountId, arc.id, "archived", arc.lastSignalAt, {});
      if (archiveResult.isErr()) return err(c, 500, "Internal Server Error");

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
      middleware: [authz("signals:write", c => `accounts/${c.req.param("accountId")!}/arcs/${c.req.param("threadId")!}/signals/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: SignalSchema } }, description: "RSVP to calendar invite" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      if (!emailService || !rsvpComposer) return err(c, 501, "RSVP not configured");

      const arcResult = await arcDb.getArc(accountId, threadId);
      if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
      const arc = arcResult.value;
      if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");

      const signalResult = await arcDb.getSignalById(accountId, c.req.param("id")!, threadId);
      if (signalResult.isErr()) return err(c, 500, "Internal Server Error");
      const signal = signalResult.value;
      if (!signal) return err(c, 404, "Signal not found", "SIGNAL_NOT_FOUND");
      if (signal.arcId !== arc.id) return err(c, 400, "Signal does not belong to this arc", "SIGNAL_ARC_MISMATCH");
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
          arcId: arc.id,
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

      if (rsvpResult.isErr()) return err(c, 422, "Failed to send RSVP", "RSVP_SEND_FAILED");

      const now = DateTime.utc().toISO()!;
      const responseSignalId = generateId("sgn-");
      const responseSignal: Signal<CalendarResponseData> = {
        id: responseSignalId,
        signalLookupId: responseSignalId,
        arcId: arc.id,
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
  }
}
