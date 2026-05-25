import type { Signal } from "../types/index.js";
import { getETLD1 } from "./filter.js";

export interface ReplyTargetResult {
  safe: boolean;
  reason?: string;
}

// Determines whether a signal's Reply-To target is safe for auto-send.
// Safe when: no replyTo present, replyTo eTLD+1 matches from eTLD+1, or replyTo eTLD+1 is in approvedDomains.
export function isReplyTargetSafe(signal: Signal, approvedDomains: string[]): ReplyTargetResult {
  if (!signal.data.replyTo) return { safe: true };

  const replyToETLD1 = getETLD1(signal.data.replyTo.address);
  const fromETLD1 = getETLD1(signal.data.from.address);

  if (replyToETLD1 === fromETLD1) return { safe: true };
  if (approvedDomains.includes(replyToETLD1)) return { safe: true };

  return {
    safe: false,
    reason: `Reply-To ${signal.data.replyTo.address} (${replyToETLD1}) does not match From ${signal.data.from.address} (${fromETLD1}) and is not in approved senders`,
  };
}
