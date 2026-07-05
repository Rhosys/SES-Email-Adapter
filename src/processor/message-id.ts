const GSI3_PREFIX = 'ACCT#'
const MSGID_SEPARATOR = '#MSGID#'
const MAX_GSI3PK_LENGTH = 1024

/** Extract msg-id from a raw Message-ID header value (strip angle brackets). */
export function extractMsgId(raw: string): string | null {
  const match = raw.match(/<([^>]+)>/)
  if (match?.[1]) return match[1]
  const trimmed = raw.trim()
  return trimmed || null
}

/** Construct GSI3 partition key for signals: ACCT#{accountId}#MSGID#{msgId}, truncated to 1024 chars. */
export function buildSignalGsi3pk(accountId: string, msgId: string): string {
  const key = `${GSI3_PREFIX}${accountId}${MSGID_SEPARATOR}${msgId}`
  return key.slice(0, MAX_GSI3PK_LENGTH)
}

/** Build the outbound Message-ID that SES assigns. */
export function buildOutboundMsgId(sesMessageId: string, sesRegion: string): string {
  return `${sesMessageId}@${sesRegion}.amazonses.com`
}

/** Extract the first msg-id from an In-Reply-To header (content of first <...> pair). */
export function extractFirstInReplyTo(headerValue: string): string | null {
  const match = headerValue.match(/<([^>]+)>/)
  return match?.[1] ?? null
}
