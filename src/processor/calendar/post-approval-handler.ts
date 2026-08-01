// ---------------------------------------------------------------------------
// Post-Approval Calendar Handler
//
// When a quarantined email signal is approved (status → "active"), this handler
// checks for .ics attachments, processes them (creating the calendar signal),
// and triggers calendar forwarding. This is necessary because quarantined signals
// skip calendar processing during initial ingest.
// ---------------------------------------------------------------------------

import { DateTime } from "luxon";
import type { ContentStore } from "../../content-store.js";

import type { Signal, Thread, Attachment } from "../../types/index.js";
import type { CalendarEventData, CalendarInviteInvalidData } from "../../types/calendar.js";
import type { ThreadDatabase } from "../../database/thread-database.js";
import type { AccountDatabase } from "../../database/account-database.js";
import type { Logger } from "../../logger.js";
import type { DbError, Result } from "../../errors.js";
import { ok, err, dbError } from "../../errors.js";
import { generateId } from "../../utils/id.js";
import { findCalendarAttachment, parseIcs } from "./ics-parser.js";
import { buildCalendarSignalLookupId } from "./signal-lookup.js";
import { forwardCalendarInvite, type CalendarForwarderDeps } from "./calendar-forwarder.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface PostApprovalCalendarHandlerDeps {
  threadDb: ThreadDatabase;
  accountDb: AccountDatabase;
  contentStore: ContentStore;
  calendarForwarderDeps: CalendarForwarderDeps;
  logger: Logger;
}

/**
 * After a quarantined email signal is approved and placed on a thread,
 * process any .ics attachment and forward the calendar invite.
 *
 * Best-effort: failures are logged but do not fail the approval.
 */
export async function handlePostApprovalCalendar(
  signal: Signal,
  thread: Thread,
  deps: PostApprovalCalendarHandlerDeps,
): Promise<void> {
  const { threadDb, accountDb, contentStore, calendarForwarderDeps, logger } = deps;
  const accountId = signal.accountId;

  // Check for calendar attachments
  const attachments: Attachment[] = signal.data.attachments ?? [];
  const calendarAttachment = findCalendarAttachment(attachments, logger);
  if (!calendarAttachment) return;

  logger.trackPoint("post_approval_calendar_start", { signalId: signal.id, threadId: thread.id });

  // Fetch .ics bytes from content store
  let icsBytes: Uint8Array;
  try {
    icsBytes = await contentStore.getObject(calendarAttachment.s3Key);
  } catch (e) {
    logger.warn("Post-approval calendar: failed to fetch .ics from content store.", {
      code: "processor.post_approval_calendar.s3_fetch_failed",
      accountId,
      signalId: signal.id,
      s3Key: calendarAttachment.s3Key,
      error: e,
    });
    return;
  }

  // Parse .ics
  const parseResult = parseIcs(new Uint8Array(icsBytes));

  if (parseResult.isErr()) {
    // Parse rejection — create calendar_invite_invalid signal
    const invalidId = generateId("sgn-");
    const invalidTimestamp = DateTime.utc().toISO()!;
    const invalidSignal: Signal<CalendarInviteInvalidData> = {
      id: invalidId,
      signalLookupId: invalidId,
      threadId: thread.id,
      accountId,
      source: "signal",
      type: "calendar_invite_invalid",
      status: "active",
      labels: [],
      createdAt: invalidTimestamp,
      data: {
        reason: parseResult.error.reason,
        linkedSignalId: signal.id,
      },
    };
    await threadDb.saveSignal(invalidSignal);
    logger.warn("Post-approval calendar: .ics rejected by parser.", {
      code: "processor.post_approval_calendar.parse_rejected",
      accountId,
      signalId: signal.id,
      reason: parseResult.error.reason,
    });
    return;
  }

  // Valid parse — create calendar signal
  const { calendarData, rawIcsContent } = parseResult.value;
  const calendarSignalId = generateId("sgn-");
  const calendarTimestamp = DateTime.utc().toISO()!;
  const signalLookupId = buildCalendarSignalLookupId(calendarData.organizer, calendarData.veventUid);

  // Store raw .ics as attachment on the calendar signal
  const icsS3Key = `accounts/${accountId}/calendar/${calendarSignalId}/invite.ics`;
  try {
    await contentStore.saveIcsContentAsCalendar(icsS3Key, rawIcsContent);
  } catch (e) {
    logger.warn("Post-approval calendar: failed to store .ics in content store.", {
      code: "processor.post_approval_calendar.s3_put_failed",
      accountId,
      signalId: signal.id,
      error: e,
    });
    return;
  }

  // Build calendar signal with linkedSignalId pointing to the email signal
  const calendarSignal: Signal<CalendarEventData> = {
    id: calendarSignalId,
    signalLookupId,
    threadId: thread.id,
    accountId,
    source: "signal",
    type: "calendar_event",
    status: "active",
    labels: [],
    createdAt: calendarTimestamp,
    data: {
      ...calendarData,
      linkedSignalId: signal.id,
    },
  };

  // Forward first — external write before DB writes so a DDB failure never
  // leaves a committed record pointing to a calendar invite that was never sent.
  const accountResult = await accountDb.getAccount(accountId);
  const calendarForwardingAddress = accountResult.isOk()
    ? accountResult.value?.defaultCalendarInviteForwardingTargetId ?? ""
    : "";

  const forwardResult = await forwardCalendarInvite(
    {
      calendarSignal,
      calendarForwardingAddress,
      accountId,
      threadId: thread.id,
      aliasAddress: signal.data.recipientAddress,
    },
    calendarForwarderDeps,
    logger,
  );

  if (forwardResult.isErr()) {
    logger.warn("Post-approval calendar: forwarding failed.", {
      code: "processor.post_approval_calendar.forward_failed",
      accountId,
      signalId: signal.id,
      calendarSignalId,
      error: forwardResult.error,
    });
    return;
  }

  const saveCalResult = await threadDb.saveSignal(calendarSignal);
  if (saveCalResult.isErr()) {
    logger.warn("Post-approval calendar: failed to save calendar signal.", {
      code: "processor.post_approval_calendar.save_failed",
      accountId,
      signalId: signal.id,
      error: saveCalResult.error,
    });
    return;
  }

  // Apply system:calendar label to the thread
  if (!thread.labels.includes("system:calendar")) {
    thread.labels = [...thread.labels, "system:calendar"];
    const updateResult = await threadDb.updateThread(accountId, thread.id, thread.status, thread.lastSignalAt!, { labels: thread.labels });
    if (updateResult.isErr()) {
      logger.warn("Post-approval calendar: failed to apply system:calendar label.", {
        code: "processor.post_approval_calendar.label_failed",
        accountId,
        threadId: thread.id,
        error: updateResult.error,
      });
    }
  }

  logger.info("Post-approval calendar: processed and forwarded.", {
    code: "processor.post_approval_calendar.complete",
    accountId,
    signalId: signal.id,
    calendarSignalId,
    threadId: thread.id,
    method: calendarData.method,
  });
}
