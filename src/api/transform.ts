/**
 * Transform functions: DB types → API types
 * These strip internal fields, rename properties, and simplify values for the public API.
 */
import type {
  Arc as DbArc,
  Signal as DbSignal,
  AnySignal,
  EmailSignalData,
  DeliverabilitySignalData,
  Domain as DbDomain,
  DnsRecord,
  Alias as DbAlias,
  AliasSender as DbAliasSender,
  Label as DbLabel,
  Rule as DbRule,
  View as DbView,
  Account as DbAccount,
  EmailTemplate as DbEmailTemplate,
  ForwardingTarget as DbForwardingTarget,
} from "../types/index.js";
import type * as Api from "./schemas.js";

// ---------------------------------------------------------------------------
// Arc
// ---------------------------------------------------------------------------

export function toApiArc(arc: DbArc): Api.Arc {
  return {
    arcId: arc.id,
    threadId: arc.id,
    workflow: arc.workflow as Api.Arc["workflow"],
    labels: arc.labels,
    status: arc.status as Api.Arc["status"],
    summary: arc.summary,
    lastSignalAt: arc.lastSignalAt,
    ...(arc.deletedAt ? { deletedAt: arc.deletedAt } : {}),
    createdAt: arc.createdAt,
    updatedAt: arc.updatedAt,
    ...(arc.retentionDuration ? { retentionDuration: arc.retentionDuration as Api.Arc["retentionDuration"] } : {}),
    ...(arc.urgency ? { urgency: arc.urgency as Api.Arc["urgency"] } : {}),
    ...(arc.followupAt ? { followupAt: arc.followupAt } : {}),
    senderAddress: arc.senderAddress ?? "",
    recipientAddress: arc.recipientAddress ?? "",
    subject: arc.subject ?? "",
  };
}

// ---------------------------------------------------------------------------
// Signal
// ---------------------------------------------------------------------------

function toApiSource(source: DbSignal["source"]): "system" | "user" {
  return source === "user" ? "user" : "system";
}

function toApiEmailSignalData(data: EmailSignalData): Api.InboundEmailSignalData | Api.OutboundEmailSignalData {
  if (data.sendInitiatedAt !== undefined) {
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
        attachmentId: a.filename,
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
      attachmentId: a.filename,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      ...((a as unknown as { url?: string }).url ? { url: (a as unknown as { url: string }).url } : {}),
    })),
    headers: data.headers ?? {},
    recipientAddress: data.recipientAddress,
    workflow: data.workflow as Api.InboundEmailSignalData["workflow"],
    ...(data.workflowData ? { workflowData: data.workflowData as Api.InboundEmailSignalData["workflowData"] } : {}),
    ...(data.matchedRules ? { matchedRules: data.matchedRules as Api.InboundEmailSignalData["matchedRules"] } : {}),
    ...(data.unsubscribe ? { unsubscribe: data.unsubscribe } : {}),
  };
  return inbound;
}

export function toApiSignal(signal: AnySignal): Api.Signal {
  const base = {
    signalId: signal.id,
    ...(signal.arcId ? { arcId: signal.arcId, threadId: signal.arcId } : {}),
    source: toApiSource(signal.source),
    status: signal.status as Api.Signal["status"],
    createdAt: signal.createdAt,
  };

  switch (signal.type) {
    case "email": {
      const emailData = signal.data as EmailSignalData;
      if (emailData.sendInitiatedAt !== undefined) {
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

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export function toApiDomain(domain: DbDomain): Api.Domain {
  return {
    domainId: domain.domain,
    domain: domain.domain,
    receivingSetupComplete: domain.receivingSetupComplete,
    senderSetupComplete: domain.senderSetupComplete,
    createdAt: domain.createdAt,
    updatedAt: domain.updatedAt,
  };
}

export function toApiDomainWithRecords(domain: DbDomain, records: DnsRecord[]): Api.DomainWithRecords {
  return {
    ...toApiDomain(domain),
    records,
  };
}

// ---------------------------------------------------------------------------
// Alias
// ---------------------------------------------------------------------------

export function toApiAlias(alias: DbAlias): Api.Alias {
  return {
    alias: alias.id,
    address: alias.address,
    unknownSenderPolicy: alias.unknownSenderPolicy as Api.Alias["unknownSenderPolicy"],
    createdAt: alias.createdAt,
    updatedAt: alias.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// AliasSender
// ---------------------------------------------------------------------------

export function toApiAliasSender(sender: DbAliasSender): Api.AliasSender {
  return {
    alias: sender.aliasAddress,
    sender: sender.senderDomain,  // DB stores eTLD+1; exposed as sender field
    policy: sender.policy as Api.AliasSender["policy"],
    createdAt: sender.addedAt,
    updatedAt: sender.addedAt,  // DB doesn't have updatedAt yet
  };
}

// ---------------------------------------------------------------------------
// Label
// ---------------------------------------------------------------------------

export function toApiLabel(label: DbLabel): Api.Label {
  return {
    label: label.id,
    name: label.name,
    ...(label.color ? { color: label.color } : {}),
    ...(label.icon ? { icon: label.icon } : {}),
    createdAt: label.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Rule
// ---------------------------------------------------------------------------

export function toApiRule(rule: DbRule): Api.Rule {
  return {
    ruleId: rule.id,
    name: rule.name,
    ...(rule.condition ? { condition: rule.condition } : {}),
    ...(rule.conditionType ? { conditionType: rule.conditionType } : {}),
    actions: rule.actions,
    status: rule.status as Api.Rule["status"],
    priorityOrder: rule.priorityOrder,
    ...(rule.accountId === "SYSTEM" ? { type: "IMMUTABLE" as const } : {}),
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function toApiView(view: DbView): Api.View {
  return {
    viewId: view.id,
    name: view.name,
    ...(view.icon ? { icon: view.icon } : {}),
    ...(view.color ? { color: view.color } : {}),
    ...(view.workflow ? { workflow: view.workflow as Api.View["workflow"] } : {}),
    labels: view.labels,
    sortField: view.sortField as Api.View["sortField"],
    sortDirection: view.sortDirection as Api.View["sortDirection"],
    position: view.position,
    ...(view.layout ? { layout: view.layout as unknown[] } : {}),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export function toApiAccount(account: DbAccount): Api.Account {
  return {
    accountId: account.id,
    name: account.name,
    ...(account.retentionDuration ? { retentionDuration: account.retentionDuration as Api.Account["retentionDuration"] } : {}),
    ...(account.filtering ? { filtering: account.filtering as Api.Account["filtering"] } : {}),
    ...(account.onboarding ? { onboarding: account.onboarding } : {}),
    ...(account.billingPlan ? { billingPlan: account.billingPlan } : {}),
    ...(account.afterSendAction ? { afterSendAction: account.afterSendAction } : {}),
    ...(account.defaultCalendarInviteForwardingAddress ? { defaultCalendarInviteForwardingAddress: account.defaultCalendarInviteForwardingAddress } : {}),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// EmailTemplate
// ---------------------------------------------------------------------------

export function toApiTemplate(template: DbEmailTemplate): Api.EmailTemplate {
  return {
    templateId: template.id,
    name: template.name,
    subject: template.subject,
    body: template.body,
    ...(template.functions ? { functions: template.functions } : {}),
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// ForwardingTarget
// ---------------------------------------------------------------------------

export function toApiForwardingTarget(fa: DbForwardingTarget): Api.ForwardingTarget {
  return {
    target: fa.target,
    type: fa.type,
    status: fa.status,
    createdAt: fa.createdAt,
    ...(fa.verifiedAt ? { verifiedAt: fa.verifiedAt } : {}),
  };
}
