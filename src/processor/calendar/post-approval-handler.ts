// ---------------------------------------------------------------------------
// Post-Approval Calendar Handler
//
// When a quarantined email signal is approved (status → "active"), this handler
// checks for .ics attachments, processes them (creating the calendar signal),
// and triggers calendar forwarding. This is necessary because quarantined signals
// skip calendar processing during initial ingest.
// ---------------------------------------------------------------------------

import type { S3Client } from "@aws-sdk/client-s3";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { DateTime } from "luxon";

import type { Signal, Arc, Attachment } from "../../types/index.js";
import type { CalendarEventData, CalendarInviteInvalidData } from "../../types/calendar.js";
import type { ArcDatabase } from "../../database/arc-database.js";
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
  arcDb: ArcDatabase;
  accountDb: AccountDatabase;
  s3Client: S3Client;
  contentBucket: string;
  calendarForwarderDeps: CalendarForwarderDeps;
  logger: Logger;
}

/**
 * After a quarantined email signal is approved and placed on an arc,
 * process any .ics attachment and forward the calendar invite.
 *
 * Best-effort: failures are logged but do not fail the approval.
 */
export async function handlePostApprovalCalendar(
  signal: Signal,
  arc: Arc,
  deps: PostApprovalCalendarHandlerDeps,
): Promise<void> {
  const { arcDb, accountDb, s3Client, contentBucket, calendarForwarderDeps, logger } = deps;
  const accountId = signal.accountId;

  // Check for calendar attachments
  const attachments: Attachment[] = signal.data.attachments ?? [];
  const calendarAttachment = findCalendarAttachment(attachments, logger);
  if (!calendarAttachment) return;

  logger.trackPoint("post_approval_calendar_start", { signalId: signal.id, arcId: arc.id });

  // Fetch .ics bytes from S3
  let icsBytes: Uint8Array;
  try {
    const getResult = await s3Client.send(new GetObjectCommand({
      Bucket: contentBucket,
      Key: calendarAttachment.s3Key,
    }));
    icsBytes = await getResult.Body!.transformToByteArray();
  } catch (e) {
    logger.warn("Post-approval calendar: failed to fetch .ics from S3.", {
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
      arcId: arc.id,
      accountId,
      source: "signal",
      type: "calendar_invite_invalid",
      status: "active",
      createdAt: invalidTimestamp,
      data: {
        reason: parseResult.error.reason,
        linkedSignalId: signal.id,
      },
    };
    await arcDb.saveSignal(invalidSignal);
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

  // Store raw .ics as S3 attachment on the calendar signal
  const icsS3Key = `accounts/${accountId}/calendar/${calendarSignalId}/invite.ics`;
  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: contentBucket,
      Key: icsS3Key,
      Body: Buffer.from(rawIcsContent, "utf-8"),
      ContentType: "text/calendar",
    }));
  } catch (e) {
    logger.warn("Post-approval calendar: failed to store .ics in S3.", {
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
    arcId: arc.id,
    accountId,
    source: "signal",
    type: "calendar_event",
    status: "active",
    createdAt: calendarTimestamp,
    data: {
      ...calendarData,
      linkedSignalId: signal.id,
    },
  };

  const saveCalResult = await arcDb.saveSignal(calendarSignal);
  if (saveCalResult.isErr()) {
    logger.warn("Post-approval calendar: failed to save calendar signal.", {
      code: "processor.post_approval_calendar.save_failed",
      accountId,
      signalId: signal.id,
      error: saveCalResult.error,
    });
    return;
  }

  // Apply system:calendar label to the arc
  if (!arc.labels.includes("system:calendar")) {
    arc.labels = [...arc.labels, "system:calendar"];
    const updateResult = await arcDb.updateArc(accountId, arc.id, arc.status, arc.lastSignalAt!, { labels: arc.labels });
    if (updateResult.isErr()) {
      logger.warn("Post-approval calendar: failed to apply system:calendar label.", {
        code: "processor.post_approval_calendar.label_failed",
        accountId,
        arcId: arc.id,
        error: updateResult.error,
      });
    }
  }

  // Forward the calendar invite
  const accountResult = await accountDb.getAccount(accountId);
  const calendarForwardingAddress = accountResult.isOk()
    ? accountResult.value?.defaultCalendarInviteForwardingAddress ?? ""
    : "";

  const forwardResult = await forwardCalendarInvite(
    {
      calendarSignal,
      calendarForwardingAddress,
      accountId,
      arcId: arc.id,
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

  logger.info("Post-approval calendar: processed and forwarded.", {
    code: "processor.post_approval_calendar.complete",
    accountId,
    signalId: signal.id,
    calendarSignalId,
    arcId: arc.id,
    method: calendarData.method,
  });
}
