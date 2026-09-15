// recordRsvpResponse — the single writer of a calendar_response signal.
//
// Two entry points record an RSVP: the dashboard API (the user clicks Accept/Decline) and the
// inbound-REPLY relay (the user's native calendar client replied to our proxy address). They do
// different pre-work (auth/alias/domain vs. S3 fetch/HMAC) and both send via
// CalendarForwarder.sendRsvpToOrganizer — then both must persist the SAME record. Centralising the
// write here keeps the two paths from drifting (they previously disagreed on linkedSignalId and
// duplicated the signal shape).
//
// The record is append-only history: every RSVP is a fresh signal, never an update. "Latest"
// is resolved at read time by max(respondedAt) per veventUid (see getLatestCalendarResponse), so
// a re-RSVP supersedes deterministically by wall-clock, independent of signal-id ordering.
//
// linkedSignalId is the collapsed WINNER calendar_event id — the event's current state, which is
// exactly what the reply responded to — the same value from both callers.

import { ok, err } from "../../errors.js";
import type { DbError, Result } from "../../errors.js";
import type { Signal, CalendarResponseData } from "../../types/index.js";

export interface RsvpResponseStore {
  saveSignal(signal: Signal<CalendarResponseData>): Promise<Result<void, DbError>>;
}

export interface RecordRsvpResponseOpts {
  store: RsvpResponseStore;
  accountId: string;
  threadId: string;
  /** The event's UID (originalVeventUid) — the grouping key for the RSVP history of this event. */
  veventUid: string;
  decision: "accepted" | "declined" | "tentative";
  /** The collapsed winning calendar_event signal id — the event's current state we responded to. */
  winnerSignalId: string;
  /** Wall-clock time of the response; the read-side tiebreaker for latest-wins. Injectable for tests. */
  now: string;
  /** Signal-id generator; injectable for tests. */
  generateId: () => string;
}

export async function recordRsvpResponse(opts: RecordRsvpResponseOpts): Promise<Result<Signal<CalendarResponseData>, DbError>> {
  const { store, accountId, threadId, veventUid, decision, winnerSignalId, now, generateId } = opts;

  const signalId = generateId();
  const responseSignal: Signal<CalendarResponseData> = {
    id: signalId,
    signalLookupId: signalId,
    threadId,
    accountId,
    source: "user",
    type: "calendar_response",
    status: "active",
    labels: [],
    createdAt: now,
    data: {
      decision,
      respondedAt: now,
      veventUid,
      linkedSignalId: winnerSignalId,
      sendStatus: "sent",
    },
  };

  const saveResult = await store.saveSignal(responseSignal);
  if (saveResult.isErr()) return err(saveResult.error);
  return ok(responseSignal);
}
