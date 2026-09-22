// ---------------------------------------------------------------------------
// Factory for constructing active Thread objects — per 018-ARCH §36.
//
// Every code path that creates a new active Thread must go through this factory
// to ensure all required derived fields (retentionDuration, ttl) are set.
//
// PRODUCT INVARIANT: TTL is computed once at creation time and never refreshed.
// Thread expiry = createdAt + retentionDuration. Subsequent signals update the
// retentionDuration metadata field (so config changes are visible) but do NOT
// recompute ttl. The DynamoDB item expires relative to its creation timestamp.
// ---------------------------------------------------------------------------

import { DateTime } from "luxon";
import { generateId } from "./utils/id.js";
import type { RetentionDuration } from "./retention.js";
import type { Thread, Workflow } from "./types/index.js";

export interface BuildActiveThreadParams {
  accountId: string;
  workflow: Workflow;
  summary: string;
  lastSignalAt: string;
  sender: { address: string; name?: string | undefined };
  recipientAddress: string;
  subject: string;
  retentionDuration: RetentionDuration;
  groupingKey?: string | undefined;
}

export function buildActiveThread(params: BuildActiveThreadParams): Thread {
  const now = DateTime.utc().toISO()!;

  return {
    id: generateId("thr-"),
    accountId: params.accountId,
    workflow: params.workflow,
    labels: [],
    status: "active",
    summary: params.summary,
    lastSignalAt: params.lastSignalAt,
    sender: params.sender,
    recipientAddress: params.recipientAddress,
    subject: params.subject,
    createdAt: now,
    updatedAt: now,
    // TTL is derived from retentionDuration at the write boundary (saveThread) — not set here.
    retentionDuration: params.retentionDuration,
    ...(params.groupingKey ? { groupingKey: params.groupingKey } : {}),
  };
}
