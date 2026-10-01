import type { AnySignal, Signal } from "./index.js";

// ---------------------------------------------------------------------------
// Calendar signal data interfaces
// ---------------------------------------------------------------------------

export interface CalendarAttendee {
  address: string;
  cn?: string;
  partstat?: string;
  role?: string;
}

export interface CalendarEventData {
  title: string;
  description?: string;
  startTime: string;
  endTime?: string;
  location?: string;
  url?: string;
  organizer: string;
  organizerCn?: string;
  attendees: CalendarAttendee[];
  veventUid: string;
  method: string;
  sequence: number;
  status?: string;
  transparency?: string;
  created?: string;
  lastModified?: string;
  recurrenceRule?: string;
  recurrenceId?: string;
  xProperties?: Record<string, string>;
  proxyUid?: string;
  originalVeventUid: string;
  linkedSignalId: string;
  /** The account's latest RSVP to this event, from the dashboard or a native calendar reply. */
  rsvpResponse?: CalendarRsvpResponse;
  /**
   * SES messageId of the most recent RSVP reply relayed to the organizer. A bounce of that reply
   * comes back as an inbound DSN whose In-Reply-To is this id (formatted as an amazonses.com
   * Message-ID); the row's gsi3pk is keyed on that same value so the DSN resolves here in one
   * lookup instead of being misclassified as untrusted inbound mail. Last-send-wins — a resent
   * RSVP (accept → decline) overwrites it; a late bounce of a superseded send still resolves to
   * this event via gsi3pk, which is all the inbound DSN handler needs to recognise it as ours.
   */
  sesMessageId?: string;
}

export interface CalendarRsvpResponse {
  decision: "accepted" | "declined" | "tentative";
  respondedAt: string;
}

export interface CalendarInviteInvalidData {
  reason: string;
  linkedSignalId: string;
}

export interface DomainMisconfigurationData {
  reason: string;
  linkedSignalId: string;
  aliasAddress: string;
  domain: string;
}

// ---------------------------------------------------------------------------
// Calendar signal type guards
// ---------------------------------------------------------------------------

export function isCalendarEventSignal(signal: AnySignal): signal is Signal<CalendarEventData> {
  return signal.type === "calendar_event";
}

export function isCalendarInviteInvalidSignal(signal: AnySignal): signal is Signal<CalendarInviteInvalidData> {
  return signal.type === "calendar_invite_invalid";
}

export function isDomainMisconfigurationSignal(signal: AnySignal): signal is Signal<DomainMisconfigurationData> {
  return signal.type === "domain_misconfiguration";
}
