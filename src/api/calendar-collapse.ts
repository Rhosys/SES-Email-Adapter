/**
 * Read-time collapse of a thread's calendar_event signals into one card per event.
 *
 * A single real-world event produces multiple stored calendar_event signals over its
 * lifetime: the original invite (METHOD:REQUEST, SEQUENCE 0), zero or more updates
 * (METHOD:REQUEST, SEQUENCE > 0), and possibly a cancellation (METHOD:CANCEL). They all
 * share a veventUid. The client should see ONE card that reflects the latest state, with
 * a cancellation badge or previous->current diff as appropriate — never one card per
 * stored signal.
 *
 * This module is a pure function over the internal signals (which still carry method /
 * sequence / status / veventUid). The API transform layer strips those fields, so the
 * derivation must happen here, before toApiSignal, and the result is attached to the
 * winning signal's API DTO by the caller.
 */
import type { Signal } from "../types/index.js";
import type { CalendarEventData } from "../types/calendar.js";

// The changed-field snapshot the client renders as "previous -> current" arrows. Only the
// fields that actually differ from the prior invite are present. `changedAt` is when the
// updating invite arrived (the winning signal's createdAt).
export interface CalendarPreviousValues {
  changedAt: string;
  title?: string;
  description?: string;
  startTime?: string;
  endTime?: string;
  location?: string;
}

// Fields the client displays and therefore diffs across an update. organizer/attendees are
// deliberately excluded — an organizer change is effectively a new event, and attendee
// churn is noise for a "what changed" summary.
const DIFFED_FIELDS = ["title", "description", "startTime", "endTime", "location"] as const;

export interface CalendarEnrichment {
  cancelledAt?: string;
  previousValues?: CalendarPreviousValues;
}

export interface CalendarCollapseResult {
  // The signal id chosen to represent each event group (the latest snapshot). Only these
  // calendar_event signals are emitted; the rest are superseded.
  winners: Map<string, CalendarEnrichment>;
  // calendar_event signal ids that lost to a winner in their group and must be dropped.
  superseded: Set<string>;
  // An update/cancellation whose group has no earlier snapshot to diff against — the caller
  // logs a TRACK for each, since it means correlation data is missing from the loaded set.
  orphans: OrphanReport[];
}

export interface OrphanReport {
  veventUid: string;
  signalId: string;
  method: string;
  sequence: number;
  reason: "update_without_prior" | "cancellation_without_prior";
}

// Order within an event group: higher SEQUENCE wins; ties broken by createdAt. A CANCEL and
// an update may share a sequence, so createdAt is the final arbiter of "latest state".
function orderInGroup(a: Signal<CalendarEventData>, b: Signal<CalendarEventData>): number {
  if (a.data.sequence !== b.data.sequence) return a.data.sequence - b.data.sequence;
  return a.createdAt.localeCompare(b.createdAt);
}

function diffPreviousValues(
  prior: CalendarEventData,
  current: CalendarEventData,
  changedAt: string,
): CalendarPreviousValues | undefined {
  const previous: CalendarPreviousValues = { changedAt };
  let changed = false;
  for (const field of DIFFED_FIELDS) {
    const priorValue = prior[field];
    if (priorValue !== undefined && priorValue !== current[field]) {
      previous[field] = priorValue;
      changed = true;
    }
  }
  return changed ? previous : undefined;
}

/**
 * Collapse the calendar_event signals of a single thread into one winner per veventUid.
 *
 * `calendarSignals` must be exactly the thread's calendar_event signals (already filtered).
 * The caller supplies the full loaded set; anything not in a group is left untouched.
 */
export function collapseCalendarSignals(calendarSignals: Signal<CalendarEventData>[]): CalendarCollapseResult {
  const groups = new Map<string, Signal<CalendarEventData>[]>();
  for (const signal of calendarSignals) {
    const group = groups.get(signal.data.veventUid);
    if (group) {
      group.push(signal);
      continue;
    }
    groups.set(signal.data.veventUid, [signal]);
  }

  const winners = new Map<string, CalendarEnrichment>();
  const superseded = new Set<string>();
  const orphans: OrphanReport[] = [];

  for (const [veventUid, group] of groups) {
    const ordered = [...group].sort(orderInGroup);
    const winner = ordered[ordered.length - 1]!;
    const prior = ordered.length > 1 ? ordered[ordered.length - 2]! : undefined;

    for (const signal of ordered) {
      if (signal.id !== winner.id) superseded.add(signal.id);
    }

    const enrichment: CalendarEnrichment = {};

    // Cancellation: any CANCEL in the group cancels the event. Use the latest CANCEL's
    // createdAt as cancelledAt; the winner keeps its display fields so the client can
    // strike them through rather than blank them.
    const latestCancel = ordered.filter(s => s.data.method === "CANCEL").pop();
    if (latestCancel) {
      enrichment.cancelledAt = latestCancel.createdAt;
      if (!prior) {
        orphans.push({
          veventUid, signalId: winner.id, method: winner.data.method, sequence: winner.data.sequence,
          reason: "cancellation_without_prior",
        });
      }
    }

    // Update diff: only when the winner is an update (sequence > 0) and not a cancellation.
    // A prior snapshot in the loaded set is required to compute the diff; its absence is an
    // orphan (best-effort: emit the current values with no arrows).
    if (!latestCancel && winner.data.sequence > 0) {
      if (prior) {
        const previousValues = diffPreviousValues(prior.data, winner.data, winner.createdAt);
        if (previousValues) enrichment.previousValues = previousValues;
      } else {
        orphans.push({
          veventUid, signalId: winner.id, method: winner.data.method, sequence: winner.data.sequence,
          reason: "update_without_prior",
        });
      }
    }

    winners.set(winner.id, enrichment);
  }

  return { winners, superseded, orphans };
}
