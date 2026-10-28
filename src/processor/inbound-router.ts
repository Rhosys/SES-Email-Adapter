// ---------------------------------------------------------------------------
// Inbound routing decision — which processor owns a message, decided purely from
// its recipient address before any I/O.
//
// A calendar RSVP reply comes back to {aliasLocalPart}@{accountId}.{serviceDomain} — the
// proxy-organizer address CalendarForwarder stamps on every forwarded invite. That
// per-account subdomain of the platform service domain is distinct from every real
// alias (which lives at a customer domain), so the domain alone is enough to route.
// The local part is ignored: calendars may lowercase it, and identity never came from
// it. It is NOT a security gate: the address is public (it rides on every forwarded
// invite), so the actual trust check is the proxy-UID HMAC inside the .ics, enforced later.
// ---------------------------------------------------------------------------

import { validateAccountId } from "../utils/id.js";

/**
 * True when `address` is at the calendar-RSVP reply domain `{acc-id}.{serviceDomain}`
 * (case-insensitive) with the account id passing its checksum.
 */
export function isRsvpReplyAddress(address: string, serviceDomain: string): boolean {
  const atIndex = address.lastIndexOf("@");
  if (atIndex <= 0) return false;

  const domainPart = address.slice(atIndex + 1).toLowerCase();
  const suffix = `.${serviceDomain.toLowerCase()}`;
  if (!domainPart.endsWith(suffix)) return false;

  const accountId = domainPart.slice(0, domainPart.length - suffix.length);
  return validateAccountId(accountId);
}
