/** Centralised tag prefix — single source of truth for the codename namespace. */
export const TAG_PREFIX = "X-Numaeel-";

/** Pre-built tag name constants for use in feedback processing. */
export const TAG_TYPE = `${TAG_PREFIX}Type`;
export const TAG_ACCOUNT_ID = `${TAG_PREFIX}AccountId`;
export const TAG_SIGNAL_ID = `${TAG_PREFIX}SignalId`;
export const TAG_THREAD_ID = `${TAG_PREFIX}ThreadId`;
/** Groups emails by send purpose (healthcheck, verification, onboarding, etc.). */
export const TAG_PURPOSE = `${TAG_PREFIX}Purpose`;
/** Correlates a daily healthcheck email with any SES bounce/complaint we later receive for it. */
export const TAG_HEALTHCHECK_ID = `${TAG_PREFIX}Healthcheck-Id`;
/**
 * Mail-loop guard (RFC 3834 §5 rate-limiting spirit, applied generically): carries how many
 * times a message has been auto-replied-to/forwarded through the platform. Incremented by
 * ReplySenderService on every send; a value that would exceed MAX_HOP_COUNT refuses the send
 * outright rather than perpetuating a loop between two systems that keep answering each other.
 */
export const TAG_HOP_COUNT = `${TAG_PREFIX}Hop-Count`;
export const MAX_HOP_COUNT = 100;

/** Parses the hop-count header off an inbound message's headers map; missing/malformed reads as no prior hop. */
export function parseHopCount(headers: Record<string, string>): number | undefined {
  const value = headers[TAG_HOP_COUNT.toLowerCase()];
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}



export interface TagContext {
  accountId?: string | undefined;
  signalId?: string | undefined;
  threadId?: string | undefined;
}

export type OutboundType = "reply" | "forward" | "draft-send";

/**
 * The exhaustive set of outbound-email kinds this service sends. Carried on every SES send as the
 * TAG_TYPE message tag so a later bounce/complaint is always attributable — a send can never fall
 * through to the "unknown" process again. Required at the EmailService boundary; adding a new send
 * kind is a compile error until it is added here and classified in systemResponsibleForBounces.
 */
export type EmailSendType =
  | "healthcheck"
  | "digest"
  | "onboarding"
  | "account-invite"
  | "forward-verification"
  | "forward"
  | "reply"
  | "pong"
  | "draft-send"
  | "calendar-forward"
  | "calendar-rsvp";

const EMAIL_SEND_TYPES: readonly EmailSendType[] = [
  "healthcheck", "digest", "onboarding", "account-invite", "forward-verification",
  "forward", "reply", "pong", "draft-send", "calendar-forward", "calendar-rsvp",
];

/** Narrows an arbitrary tag value to a known EmailSendType. */
export function isEmailSendType(value: string): value is EmailSendType {
  return (EMAIL_SEND_TYPES as readonly string[]).includes(value);
}

/**
 * Whether WE are responsible for a bounce/complaint on a send of this kind. True for mail we
 * originate or send under our own platform identity — a bounce there means our own pipeline is
 * failing, so it is logged at error level. False for mail carrying a user's content to a third
 * party, where a recipient bounce is normal deliverability and stays at track level.
 */
export function systemResponsibleForBounces(type: EmailSendType): boolean {
  switch (type) {
    case "healthcheck":
    case "digest":
    case "onboarding":
    case "account-invite":
    case "forward-verification":
    case "pong":
    case "calendar-forward":
      return true;
    case "forward":
    case "reply":
    case "draft-send":
    case "calendar-rsvp":
      return false;
  }
}

/**
 * Build the full set of SES message tags for an outbound email.
 * Omits correlation tags whose values are empty/undefined.
 */
export function buildOutboundTags(
  type: OutboundType,
  context?: TagContext,
): Array<{ Name: string; Value: string }> {
  const tags: Array<{ Name: string; Value: string }> = [
    { Name: TAG_TYPE, Value: type },
  ];

  if (context?.accountId) {
    tags.push({ Name: TAG_ACCOUNT_ID, Value: context.accountId });
  }
  if (context?.signalId) {
    tags.push({ Name: TAG_SIGNAL_ID, Value: context.signalId });
  }
  if (context?.threadId) {
    tags.push({ Name: TAG_THREAD_ID, Value: context.threadId });
  }

  return tags;
}
