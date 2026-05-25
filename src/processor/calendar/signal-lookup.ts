/**
 * Constructs the signalLookupId for calendar signals.
 *
 * Format: "cal-{organizerEmail}-{veventUid}"
 *
 * This serves as the DynamoDB PK component, enabling O(1) event state lookup
 * and coexistence of REQUEST/CANCEL/RESCHEDULE under the same PK with distinct SKs.
 */
export function buildCalendarSignalLookupId(organizerEmail: string, veventUid: string): string {
  return `cal-${organizerEmail}-${veventUid}`;
}
