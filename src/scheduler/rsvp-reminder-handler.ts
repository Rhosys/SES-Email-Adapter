import { DateTime } from "luxon";

import { ok, err } from "../errors.js";
import type { Result, DbError } from "../errors.js";
import type { AnySignal, Signal, Thread } from "../types/index.js";
import type { CalendarResponseData } from "../types/calendar.js";
import { isCalendarEventSignal } from "../types/calendar.js";
import type { Notifier, NotificationReason } from "../notifier/types.js";
import type { Logger } from "../logger.js";
import type { RsvpReminderMessage } from "./rsvp-reminder.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface IRsvpReminderThreadDb {
  getSignalById(accountId: string, signalId: string, threadId: string): Promise<Result<AnySignal | null, DbError>>;
  getLatestCalendarResponse(accountId: string, threadId: string, veventUid: string): Promise<Result<Signal<CalendarResponseData> | null, DbError>>;
  getThread(accountId: string, threadId: string): Promise<Result<Thread | null, DbError>>;
}

export class RsvpReminderHandler {
  private readonly threadDb: IRsvpReminderThreadDb;
  private readonly notifier: Notifier;
  private readonly logger: Logger;

  constructor(deps: {
    threadDb: IRsvpReminderThreadDb;
    notifier: Notifier;
    logger: Logger;
  }) {
    this.threadDb = deps.threadDb;
    this.notifier = deps.notifier;
    this.logger = deps.logger;
  }

  async process(message: RsvpReminderMessage): Promise<Result<void, DbError>> {
    const { accountId, calendarSignalId, threadId } = message;
    this.logger.info("RSVP reminder: processing", { code: "rsvp_reminder.start", accountId, calendarSignalId, threadId });

    // 1. Fetch signal
    const signalResult = await this.threadDb.getSignalById(accountId, calendarSignalId, threadId);
    if (signalResult.isErr()) return err(signalResult.error);

    const signal = signalResult.value;
    if (!signal) {
      // We scheduled this reminder against a calendar_event signal we wrote — its absence is a
      // data-integrity fault (bad write, premature TTL, wrong id), not a benign stale-fire.
      this.logger.error("RSVP reminder: scheduled calendar signal not found in database, discarding.", {
        code: "rsvp_reminder.signal_missing",
        accountId, calendarSignalId, threadId,
      });
      return ok(undefined);
    }

    // 2. Extract startTime and veventUid. The reminder was scheduled against a calendar_event
    // signal, so a row of any other type is a data-integrity fault (bad write, TTL, wrong id) —
    // discard after logging, same as the missing-signal case.
    if (!isCalendarEventSignal(signal)) {
      this.logger.error("RSVP reminder: scheduled signal is not a calendar event, discarding.", {
        code: "rsvp_reminder.signal_wrong_type",
        accountId, calendarSignalId, threadId, signalType: signal.type,
      });
      return ok(undefined);
    }
    const { veventUid, startTime } = signal.data;

    // 3. Check if event has passed
    const eventStart = DateTime.fromISO(startTime, { zone: "utc" });
    if (!eventStart.isValid || eventStart <= DateTime.utc()) {
      this.logger.track("RSVP reminder: event has passed, discarding.", {
        code: "rsvp_reminder.event_passed",
        signal, startTime,
      });
      return ok(undefined);
    }

    // 4. Check if user has already responded
    const responseResult = await this.threadDb.getLatestCalendarResponse(accountId, threadId, veventUid);
    if (responseResult.isErr()) return err(responseResult.error);

    if (responseResult.value) {
      this.logger.track("RSVP reminder: user already responded, discarding.", {
        code: "rsvp_reminder.already_responded",
        signal, veventUid,
      });
      return ok(undefined);
    }

    // 5. Fetch thread for notification
    const threadResult = await this.threadDb.getThread(accountId, threadId);
    if (threadResult.isErr()) return err(threadResult.error);

    const thread = threadResult.value;
    if (!thread) {
      this.logger.track("RSVP reminder: thread not found, discarding.", {
        code: "rsvp_reminder.thread_missing",
        signal,
        accountId, calendarSignalId, threadId,
      });
      return ok(undefined);
    }

    // 6. Notify — user has not responded and event is upcoming
    const reason: NotificationReason = "rsvp_reminder";
    return this.notifier.notifyThread(accountId, thread, thread.urgency ?? "normal", reason);
  }
}
