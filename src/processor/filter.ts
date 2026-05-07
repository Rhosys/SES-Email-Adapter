import { getDomain } from "tldts";
import type { Workflow, WorkflowData, SenderFilterMode, SystemLabel } from "../types/index.js";

export const DEFAULT_SPAM_SCORE_THRESHOLD = 0.9;

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
  approvedSenders: string[];
  filterMode: SenderFilterMode;
  hasSentMessages: boolean;
}

// DO NOT add labels here without explicitly expanding the SystemLabel union type.
// assignSystemLabels() returns SystemLabel[] — any unlisted label is a compile-time error.
// That type constraint is the mandatory review gate for adding new system labels.
export function assignSystemLabels(ctx: SystemLabelContext): SystemLabel[] {
  const labels: SystemLabel[] = [];

  labels.push(`system:workflow:${ctx.workflow}` as SystemLabel);

  if (ctx.spamScore >= ctx.spamScoreThreshold) labels.push("system:spam:high");
  else if (ctx.spamScore >= 0.4) labels.push("system:spam:medium");

  const senderApproved = ctx.approvedSenders.includes(ctx.senderETLD1) || ctx.filterMode === "allow_all";
  if (!senderApproved) labels.push("system:sender:untrusted");

  if (ctx.hasSentMessages) labels.push("system:replied");
  if (ctx.workflow === "test") labels.push("system:test");

  return labels;
}
