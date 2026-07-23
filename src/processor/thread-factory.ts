// ---------------------------------------------------------------------------
// Factory for constructing active Thread objects — per 018-ARCH §36.
//
// Every code path that creates a new active Thread must go through this factory
// to ensure all required derived fields (retentionDuration, ttl) are set.
// ---------------------------------------------------------------------------

import { DateTime } from "luxon";
import { generateId } from "../utils/id.js";
import { durationToSeconds } from "./retention.js";
import type { RetentionDuration } from "./retention.js";
import type { Thread, Workflow } from "../types/index.js";

export interface BuildActiveThreadParams {
  accountId: string;
  workflow: Workflow;
  summary: string;
  lastSignalAt: string;
  senderAddress: string;
  recipientAddress: string;
  subject: string;
  retentionDuration: RetentionDuration;
  groupingKey?: string | undefined;
}

export function buildActiveThread(params: BuildActiveThreadParams): Thread {
  const now = DateTime.utc().toISO()!;
  const retentionSecs = durationToSeconds(params.retentionDuration);
  const ttl = retentionSecs != null
    ? Math.floor(Date.now() / 1000) + retentionSecs
    : undefined;

  return {
    id: generateId("thr-"),
    accountId: params.accountId,
    workflow: params.workflow,
    labels: [],
    status: "active",
    summary: params.summary,
    lastSignalAt: params.lastSignalAt,
    senderAddress: params.senderAddress,
    recipientAddress: params.recipientAddress,
    subject: params.subject,
    createdAt: now,
    updatedAt: now,
    retentionDuration: params.retentionDuration,
    ...(ttl !== undefined ? { ttl } : {}),
    ...(params.groupingKey ? { groupingKey: params.groupingKey } : {}),
  };
}
