/**
 * Computes the undo window (in seconds) for a draft send based on email body length.
 *
 * This duration serves as both:
 * - The SQS DelaySeconds on the draft_send message (the message won't reach the
 *   DraftSendWorker until this delay elapses)
 * - The value used to compute undoExpiresAt (now + windowSeconds), which the frontend
 *   uses to show a countdown. If the user PATCHes the signal back to "draft" before
 *   undoExpiresAt, the SQS message fires but the worker discards it (status mismatch).
 *
 * Longer emails get longer windows because they're more likely to contain mistakes
 * the user notices after hitting send.
 */
export function computeUndoWindowSeconds(textBody: string | undefined): number {
  const wordCount = textBody?.trim().split(/\s+/).filter(Boolean).length ?? 0;
  if (wordCount < 50) return 10;
  if (wordCount < 200) return 60;
  if (wordCount < 500) return 180;
  return 300;
}
