import { DateTime } from "luxon";
import type { AnySignal, DeliverabilitySignalData, Signal, SuppressionReason } from "../types/index.js";
import type { ProcessingDatabase } from "../database/processing-database.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { DbError, Result } from "../errors.js";
import { ok, err } from "../errors.js";
import type { Logger } from "../logger.js";
import { generateId } from "../utils/id.js";
import { buildBounceSuppressionEntry } from "./bounce-suppression.js";

export interface BounceSignalStore {
  saveSignal(signal: AnySignal): Promise<Result<void, DbError>>;
  updateSignalSendStatus(accountId: string, signalLookupId: string, update: {
    status: "pending_send" | "sent" | "draft";
    sendInitiatedAt?: string | null;
    sentAt?: string;
    sesMessageId?: string;
    sendFailureReason?: string;
  }): Promise<Result<Signal, DbError>>;
}

/** One bounced recipient, normalised across the SES-feedback and inbound-DSN channels. */
export interface BouncedRecipient {
  address: string;
  bounceType: "permanent" | "transient";
  reason?: string;
}

/**
 * The send a bounce is attributable to. Present when the bounce resolved to one of our own sends
 * (via SES tags on the feedback channel, or the gsi3 Message-ID index on the inbound-DSN channel);
 * absent when the bounce could not be tied back to a send, in which case the recipient is still
 * suppressed but no deliverability signal is surfaced.
 */
export interface LinkedSend {
  linkedSignalId: string;
  signalLookupId: string;
  threadId?: string;
}

export interface HandleBounceParams {
  accountId: string;
  bouncedRecipients: BouncedRecipient[];
  isPermanent: boolean;
  /** How to describe the bounce in the log, and whether a failure here is our own pipeline's fault. */
  description: { sendType: string; systemResponsible: boolean };
  /** Human-readable log context — the from address and messageId of the bounced send. */
  logContext: { from: string; messageId: string; kind: string };
  suppressionReason: SuppressionReason;
  /**
   * The send this bounce belongs to, when known. Drives the user-facing deliverability signal.
   * A calendar-rsvp bounce is deliberately passed without this so the recipient is suppressed but
   * nothing surfaces to the user — the RSVP is machine traffic, not something the user composed.
   */
  linkedSend?: LinkedSend;
  /** Caller-computed: revert the linked draft to "draft" because every recipient permanently bounced. */
  revertToDraft: boolean;
  /** Caller-computed: disable forward rules targeting the bounced addresses (permanent forward bounces only). */
  disableForwardingRules: boolean;
  /** The raw channel payload (SES feedback event or DSN info) attached to logs and the suppression entry. */
  feedback: unknown;
}

/**
 * The consequence of a bounced recipient, shared by every bounce source (SES send-time feedback and
 * out-of-band DSNs that arrive as inbound mail). Owns the full outcome so the two channels cannot
 * drift: log at the right severity, suppress each failed address so we stop sending into a dead
 * target, optionally disable forward rules, optionally surface a user-facing deliverability signal,
 * and optionally revert a fully-bounced draft. Channel-specific inputs (send-type, whether to disable
 * forwarding, whether to revert) are computed by the caller — this class executes, never guesses.
 */
export class BounceHandler {
  private readonly signalStore: BounceSignalStore;
  private readonly processingDb: ProcessingDatabase;
  private readonly accountDb: AccountDatabase;
  private readonly logger: Logger;

  constructor(signalStore: BounceSignalStore, processingDb: ProcessingDatabase, accountDb: AccountDatabase, logger: Logger) {
    this.signalStore = signalStore;
    this.processingDb = processingDb;
    this.accountDb = accountDb;
    this.logger = logger;
  }

  async handleBounce(params: HandleBounceParams): Promise<Result<void, DbError>> {
    const { accountId, bouncedRecipients, isPermanent, description, logContext, suppressionReason, linkedSend, revertToDraft, disableForwardingRules, feedback } = params;

    const recipientList = bouncedRecipients.map(r => r.address).join(", ") || "(none)";
    if (description.systemResponsible) {
      this.logger.error(`SES ${logContext.kind} bounce on a ${description.sendType} send — a system email we send (from ${logContext.from}, messageId ${logContext.messageId}) failed delivery to ${recipientList}.`, { code: "feedback.system_bounce", feedback });
    } else {
      this.logger.track(`SES ${logContext.kind} bounce on a ${description.sendType} send — email from ${logContext.from} (messageId ${logContext.messageId}) bounced for ${recipientList}.`, { code: "feedback.bounce", feedback });
    }

    for (const recipient of bouncedRecipients) {
      const suppressResult = await this.processingDb.suppressAddress(buildBounceSuppressionEntry({
        address: recipient.address,
        isPermanent,
        reason: suppressionReason,
        feedback,
        sesMessageId: logContext.messageId,
        ...(linkedSend ? { linkedSignalId: linkedSend.linkedSignalId } : {}),
      }));
      if (suppressResult.isErr()) return err(suppressResult.error);

      if (!isPermanent && suppressResult.value.bounceCount > 2) {
        this.logger.error("Address has bounced transiently more than 2 times in 7 days — investigate.", { code: "feedback.repeated_transient_bounce", address: recipient.address, bounceCount: suppressResult.value.bounceCount, feedback });
      }
    }

    if (disableForwardingRules && isPermanent) {
      for (const recipient of bouncedRecipients) {
        const disableResult = await this.accountDb.disableRulesForwardingTo(accountId, recipient.address);
        if (disableResult.isErr()) {
          this.logger.track(`Failed to disable rules forwarding to bounced address. The DynamoDB update returned an error. Emails may continue to be forwarded to the bouncing address: ${disableResult.error.message}`, { code: "feedback.disable_forward_failed", accountId, address: recipient.address, error: disableResult.error });
          continue;
        }
        for (const ruleId of disableResult.value) {
          this.logger.track("Rule disabled due to permanent forward bounce", { code: "feedback.rule_disabled_on_bounce", accountId, ruleId, bouncedAddress: recipient.address });
        }
      }
    }

    if (!linkedSend) return ok(undefined);

    const id = generateId("sgn-");
    const deliverabilitySignal: Signal<DeliverabilitySignalData> = {
      id,
      signalLookupId: id,
      ...(linkedSend.threadId ? { threadId: linkedSend.threadId } : {}),
      accountId,
      source: "ses_feedback",
      type: "deliverability",
      status: "active",
      labels: [],
      createdAt: DateTime.utc().toISO()!,
      data: {
        linkedSignalId: linkedSend.linkedSignalId,
        bouncedRecipients,
        subject: `Delivery failure: ${bouncedRecipients.length} recipient(s) bounced`,
      },
    };
    const deliverabilityResult = await this.signalStore.saveSignal(deliverabilitySignal);
    if (deliverabilityResult.isErr()) return err(deliverabilityResult.error);

    if (revertToDraft) {
      const revertResult = await this.signalStore.updateSignalSendStatus(accountId, linkedSend.signalLookupId, {
        status: "draft",
        sendFailureReason: "all_recipients_bounced",
        sendInitiatedAt: null,
      });
      if (revertResult.isErr()) {
        this.logger.warn("Failed to revert bounced signal to draft", { code: "ses_feedback.revert_draft_failed", signalId: linkedSend.linkedSignalId, error: revertResult.error });
      }
    }

    return ok(undefined);
  }
}
