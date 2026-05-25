import ICAL from "ical.js";
import type { CalendarEventData } from "../../types/calendar.js";

/**
 * Parse an ISO 8601 date-time string into an ICAL.Time in UTC.
 * Handles both "2025-03-15T10:00:00Z" and "2025-03-15T10:00:00" formats.
 */
function isoToIcalTime(iso: string): InstanceType<typeof ICAL.Time> {
  const date = new Date(iso);
  return ICAL.Time.fromJSDate(date, true);
}

/**
 * Construct a forwarding `.ics` with proxy UID, proxy ORGANIZER, and the user's
 * calendarForwardingAddress as the sole ATTENDEE.
 *
 * Construction rules:
 * - UID: proxyUid
 * - ORGANIZER: proxyOrganizer with CN from organizerCn
 * - ATTENDEE: mailto:{attendeeAddress} with PARTSTAT=NEEDS-ACTION;RSVP=TRUE
 * - Preserves: SEQUENCE, DTSTART, DTEND, SUMMARY, LOCATION, DESCRIPTION, STATUS, METHOD
 * - Strips: all VALARM components (none are added)
 */
export function buildForwardIcs(opts: {
  calendarData: CalendarEventData;
  proxyUid: string;
  proxyOrganizer: string;
  organizerCn: string;
  attendeeAddress: string;
}): string {
  const { calendarData, proxyUid, proxyOrganizer, organizerCn, attendeeAddress } = opts;

  const cal = new ICAL.Component("vcalendar");
  cal.addPropertyWithValue("version", "2.0");
  cal.addPropertyWithValue("prodid", "-//Numaeel//Calendar Proxy//EN");
  cal.addPropertyWithValue("method", calendarData.method);

  const vevent = new ICAL.Component("vevent");

  // UID — proxy UID
  vevent.addPropertyWithValue("uid", proxyUid);

  // SEQUENCE
  vevent.addPropertyWithValue("sequence", calendarData.sequence);

  // DTSTART
  const dtstart = new ICAL.Property("dtstart");
  dtstart.setValue(isoToIcalTime(calendarData.startTime));
  vevent.addProperty(dtstart);

  // DTEND (optional)
  if (calendarData.endTime !== undefined) {
    const dtend = new ICAL.Property("dtend");
    dtend.setValue(isoToIcalTime(calendarData.endTime));
    vevent.addProperty(dtend);
  }

  // SUMMARY
  vevent.addPropertyWithValue("summary", calendarData.title);

  // LOCATION (optional)
  if (calendarData.location !== undefined) {
    vevent.addPropertyWithValue("location", calendarData.location);
  }

  // DESCRIPTION (optional)
  if (calendarData.description !== undefined) {
    vevent.addPropertyWithValue("description", calendarData.description);
  }

  // STATUS (optional)
  if (calendarData.status !== undefined) {
    vevent.addPropertyWithValue("status", calendarData.status);
  }

  // DTSTAMP (required by RFC 5545)
  const dtstamp = new ICAL.Property("dtstamp");
  dtstamp.setValue(ICAL.Time.fromJSDate(new Date(), true));
  vevent.addProperty(dtstamp);

  // ORGANIZER with CN
  const organizer = new ICAL.Property("organizer");
  organizer.setValue(proxyOrganizer);
  organizer.setParameter("cn", organizerCn);
  vevent.addProperty(organizer);

  // ATTENDEE
  const attendee = new ICAL.Property("attendee");
  attendee.setValue(`mailto:${attendeeAddress}`);
  attendee.setParameter("partstat", "NEEDS-ACTION");
  attendee.setParameter("rsvp", "TRUE");
  vevent.addProperty(attendee);

  cal.addSubcomponent(vevent);

  return cal.toString();
}

/**
 * Construct a METHOD:REPLY `.ics` for sending an RSVP back to the organizer.
 *
 * Construction rules:
 * - METHOD: REPLY
 * - UID: veventUid (original, NOT proxy)
 * - ATTENDEE: mailto:{attendeeAddress} with PARTSTAT matching decision
 * - SEQUENCE: from opts
 * - ORGANIZER: organizerAddress
 */
export function buildReplyIcs(opts: {
  veventUid: string;
  sequence: number;
  attendeeAddress: string;
  decision: "ACCEPTED" | "DECLINED" | "TENTATIVE";
  organizerAddress: string;
}): string {
  const { veventUid, sequence, attendeeAddress, decision, organizerAddress } = opts;

  const cal = new ICAL.Component("vcalendar");
  cal.addPropertyWithValue("version", "2.0");
  cal.addPropertyWithValue("prodid", "-//Numaeel//Calendar Proxy//EN");
  cal.addPropertyWithValue("method", "REPLY");

  const vevent = new ICAL.Component("vevent");

  // UID — original VEVENT UID, not proxy
  vevent.addPropertyWithValue("uid", veventUid);

  // SEQUENCE
  vevent.addPropertyWithValue("sequence", sequence);

  // DTSTAMP (required by RFC 5545)
  const dtstamp = new ICAL.Property("dtstamp");
  dtstamp.setValue(ICAL.Time.fromJSDate(new Date(), true));
  vevent.addProperty(dtstamp);

  // ORGANIZER
  const organizer = new ICAL.Property("organizer");
  organizer.setValue(`mailto:${organizerAddress}`);
  vevent.addProperty(organizer);

  // ATTENDEE with PARTSTAT
  const attendee = new ICAL.Property("attendee");
  attendee.setValue(`mailto:${attendeeAddress}`);
  attendee.setParameter("partstat", decision);
  vevent.addProperty(attendee);

  cal.addSubcomponent(vevent);

  return cal.toString();
}
