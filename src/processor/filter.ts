import { getDomain } from "tldts";
import type { Workflow, WorkflowData, UnknownSenderPolicy, SystemLabel, AliasSender, AuthData } from "../types/index.js";

export const DEFAULT_SPAM_SCORE_THRESHOLD = 9;

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
  spamScore: number;
  spamScoreThreshold: number;
  senderETLD1: string;
  aliasSenderConfig: AliasSender | null;  // pre-fetched allow/block entry for this (alias, sender domain) pair
  unknownSenderPolicy: UnknownSenderPolicy;
  hasSentMessages: boolean;
}

// DO NOT add labels here without explicitly expanding the SystemLabel union type.
// assignSystemLabels() returns SystemLabel[] — any unlisted label is a compile-time error.
// That type constraint is the mandatory review gate for adding new system labels.
export function assignSystemLabels(ctx: SystemLabelContext): SystemLabel[] {
  const labels: SystemLabel[] = [];

  labels.push(`system:workflow:${ctx.workflow}` as SystemLabel);

  if (ctx.spamScore >= ctx.spamScoreThreshold / 10) labels.push("system:spam:high");
  else if (ctx.spamScore >= 0.4) labels.push("system:spam:medium");

  const senderTrusted =
    ctx.aliasSenderConfig?.policy === "allow" ||
    ctx.unknownSenderPolicy === "allow_all";
  if (!senderTrusted) labels.push("system:sender:untrusted");

  if (ctx.hasSentMessages) labels.push("system:replied");
  if (ctx.workflow === "test") labels.push("system:test");
  if (ctx.workflow === "auth" && (ctx.workflowData as AuthData).authType === "security_alert") {
    labels.push("system:auth:security_alert");
  }

  return labels;
}
