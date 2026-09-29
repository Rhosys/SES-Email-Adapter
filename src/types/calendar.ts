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
