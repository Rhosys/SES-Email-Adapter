/**
 * Constructs the signalLookupId for calendar signals.
 *
 * Format: "cal-{organizerEmail}-{veventUid}", or "cal-{organizerEmail}-{veventUid}-{recurrenceId}"
 * for a RECURRENCE-ID occurrence exception, which is a distinct event from its master
 * series and must not overwrite the master's stored signal at the same PK.
 *
 * This serves as the DynamoDB PK component, enabling O(1) event state lookup
 * and coexistence of REQUEST/CANCEL/RESCHEDULE under the same PK with distinct SKs.
 */
export function buildCalendarSignalLookupId(organizerEmail: string, veventUid: string, recurrenceId?: string): string {
  return `cal-${organizerEmail}-${veventUid}${recurrenceId ? `-${recurrenceId}` : ""}`;
}
