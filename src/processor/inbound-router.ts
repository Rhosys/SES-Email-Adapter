// ---------------------------------------------------------------------------
// Inbound routing decision — which processor owns a message, decided purely from
// its recipient address before any I/O.
//
// A calendar RSVP reply comes back to {threadId}@{accountId}.{serviceDomain} — the
// proxy-organizer address CalendarForwarder stamps on every forwarded invite. That
// shape is distinct from every real alias (which lives at a customer domain, not a
// per-account subdomain of the platform service domain), so a cheap self-consistency
// check on the localpart and subdomain is enough to route. It is NOT a security
// gate: the address is public (it rides on the envelope of every forwarded invite),
// so the actual trust check is the proxy-UID HMAC inside the .ics, enforced later.
// ---------------------------------------------------------------------------

import { validateId, validateAccountId } from "../utils/id.js";

/**
 * True when `address` matches the calendar-RSVP reply shape
 * `{thr-id}@{acc-id}.{serviceDomain}` with both ids passing their checksums.
 */
export function isRsvpReplyAddress(address: string, serviceDomain: string): boolean {
  const atIndex = address.indexOf("@");
  if (atIndex === -1) return false;

  const localPart = address.slice(0, atIndex);
  const domainPart = address.slice(atIndex + 1);

  const suffix = `.${serviceDomain}`;
  if (!domainPart.endsWith(suffix)) return false;

  const accountId = domainPart.slice(0, domainPart.length - suffix.length);
  if (!accountId || !validateAccountId(accountId)) return false;

  return validateId(localPart, "thr-");
}
