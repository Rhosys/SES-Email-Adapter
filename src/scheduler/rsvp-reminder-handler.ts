import { DateTime } from "luxon";

import { ok, err } from "../errors.js";
import type { Result, DbError } from "../errors.js";
import type { Signal, Arc } from "../types/index.js";
import type { CalendarEventData } from "../types/calendar.js";
import type { Notifier, NotificationReason } from "../notifier/types.js";
import type { Logger } from "../logger.js";
import type { RsvpReminderMessage } from "./rsvp-reminder.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export class RsvpReminderHandler {
  private readonly signalDb: { getSignalById(accountId: string, signalId: string, arcId?: string): Promise<Result<Signal | null, DbError>> };
  private readonly calendarDb: { getLatestCalendarResponse(accountId: string, arcId: string, veventUid: string): Promise<Result<Signal | null, DbError>> };
  private readonly arcDb: { getArc(accountId: string, arcId: string): Promise<Result<Arc | null, DbError>> };
  private readonly notifier: Notifier;
  private readonly logger: Logger;

  constructor(deps: {
    signalDb: { getSignalById(accountId: string, signalId: string, arcId?: string): Promise<Result<Signal | null, DbError>> };
    calendarDb: { getLatestCalendarResponse(accountId: string, arcId: string, veventUid: string): Promise<Result<Signal | null, DbError>> };
    arcDb: { getArc(accountId: string, arcId: string): Promise<Result<Arc | null, DbError>> };
    notifier: Notifier;
    logger: Logger;
  }) {
    this.signalDb = deps.signalDb;
    this.calendarDb = deps.calendarDb;
    this.arcDb = deps.arcDb;
    this.notifier = deps.notifier;
    this.logger = deps.logger;
  }

  async process(message: RsvpReminderMessage): Promise<Result<void, DbError>> {
    const { accountId, signalId, arcId } = message;

    // 1. Fetch signal
    const signalResult = await this.signalDb.getSignalById(accountId, signalId, arcId);
    if (signalResult.isErr()) return err(signalResult.error);

    const signal = signalResult.value;
    if (!signal) {
      this.logger.track("RSVP reminder: signal not found, discarding.", {
        code: "rsvp_reminder.signal_missing",
        accountId, signalId, arcId,
      });
      return ok(undefined);
    }

    // 2. Extract startTime and veventUid from calendar event data
    const calendarData = signal.data as unknown as CalendarEventData;
    const { veventUid, startTime } = calendarData;

    // 3. Check if event has passed
    const eventStart = DateTime.fromISO(startTime, { zone: "utc" });
    if (!eventStart.isValid || eventStart <= DateTime.utc()) {
      this.logger.track("RSVP reminder: event has passed, discarding.", {
        code: "rsvp_reminder.event_passed",
        accountId, signalId, arcId, startTime,
      });
      return ok(undefined);
    }

    // 4. Check if user has already responded
    const responseResult = await this.calendarDb.getLatestCalendarResponse(accountId, arcId, veventUid);
    if (responseResult.isErr()) return err(responseResult.error);

    if (responseResult.value) {
      this.logger.track("RSVP reminder: user already responded, discarding.", {
        code: "rsvp_reminder.already_responded",
        accountId, signalId, arcId, veventUid,
      });
      return ok(undefined);
    }

    // 5. Fetch arc for notification
    const arcResult = await this.arcDb.getArc(accountId, arcId);
    if (arcResult.isErr()) return err(arcResult.error);

    const arc = arcResult.value;
    if (!arc) {
      this.logger.track("RSVP reminder: arc not found, discarding.", {
        code: "rsvp_reminder.arc_missing",
        accountId, signalId, arcId,
      });
      return ok(undefined);
    }

    // 6. Notify — user has not responded and event is upcoming
    const reason: NotificationReason = "rsvp_reminder";
    return this.notifier.notify(accountId, arc, signal, arc.urgency ?? "normal", reason);
  }
}
