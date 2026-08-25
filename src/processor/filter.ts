import { getDomain } from "tldts";
import type { Workflow, WorkflowData, UnknownSenderPolicy, SystemLabel, AliasSender, AuthData, SignalAction } from "../types/index.js";

// Extract eTLD+1 from an email address or domain string
export function getETLD1(emailOrDomain: string): string {
  const domain = emailOrDomain.includes("@")
    ? emailOrDomain.split("@").pop()!
    : emailOrDomain;
  return getDomain(domain) ?? domain;
}

export interface SystemLabelContext {
  workflow: Workflow;
  workflowData: WorkflowData;
  actions: SignalAction[];
  senderETLD1: string;
  aliasSenderConfig: AliasSender | null;
  unknownSenderPolicy: UnknownSenderPolicy;
  hasSentMessages: boolean;
}

// DO NOT add labels here without explicitly expanding the SystemLabel union type.
// assignSystemLabels() returns SystemLabel[] — any unlisted label is a compile-time error.
// That type constraint is the mandatory review gate for adding new system labels.
export function assignSystemLabels(ctx: SystemLabelContext): SystemLabel[] {
  const labels: SystemLabel[] = [];

  const senderTrusted =
    ctx.aliasSenderConfig?.policy === "allow" ||
    ctx.unknownSenderPolicy === "allow_all";
  if (!senderTrusted) labels.push("system:sender:untrusted");

  if (ctx.hasSentMessages) labels.push("system:replied");
  if (ctx.workflow === "auth" && (ctx.workflowData as AuthData).authType === "security_alert") {
    labels.push("system:auth:security_alert");
  }

  const workflowDataRecord = ctx.workflowData as unknown as Record<string, unknown>;
  const hasActionableUrl = ctx.actions.length > 0
    || Object.values(workflowDataRecord).some(v => typeof v === "string" && isUrl(v));
  if (hasActionableUrl) {
    labels.push("system:action");
  }

  return labels;
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
