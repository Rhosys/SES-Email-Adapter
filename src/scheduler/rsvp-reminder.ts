/** Hours before event start to fire the RSVP reminder. */
export const RSVP_REMINDER_HOURS_BEFORE = 24;

export interface RsvpReminderMessage {
  messageType: "rsvp_reminder";
  accountId: string;
  threadId: string;
  /** The calendar_event signal (one veventUid) this reminder is for — never the incoming-email signal. */
  calendarSignalId: string;
}
