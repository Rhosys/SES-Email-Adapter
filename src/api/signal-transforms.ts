/**
 * Shared signal/thread transform functions used by both signalsApi and threadsApi.
 */
import type {
  Thread as DbThread,
  AnySignal,
  Attachment,
  EmailSignalData,
  InboundEmailSignalData,
  DeliverabilitySignalData,
  MatchedRuleResult,
  Signal as DbSignal,
} from "../types/index.js";
import { isEmailSignal } from "../types/index.js";
import type * as Api from "./schemas.js";

// matchedRules is an append-only trace (e.g. a signal dismissed from quarantine gets a second
// SR-00 entry alongside whatever originally quarantined it). Collapse same-id entries down to the
// last one found before returning to the client, so re-evaluations/dismissals read as the current
// explanation rather than a duplicate-keyed list.
function collapseMatchedRules(rules: MatchedRuleResult[]): MatchedRuleResult[] {
  const byRuleId = new Map<string, MatchedRuleResult>();
  for (const rule of rules) byRuleId.set(rule.ruleId, rule);
  return [...byRuleId.values()];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Resolves what the content sanitizer left as s3Key-only references (never a baked-in URL,
// so CDN config can change without a data migration) into CDN urls, at API read time:
//  - Attachment.s3Key -> Attachment.url, as before.
//  - Any `cid:{contentId}` left unresolved in htmlBody (an inline image too large, or past
//    the per-message budget, to embed as a data URI — see MAX_INLINE_DATA_URI_SIZE /
//    MAX_INLINE_DATA_URI_COUNT in the content sanitizer) -> the matching InlineImageRef's CDN url.
// inlineImages itself is intentionally not included on the returned signal — it's write-side
// plumbing for this substitution, not something the client needs.
export function withResolvedContentUrls<T extends AnySignal>(signal: T, cdnBase: string): T {
  if (!isEmailSignal(signal)) return signal;

  const attachments = signal.data.attachments.map((a: Attachment) => ({ ...a, url: `${cdnBase}/${a.s3Key}` }));

  const inlineImages = (signal.data as InboundEmailSignalData).inlineImages;
  let htmlBody = (signal.data as InboundEmailSignalData).htmlBody;
  if (htmlBody && inlineImages && inlineImages.length > 0) {
    for (const ref of inlineImages) {
      htmlBody = htmlBody.replace(new RegExp(`cid:${escapeRegExp(ref.contentId)}`, "g"), `${cdnBase}/${ref.s3Key}`);
    }
  }

  return {
    ...signal,
    data: {
      ...signal.data,
      attachments,
      ...(htmlBody !== undefined ? { htmlBody } : {}),
    },
  } as T;
}

export function toApiThread(thread: DbThread): Api.Thread {
  return {
    threadId: thread.id,
    workflow: thread.workflow as Api.Thread["workflow"],
    labels: thread.labels,
    status: thread.status as Api.Thread["status"],
    summary: thread.summary,
    lastSignalAt: thread.lastSignalAt,
    ...(thread.deletedAt ? { deletedAt: thread.deletedAt } : {}),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    ...(thread.retentionDuration ? { retentionDuration: thread.retentionDuration as Api.Thread["retentionDuration"] } : {}),
    ...(thread.urgency ? { urgency: thread.urgency as Api.Thread["urgency"] } : {}),
    ...(thread.followupAt ? { followupAt: thread.followupAt } : {}),
    sender: { address: thread.sender?.address ?? "", ...(thread.sender?.name ? { name: thread.sender.name } : {}) },
    recipientAddress: thread.recipientAddress ?? "",
    subject: thread.subject ?? "",
  };
}

function toApiSource(source: DbSignal["source"]): "system" | "user" {
  return source === "user" ? "user" : "system";
}

function toApiEmailSignalData(data: EmailSignalData): Api.InboundEmailSignalData | Api.OutboundEmailSignalData {
  if ("sendInitiatedAt" in data && data.sendInitiatedAt !== undefined) {
    // Outbound email (user-composed)
    const outbound: Api.OutboundEmailSignalData = {
      from: data.from,
      to: data.to,
      cc: data.cc,
      bcc: [],
      ...(data.replyTo ? { replyTo: data.replyTo } : {}),
      subject: data.subject,
      ...(data.htmlBody ? { body: data.htmlBody } : {}),
      attachments: (data.attachments ?? []).map(a => ({
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        ...((a as unknown as { url?: string }).url ? { url: (a as unknown as { url: string }).url } : {}),
      })),
      sendInitiatedAt: data.sendInitiatedAt,
      ...(data.sentAt ? { sentAt: data.sentAt } : {}),
      ...(data.sendFailureReason ? { sendFailureReason: data.sendFailureReason } : {}),
    };
    return outbound;
  }

  // Inbound email
  const inbound: Api.InboundEmailSignalData = {
    receivedAt: data.receivedAt,
    summary: data.summary,
    ...(data.urgency ? { urgency: data.urgency as Api.InboundEmailSignalData["urgency"] } : {}),
    from: data.from,
    to: data.to,
    cc: data.cc,
    ...(data.replyTo ? { replyTo: data.replyTo } : {}),
    subject: data.subject,
    ...(data.htmlBody ? { body: data.htmlBody } : {}),
    attachments: (data.attachments ?? []).map(a => ({
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      ...((a as unknown as { url?: string }).url ? { url: (a as unknown as { url: string }).url } : {}),
    })),
    headers: data.headers ?? {},
    recipientAddress: data.recipientAddress,
    workflow: data.workflow as Api.InboundEmailSignalData["workflow"],
    ...(data.workflowData ? { workflowData: data.workflowData as Api.InboundEmailSignalData["workflowData"] } : {}),
    ...(data.matchedRules ? { matchedRules: collapseMatchedRules(data.matchedRules) as Api.InboundEmailSignalData["matchedRules"] } : {}),
    ...(data.unsubscribe ? { unsubscribe: data.unsubscribe } : {}),
  };
  return inbound;
}

function toApiCalendarData(type: string, data: unknown): unknown {
  if (type === "calendar_event") {
    const d = data as import("../types/calendar.js").CalendarEventData;
    return {
      title: d.title,
      ...(d.description ? { description: d.description } : {}),
      startTime: d.startTime,
      ...(d.endTime ? { endTime: d.endTime } : {}),
      ...(d.location ? { location: d.location } : {}),
      ...(d.url ? { url: d.url } : {}),
      organizer: d.organizer,
      ...(d.organizerCn ? { organizerName: d.organizerCn } : {}),
      attendees: (d.attendees ?? []).map(a => ({
        address: a.address,
        ...(a.cn ? { name: a.cn } : {}),
        ...(a.partstat ? { rsvpStatus: a.partstat } : {}),
        ...(a.role ? { optional: a.role === "OPT-PARTICIPANT" } : {}),
      })),
      linkedSignalId: d.linkedSignalId,
    };
  }
  if (type === "calendar_response") {
    const d = data as import("../types/calendar.js").CalendarResponseData;
    return {
      rsvpResponse: d.decision,
      respondedAt: d.respondedAt,
      linkedSignalId: d.linkedSignalId,
    };
  }
  return data;
}

export function toApiSignal(signal: AnySignal): Api.Signal {
  const base = {
    signalId: signal.id,
    threadId: signal.threadId ?? null,
    source: toApiSource(signal.source),
    status: signal.status as Api.Signal["status"],
    createdAt: signal.createdAt,
  };

  switch (signal.type) {
    case "email": {
      const emailData = signal.data as EmailSignalData;
      if ("sendInitiatedAt" in emailData && emailData.sendInitiatedAt !== undefined) {
        return {
          ...base,
          type: "email" as const,
          data: toApiEmailSignalData(emailData) as Api.OutboundEmailSignalData,
        } as Api.Signal;
      }
      return {
        ...base,
        type: "email" as const,
        data: toApiEmailSignalData(emailData) as Api.InboundEmailSignalData,
      } as Api.Signal;
    }
    case "deliverability": {
      const d = signal.data as DeliverabilitySignalData;
      return {
        ...base,
        type: "deliverability" as const,
        data: {
          linkedSignalId: d.linkedSignalId,
          bouncedRecipients: d.bouncedRecipients,
          subject: d.subject,
        },
      } as Api.Signal;
    }
    case "invalid_rule_function":
    case "invalid_template_function":
    case "auto_send_blocked":
    case "calendar_event":
    case "calendar_response":
    case "calendar_invite_invalid":
    case "domain_misconfiguration":
      // These data shapes match API shapes directly (after DB type cleanup)
      return {
        ...base,
        type: signal.type,
        data: toApiCalendarData(signal.type, signal.data),
      } as Api.Signal;
  }
}
