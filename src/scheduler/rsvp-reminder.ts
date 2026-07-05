/** Hours before event start to fire the RSVP reminder. */
export const RSVP_REMINDER_HOURS_BEFORE = 24;

export interface RsvpReminderMessage {
  accountId: string;
  signalId: string;
  threadId: string;
}
