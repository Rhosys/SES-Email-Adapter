import type { EmailContentStore, ContentStore } from "../content-store.js";
import { DateTime, Duration } from "luxon";
import { generateId } from "../utils/id.js";
import type { Logger } from "../logger.js";
import type { Result } from "neverthrow";
import type { IForwardingService } from "../forwarding/forwarding-service.js";
import { ok, err, dbError, processorError, noAccountError, notFoundError } from "../errors.js";
import type { DbError, InvalidResponseError, NotFoundError, ProcessorError, NoAccountError, AuthressServiceError } from "../errors.js";
import type { AccessService } from "../api/accountsApi.js";
import type { EmailServiceError } from "../email/email-service.js";
import type { ProviderSendError } from "../external-exchanges/provider-adapter.js";
import type { Signal, Thread, Rule, Workflow, WorkflowData, Alias, ThreadUrgency, UnknownSenderPolicy, MatchedRuleResult, InvalidRuleFunctionData, UnsubscribeInfo, InboundEmailSignalData } from "../types/index.js";
import { deriveGroupingKey } from "../grouping-key.js";
import { DEFAULT_UNKNOWN_SENDER_POLICY } from "../types/index.js";
import type { ParsedMime } from "./mime.js";
import type { ContentSanitizerClient } from "./content-sanitizer-client.js";
import type { UserCodeExecutorClient, TemplateParameterResult } from "./user-code-client.js";
import type { RuleEvalResult } from "./interpret-rule-result.js";
import { buildEmbedText } from "../embedding/embed-text.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import { RELEVANT_HEADERS } from "../classifier/prompt-builder.js";
import type { EmbeddingGenerator } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/thread-matcher.js";
import type { ThreadDatabase, UpdateThreadFields } from "../database/thread-database.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { ProcessingDatabase } from "../database/processing-database.js";
import type { ResourceDatabase } from "../database/resource-database.js";
import { deriveResourceInfo } from "./resource-info.js";
import type { S3RetentionService } from "../embedding/s3-retention-service.js";
import { getRetentionForPlan } from "../embedding/retention-tier.js";
import type { BillingPlan } from "../embedding/retention-tier.js";
import { resolveRetention, retentionToS3Tag, durationToSeconds } from "./retention.js";
import type { RetentionDuration } from "./retention.js";
import { buildActiveThread } from "./thread-factory.js";
import { getPrimaryThreadMatcherRegistry, getActiveClusters } from "../embedding/cluster-registry.js";
import { getETLD1, assignSystemLabels } from "./filter.js";
import { isSystemAccount } from "../database/system-account-db.js";
import { parseHopCount } from "../email/ses-tags.js";
import { toRuleSignalContext, toRuleThreadContext } from "./rule-context.js";
import { statusToMetric } from "../database/stats-writer.js";
import type { DraftSendDispatch } from "./draft-send-dispatcher.js";
import { isReplyTargetSafe } from "./reply-target-validator.js";
import { BillingHandler } from "../billing/billing-handler.js";
import type { HandlerRegistry } from "../workflow/registry.js";
import { findCalendarAttachment, parseIcs } from "./calendar/ics-parser.js";
import { buildCalendarSignalLookupId } from "./calendar/signal-lookup.js";
import { forwardCalendarInvite } from "./calendar/calendar-forwarder.js";
import type { CalendarForwarderDeps } from "./calendar/calendar-forwarder.js";
import type { CalendarEventData, CalendarInviteInvalidData } from "../types/calendar.js";
import type { SchedulerClient } from "../scheduler/scheduler-client.js";
import { RSVP_REMINDER_HOURS_BEFORE } from "../scheduler/rsvp-reminder.js";
import { extractMsgId, buildSignalGsi3pk, extractFirstInReplyTo } from "./message-id.js";

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type ProcessorMessageType = "inbound_signal" | "side_effect";

export interface SideEffectPayload {
  signal: Signal;
  thread: Thread;
}

export interface SqsDispatcher {
  sendMessage(payload: SideEffectPayload): Promise<Result<void, DbError>>;
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ThreadMatcherPort {
  findMatch(accountId: string, recipientAddress: string, embedding: number[]): Promise<Result<Thread | null, DbError>>;
  upsertEmbedding(threadId: string, embedding: number[], accountId: string, recipientAddress: string, signalId: string): Promise<Result<void, DbError>>;
  deleteEmbeddingsForThread(accountId: string, threadId: string): Promise<Result<void, DbError>>;
}

export interface RuleEvaluator {
  evaluate(rule: Rule, context: { signal: Signal; thread: Thread; isMatchedThread: boolean }): Promise<RuleEvalResult>;
}

export interface Notifier {
  notify(accountId: string, thread: Thread, signal: Signal, urgency: ThreadUrgency): Promise<Result<void, DbError>>;
}


/**
 * Failure modes of an outbound send, across both routes: SES rejections, provider-side
 * rejections (Gmail/Graph), and the database reads that decide which route to take.
 */
export type ReplySendError = EmailServiceError | ProviderSendError | DbError | { kind: "loop_guard_tripped"; hopCount: number };

export interface ReplySender {
  sendReply(opts: {
    to: string;
    from: string;
    subject: string;
    body: string;
    /** RFC 5322 Message-ID of the specific message being replied to. Omit when there isn't one. */
    inReplyTo?: string;
    /** Absent for platform-originated mail, which sends under the platform tenant. */
    accountId?: string;
    signalId?: string;
    threadId?: string;
    /** Hop count off the message being replied to — see ReplySenderService.sendReply. */
    hopCount?: number;
    /** RFC 3834 — set for pongs/auto-replies, never for a user's own draft send. */
    autoSubmitted?: boolean;
    /**
     * Whether this send may degrade to a platform-domain send when the from-address cannot send
     * as itself (no capable exchange AND unverified domain). True for pongs, false for user draft
     * sends. Provider send *failures* are always errors regardless of this flag.
     */
    allowFallbackToPlatformSending: boolean;
  }): Promise<Result<{
    messageId: string;
    /**
     * RFC 5322 Message-ID of what was sent, for keying the GSI3 lookup that matches an
     * inbound reply's In-Reply-To back to this signal. Absent when the send route could not
     * determine it — threading then falls back to subject/participant matching.
     */
    outboundMsgId?: string;
  }, ReplySendError>>;
}

import type { SESReceiptStatus } from "aws-lambda";

/** Re-exported for external consumers that need the verdict status type. */
export type SesVerdictStatus = SESReceiptStatus["status"];

const systemSignalDefaultRetentionDuration = Math.floor(Duration.fromISO("P90D").as("seconds"));

export interface InboundSignalMessage {
  /**
   * Optional sanity-check value. The pipeline always re-derives the owning accountId
   * from the recipient address; if this is set and disagrees with the derived value,
   * a track event is emitted and the derived value wins. Never used to skip the lookup.
   */
  expectedAccountId?: string;
  s3Key: string;
  /** Full composite lookup key including source prefix (e.g. "ses-abc123", "gmail-xyz"). */
  compositeMailMessageId: string;
  idempotencyKey: string;
  timestamp: string;
  destination: string[];
  dkimVerdict: SESReceiptStatus["status"];
  dmarcVerdict: SESReceiptStatus["status"];
}

/**
 * RFC 3834 §5: true when a message is itself automated — a non-"no" Auto-Submitted header, or a
 * null Return-Path (the bounce/MDN convention). Used to suppress any automated response to it
 * (pong, auto-send) — answering an automated message is exactly how two automated systems end up
 * replying to each other forever.
 */
function isAutomatedMessage(headers: Record<string, string>): boolean {
  const autoSubmitted = headers["auto-submitted"]?.trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  return headers["return-path"]?.trim() === "<>";
}

// ---------------------------------------------------------------------------
// Processing outcome
// ---------------------------------------------------------------------------

interface ProcessingOutcome {
  blockDisposition: "block_hidden" | "block_reject" | "report_violation" | null;
  quarantine: boolean;
  quarantineHidden: boolean;  // true → quarantine_hidden status; false → quarantine_visible
  approveSender: boolean;
  archive: boolean;
  urgency?: ThreadUrgency;
  suppressNotification: boolean;
  forwardAddresses: string[];
  additionalLabels: string[];
}

/**
 * Builds a human-readable reason summary for the dropped-attachments log title — not
 * just the payload. Reasons carrying a `detail` (currently only "upload_failed") are
 * listed individually with their full detail text, since that's the actual "why" and
 * different attachments can fail for different reasons; reasons with no further detail
 * (e.g. "too_large") are collapsed into a single count.
 */
function summarizeDroppedReasons(dropped: { reason: string; detail?: string }[]): string {
  const parts: string[] = [];
  const countsByReason = new Map<string, number>();
  for (const d of dropped) {
    if (d.detail) {
      parts.push(`${d.reason}: ${d.detail}`);
    } else {
      countsByReason.set(d.reason, (countsByReason.get(d.reason) ?? 0) + 1);
    }
  }
  for (const [reason, count] of countsByReason) parts.push(`${count} ${reason}`);
  return parts.join("; ");
}

function emptyOutcome(): ProcessingOutcome {
  return {
    blockDisposition: null,
    quarantine: false,
    quarantineHidden: false,
    approveSender: false,
    archive: false,
    suppressNotification: false,
    forwardAddresses: [],
    additionalLabels: [],
  };
}

async function applyRules(
  rules: Rule[],
  context: { signal: Signal; thread: Thread; isMatchedThread: boolean },
  evaluator: RuleEvaluator,
  logger: Logger,
  saveSignal: (signal: Signal<InvalidRuleFunctionData>) => Promise<Result<void, DbError>>,
): Promise<MatchedRuleResult[]> {
  const matchedRules: MatchedRuleResult[] = [];
  for (const rule of rules) {
    const evalResult = await evaluator.evaluate(rule, context);
    if (!evalResult.matched) continue;

    // Log warnings for invalid dynamic actions (failed Zod validation)
    if (evalResult.warnings.length > 0) {
      logger.warn("Rule returned invalid dynamic actions — discarded entries that failed Zod validation.", {
        code: "processor.rule.invalid_dynamic_actions",
        signal: context.signal, thread: context.thread,
        ruleId: rule.id,
        ruleName: rule.name,
        accountId: rule.accountId,
        warnings: evalResult.warnings,
      });
      const id = generateId("sgn-");
      const timestamp = DateTime.utc().toISO()!;
      const ttl = Math.floor(Date.now() / 1000) + systemSignalDefaultRetentionDuration;
      const result = await saveSignal({
        id, signalLookupId: id, threadId: context.thread.id, accountId: rule.accountId,
        source: "email", type: "invalid_rule_function", status: "active",
        labels: [],
        createdAt: timestamp, ttl,
        data: { resourceName: rule.name, issue: evalResult.warnings.join("; ") },
      });
      if (result.isErr()) {
        logger.warn("Failed to save invalid_rule_function signal.", { code: "system_signal.write_failed", signal: context.signal, thread: context.thread, accountId: rule.accountId, type: "invalid_rule_function", error: result.error });
      }
    }

    const staticActions = rule.actions.map(({ type, value }) => ({ type, ...(value !== undefined ? { value } : {}) }));
    const dynamicActions = evalResult.dynamicActions.map(({ type, value }) => ({ type, ...(value !== undefined ? { value } : {}) }));
    const actions = [...staticActions, ...dynamicActions];
    const labelsAdded = actions.filter((a) => a.type === "assign_label" && a.value).map((a) => a.value!);
    const statusChange: MatchedRuleResult["statusChange"] = (
      actions.some((a) => a.type === "block_reject")      ? "block_reject"      :
      actions.some((a) => a.type === "block_hidden")      ? "block_hidden"      :
      actions.some((a) => a.type === "quarantine_hidden") ? "quarantine_hidden"  :
      actions.some((a) => a.type === "quarantine_visible") ? "quarantine_visible" :
      actions.some((a) => a.type === "archive")           ? "archived"           :
      undefined
    );

    // If a prior rule already set the status and this rule's only contribution is a
    // redundant status change (no labels, no workflow, no other side-effect actions),
    // treat it as unmatched — don't pollute matchedRules with noise.
    const statusAlreadySet = matchedRules.some((r) => r.statusChange);
    if (statusAlreadySet && statusChange && labelsAdded.length === 0) {
      const STATUS_ACTION_TYPES = new Set(["block_reject", "block_hidden", "quarantine_hidden", "quarantine_visible", "archive"]);
      const hasNonStatusAction = actions.some((a) => !STATUS_ACTION_TYPES.has(a.type));
      if (!hasNonStatusAction) continue;
    }

    matchedRules.push({ ruleId: rule.id, actions, labelsAdded, ...(statusChange ? { statusChange } : {}) });
    // assign_workflow mutates the thread so subsequent rules evaluate against the updated workflow
    const workflowAction = actions.find((a) => a.type === "assign_workflow");
    if (workflowAction?.value) context.thread.workflow = workflowAction.value as Workflow;
  }
  return matchedRules;
}

function deriveOutcome(matchedRules: MatchedRuleResult[]): ProcessingOutcome {
  const outcome = emptyOutcome();
  let statusSet = false;   // first-rule-wins: the first status-changing action determines fate
  let urgencySet = false;  // first-rule-wins: the first set_urgency action determines urgency
  for (const { actions } of matchedRules) {
    for (const action of actions) {
      switch (action.type) {
        case "block_hidden":
          if (!statusSet) { outcome.blockDisposition = "block_hidden"; statusSet = true; }
          break;
        case "block_reject":
          if (!statusSet) { outcome.blockDisposition = "block_reject"; statusSet = true; }
          break;
        case "quarantine_visible":
          if (!statusSet) { outcome.quarantine = true; statusSet = true; }
          break;
        case "quarantine_hidden":
          if (!statusSet) { outcome.quarantine = true; outcome.quarantineHidden = true; statusSet = true; }
          break;
        case "archive":
          if (!statusSet) { outcome.archive = true; statusSet = true; }
          break;
        case "approve_sender":        outcome.approveSender = true; break;
        case "suppress_notification": outcome.suppressNotification = true; break;
        case "set_urgency":           if (!urgencySet && action.value) { outcome.urgency = action.value as ThreadUrgency; urgencySet = true; } break;
        case "assign_label":          if (action.value) outcome.additionalLabels.push(action.value); break;
        case "forward":               if (action.value) outcome.forwardAddresses.push(action.value); break;
      }
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// System rules — re-exported from system-rules.ts
// ---------------------------------------------------------------------------

export { SYSTEM_RULES } from "./system-rules.js";

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

interface SignalProcessorOptions {
  threadDb: ThreadDatabase;
  accountDb: AccountDatabase;
  processingDb: ProcessingDatabase;
  resourceDb: ResourceDatabase;
  contentSanitizer: ContentSanitizerClient;
  userCodeExecutor: UserCodeExecutorClient;
  classifier: Pick<SignalClassifier, "classify">;
  embeddingGenerator: EmbeddingGenerator;
  auroraWriter: MultiClusterAuroraWriter;
  threadMatcher: ThreadMatcherPort;
  ruleEvaluator: RuleEvaluator;
  logger: Logger;
  notifier: Notifier;
  forwardingService: IForwardingService;
  retentionService: S3RetentionService;
  replySender: ReplySender;
  sqsDispatcher: SqsDispatcher;
  draftSendDispatcher: DraftSendDispatch;
  billingHandler: BillingHandler;
  handlerRegistry: HandlerRegistry;
  calendarForwarderDeps: CalendarForwarderDeps;
  schedulerClient: SchedulerClient;
  emailContentStore: EmailContentStore;
  contentStore: ContentStore;
  accessService: Pick<AccessService, "listUsers" | "getUserProfile">;
  platformTenantName: string;
}

export class SignalProcessor {
  private readonly threadDb: ThreadDatabase;
  private readonly accountDb: AccountDatabase;
  private readonly processingDb: ProcessingDatabase;
  private readonly resourceDb: ResourceDatabase;
  private readonly contentSanitizer: ContentSanitizerClient;
  private readonly userCodeExecutor: UserCodeExecutorClient;
  private readonly classifier: Pick<SignalClassifier, "classify">;
  private readonly embeddingGenerator: EmbeddingGenerator;
  private readonly auroraWriter: MultiClusterAuroraWriter;
  private readonly threadMatcher: ThreadMatcherPort;
  private readonly ruleEvaluator: RuleEvaluator;
  private readonly logger: Logger;
  private readonly notifier: Notifier;
  private readonly forwardingService: IForwardingService;
  private readonly replySender: ReplySender;
  private readonly retentionService: S3RetentionService;
  private readonly sqsDispatcher: SqsDispatcher;
  private readonly draftSendDispatcher: DraftSendDispatch;
  private readonly billingHandler: BillingHandler;
  private readonly handlerRegistry: HandlerRegistry;
  private readonly calendarForwarderDeps: CalendarForwarderDeps;
  private readonly schedulerClient: SchedulerClient;
  private readonly emailContentStore: EmailContentStore;
  private readonly contentStore: ContentStore;
  private readonly accessService: Pick<AccessService, "listUsers" | "getUserProfile">;
  private readonly platformTenantName: string;

  constructor(opts: SignalProcessorOptions) {
    this.threadDb = opts.threadDb;
    this.accountDb = opts.accountDb;
    this.processingDb = opts.processingDb;
    this.resourceDb = opts.resourceDb;
    this.contentSanitizer = opts.contentSanitizer;
    this.userCodeExecutor = opts.userCodeExecutor;
    this.classifier = opts.classifier;
    this.embeddingGenerator = opts.embeddingGenerator;
    this.auroraWriter = opts.auroraWriter;
    this.threadMatcher = opts.threadMatcher;
    this.ruleEvaluator = opts.ruleEvaluator;
    this.logger = opts.logger;
    this.notifier = opts.notifier;
    this.forwardingService = opts.forwardingService;
    this.replySender = opts.replySender;
    this.retentionService = opts.retentionService;
    this.sqsDispatcher = opts.sqsDispatcher;
    this.draftSendDispatcher = opts.draftSendDispatcher;
    this.billingHandler = opts.billingHandler;
    this.handlerRegistry = opts.handlerRegistry;
    this.calendarForwarderDeps = opts.calendarForwarderDeps;
    this.schedulerClient = opts.schedulerClient;
    this.emailContentStore = opts.emailContentStore;
    this.contentStore = opts.contentStore;
    this.accessService = opts.accessService;
    this.platformTenantName = opts.platformTenantName;
  }

  /**
   * Resolve which account owns a recipient address, plus the alias config if one exists.
   * Alias match wins (single GSI read returns the full Alias via the ALL projection);
   * otherwise falls back to the domain owner, with `aliasConfig: null`. Returns `null`
   * when no active account owns the address (no alias and no non-deleted domain owner) —
   * the caller drops the message.
   */
  private async resolveAccountIdAndAlias(recipientAddress: string): Promise<Result<{ accountId: string; aliasConfig: Alias | null } | null, DbError>> {
    const aliasResult = await this.accountDb.getAliasByGlobalAddress(recipientAddress);
    if (aliasResult.isErr()) return err(aliasResult.error);
    if (aliasResult.value) return ok({ accountId: aliasResult.value.accountId, aliasConfig: aliasResult.value });

    const domain = recipientAddress.split("@")[1] ?? "";
    const ownerResult = await this.accountDb.getDomainOwner(domain);
    if (ownerResult.isErr()) return err(ownerResult.error);
    const owner = ownerResult.value;
    if (!owner || owner.status === "deleted") return ok(null);
    return ok({ accountId: owner.accountId, aliasConfig: null });
  }

  /**
   * A pong (test auto-reply) is sent only when the sender belongs to the account AND the moment
   * is a "test" moment. Sender ownership is proven by either:
   *   • the from-address eTLD+1 matching one of the account's registered domains (domain-based
   *     onboarding — the owner emails from an address on a domain they verified with us), or
   *   • the from-address exactly matching (case-insensitive) the email of a user on the account.
   *     This covers IMAP/JMAP onboarding: the test lands on an alias whose domain the account
   *     never registered, but the sender is the owner's own personal address. The user lookup
   *     goes to Authress, so it is done only after the cheap domain check misses.
   * Test moment: the classifier tagged it "test", OR the account is fresh (created within 4 weeks)
   * and has no threads yet, OR onboarding has not yet recorded a test email. The thread lookup is
   * gated behind the cheap createdAt check so mature accounts skip it.
   */
  private async shouldPong(accountId: string, signal: Signal): Promise<Result<boolean, DbError | AuthressServiceError>> {
    // Emailing your own alias has no separate sender to confirm anything to — this is also what
    // made the SYSTEM account's healthcheck loop unconditional (its "sender" and "recipient" are
    // the same address), so it doubles as a general, DB-independent version of that guard.
    if (signal.data.from.address.toLowerCase() === signal.data.recipientAddress.toLowerCase()) return ok(false);

    // The SYSTEM account only ever receives the daily healthcheck email, which it also sends —
    // sender and account domain are the same, so without this guard shouldPong would fire a
    // pong back to the healthcheck sender every time, which the pipeline re-ingests as a new
    // signal and pongs again: an immediate, self-sustaining reply loop.
    if (isSystemAccount(accountId)) return ok(false);

    // RFC 3834 §5: never auto-respond to a message that is itself automated (another system's
    // auto-reply, bounce, or notification) — doing so is exactly how two auto-responders end up
    // answering each other forever.
    if (isAutomatedMessage(signal.data.headers)) return ok(false);

    const domainsResult = await this.accountDb.listDomains(accountId);
    if (domainsResult.isErr()) return err(domainsResult.error);

    const fromAddress = signal.data.from.address;
    const fromETLD1 = getETLD1(fromAddress);
    let senderBelongsToAccount = domainsResult.value.some(d => getETLD1(d.domain) === fromETLD1);

    if (!senderBelongsToAccount) {
      const ownedByUserResult = await this.senderMatchesAccountUser(accountId, fromAddress);
      if (ownedByUserResult.isErr()) return err(ownedByUserResult.error);
      senderBelongsToAccount = ownedByUserResult.value;
    }
    if (!senderBelongsToAccount) return ok(false);

    if (signal.data.workflow === "test") return ok(true);

    const accountResult = await this.accountDb.getAccount(accountId);
    if (accountResult.isErr()) return err(accountResult.error);
    const account = accountResult.value;

    if (account?.onboarding?.testEmailReceived !== true) return ok(true);

    const recentlyCreated = !!account?.createdAt &&
      DateTime.fromISO(account.createdAt) > DateTime.utc().minus({ weeks: 4 });
    if (!recentlyCreated) return ok(false);

    const threadsResult = await this.threadDb.listActiveThreads(accountId, 1);
    if (threadsResult.isErr()) return err(threadsResult.error);
    return ok(threadsResult.value.length === 0);
  }

  /**
   * True when the sender address exactly matches (case-insensitive) the email of any user on the
   * account. Ownership signal for pong eligibility when the sender is not on a registered domain.
   * Reads user list + profiles from Authress; an Authress failure is surfaced as an error so the
   * caller can decide (it tracks and skips the pong — never a fatal, never a retry).
   */
  private async senderMatchesAccountUser(accountId: string, fromAddress: string): Promise<Result<boolean, AuthressServiceError>> {
    const usersResult = await this.accessService.listUsers(accountId);
    if (usersResult.isErr()) return err(usersResult.error);
    const users = usersResult.value;
    if (users.length === 0) return ok(false);

    const target = fromAddress.trim().toLowerCase();
    const profileResults = await Promise.all(users.map(u => this.accessService.getUserProfile(u.userId)));
    for (const profileResult of profileResults) {
      if (profileResult.isErr()) return err(profileResult.error);
      const email = profileResult.value.email?.trim().toLowerCase();
      if (email && email === target) return ok(true);
    }
    return ok(false);
  }

  /** Record that the account has received its first test email (onboarding milestone). No-op if already completed. */
  private async markTestEmailReceived(accountId: string): Promise<void> {
    const accountResult = await this.accountDb.getAccount(accountId);
    if (accountResult.isErr()) {
      this.logger.warn("Failed to load account for onboarding testEmailReceived mark.", { code: "processor.onboarding_mark_load_failed", accountId, error: accountResult.error });
      return;
    }
    if (accountResult.value?.onboarding?.completed) return;
    if (accountResult.value?.onboarding?.testEmailReceived === true) return;

    const updateResult = await this.accountDb.updateAccount(accountId, {
      onboarding: { completed: false, testEmailReceived: true, testEmailReceivedAt: DateTime.utc().toISO()! },
    });
    if (updateResult.isErr()) {
      this.logger.warn("Failed to mark onboarding testEmailReceived.", { code: "processor.onboarding_mark_failed", accountId, error: updateResult.error });
    }
  }

  async processSideEffect(payload: SideEffectPayload, receiveCount = 1): Promise<Result<void, ProcessorError>> {
    const { signal, thread: payloadThread } = payload;
    const accountId = signal.accountId;

    // On retries the payload thread snapshot may be stale — refetch from DDB
    let thread: Thread;
    if (receiveCount > 1) {
      const threadResult = await this.threadDb.getThread(accountId, payloadThread.id);
      if (threadResult.isErr()) return err(processorError(threadResult.error));
      thread = threadResult.value ?? payloadThread;
    } else {
      thread = payloadThread;
    }

    // Re-derive outcome from persisted matchedRules
    const outcome = deriveOutcome(signal.data.matchedRules ?? []);

    this.logger.trackPoint("side_effect_received");

    // Determine which effect types will execute
    const autoDraftActions = (signal.data.matchedRules ?? []).flatMap(r => r.actions.filter(a => a.type === "auto_draft" && a.value));
    const effectTypes: string[] = [];
    if (outcome.forwardAddresses.length > 0) effectTypes.push("forward");
    if (!outcome.suppressNotification) effectTypes.push("notify");
    if (autoDraftActions.length > 0) effectTypes.push("auto_draft");
    this.logger.info("Outcome derived from matchedRules — executing side-effects.", { code: "processor.side_effect.outcome_derived", accountId, signalId: signal.id, threadId: thread.id, effectTypes });

    // Critical side-effects (forward, pong) force retry on failure.
    // Best-effort side-effects (notify, auto-send) are logged and swallowed.
    const criticalFailures: unknown[] = [];

    // Forward (critical — recipient loses the email if this fails)
    if (outcome.forwardAddresses.length > 0) {
      for (const toAddress of outcome.forwardAddresses) {
        try {
          this.logger.trackPoint("side_effect_forward_start");
          const forwardResult = await this.forwardingService.forward(toAddress, signal, thread);
          if (forwardResult.isErr()) {
            this.logger.track(`Side-effect forward failed — will force retry: ${"message" in forwardResult.error ? forwardResult.error.message : "errorName" in forwardResult.error ? forwardResult.error.errorName : forwardResult.error.kind}`, { code: "processor.side_effect.forward_failed", signal, thread, payload, toAddress, error: forwardResult.error });
            criticalFailures.push(forwardResult.error);
          } else {
            this.logger.trackPoint("side_effect_forward_complete");
          }
        } catch (e) {
          this.logger.track(`Side-effect forward threw unexpectedly — will force retry: ${e instanceof Error ? e.message : e}`, { code: "processor.side_effect.forward_error", signal, thread, payload, toAddress, error: e });
          criticalFailures.push(e);
        }
      }
    }

    // Notify
    if (!outcome.suppressNotification) {
      try {
        this.logger.trackPoint("side_effect_notify_start");
        const notifyResult = await this.notifier.notify(accountId, thread, signal, thread.urgency ?? "normal");
        if (notifyResult.isErr()) {
          this.logger.track(`Side-effect notification failed: ${notifyResult.error.message}`, { code: "processor.side_effect.notify_failed", signal, thread, payload, error: notifyResult.error });
        }
        this.logger.trackPoint("side_effect_notify_complete");
      } catch (e) {
        this.logger.error(`Side-effect notification threw unexpectedly: ${e instanceof Error ? e.message : e}`, { code: "processor.side_effect.notify_error", signal, thread, payload, error: e });
      }
    }

    // Workflow dispatch (critical — handler decides retriability)
    this.logger.trackPoint("side_effect_workflow_start");
    const dispatchResult = await this.handlerRegistry.dispatch(signal, thread, accountId);
    this.logger.trackPoint("side_effect_workflow_complete");
    if (dispatchResult.isErr()) {
      this.logger.track(`Side-effect workflow dispatch failed — will force retry: ${dispatchResult.error.message}`, { code: "processor.side_effect.workflow_dispatch_failed", signal, thread, payload, error: dispatchResult.error });
      criticalFailures.push(dispatchResult.error);
    }

    // Pong (critical — the test confirmation is the product's first impression).
    // Whether to pong is computed here from account state, not carried as a rule action:
    // the sender must belong to the account AND this must be a test moment (classifier said
    // "test", or the account is new with no threads yet, or onboarding hasn't seen a test).
    const pongResult = await this.shouldPong(accountId, signal);
    if (pongResult.isErr()) {
      this.logger.track("Failed to evaluate pong eligibility — skipping pong.", { code: "processor.side_effect.pong_eligibility_failed", accountId, signalId: signal.id, error: pongResult.error });
    }
    if (pongResult.isOk() && pongResult.value) {
      try {
        this.logger.trackPoint("side_effect_pong_start");
        // Send as the alias the test landed on, under the real account. The reply sender owns
        // routing: it sends through the alias's exchange (Gmail/Graph) or an aligned SES domain,
        // and — because a pong is worth sending even off the platform domain — degrades to a
        // platform-domain send when the alias can't send as itself (e.g. IMAP/JMAP, or a domain
        // the account never verified). allowFallbackToPlatformSending makes that degrade explicit.
        const hopCount = parseHopCount(signal.data.headers);
        const sendResult = await this.replySender.sendReply({
          to: signal.data.from.address,
          from: signal.data.recipientAddress,
          subject: signal.data.subject ?? "",
          body: "textBody" in signal.data ? (signal.data.textBody ?? "") : "",
          ...(signal.data.headers["message-id"] ? { inReplyTo: signal.data.headers["message-id"] } : {}),
          accountId,
          signalId: signal.id,
          threadId: thread.id,
          ...(hopCount !== undefined ? { hopCount } : {}),
          autoSubmitted: true,
          allowFallbackToPlatformSending: true,
        });
        if (sendResult.isErr() && sendResult.error.kind === "loop_guard_tripped") {
          // Already logged an ERROR with full context inside sendReply — retrying would hit
          // the exact same hop count again and never succeed, so this is handled, not failed.
        } else if (sendResult.isErr()) {
          this.logger.track(`Side-effect pong failed — will force retry: ${"message" in sendResult.error ? sendResult.error.message : sendResult.error.kind}`, { code: "processor.side_effect.pong_failed", signal, thread, payload, error: sendResult.error });
          criticalFailures.push(sendResult.error);
        } else {
          this.logger.trackPoint("side_effect_pong_complete");
          await this.markTestEmailReceived(accountId);
        }
      } catch (e) {
        this.logger.track(`Side-effect pong failed — will force retry: ${e instanceof Error ? e.message : e}`, { code: "processor.side_effect.pong_failed", signal, thread, payload, error: e });
        criticalFailures.push(e);
      }
    }

    // Auto-draft (unified: creates draft, optionally dispatches for auto-send)
    if (autoDraftActions.length > 0) {
      try {
        this.logger.trackPoint("side_effect_auto_draft_start");
        const now = DateTime.utc().toISO()!;
        const recipientDomain = signal.data.recipientAddress.split("@")[1] ?? "";
        const domainResult = await this.accountDb.getDomainByName(accountId, recipientDomain);
        const senderSetupComplete = domainResult.isOk() && !!domainResult.value?.senderSetupComplete;

        const vars: Record<string, string> = {
          "signal.subject": signal.data.subject ?? "",
          "sender.name": signal.data.from.name ?? "",
          "sender.address": signal.data.from.address,
          "thread.workflow": signal.data.workflow ?? "",
        };

        for (const action of autoDraftActions) {
          const parsed = parseAutoDraftValue(action.value!);
          if (!parsed) continue;
          const { templateId, autoSend } = parsed;

          const tmplResult = await this.accountDb.getTemplate(accountId, templateId);
          if (tmplResult.isErr() || !tmplResult.value) continue;
          const tmpl = tmplResult.value;

          // Resolve template functions via User Code Executor
          let preventAutoSend = false;
          const actionVars = { ...vars };
          if (tmpl.functions && tmpl.functions.length > 0) {
            for (const fn of tmpl.functions) {
              const response = await this.userCodeExecutor.invoke({
                tenantId: accountId,
                purpose: "template_function",
                functionCode: fn.code,
                executionContext: {
                  signal: toRuleSignalContext(signal),
                  thread: toRuleThreadContext(thread),
                },
              });
              if (response.isErr()) {
                // Execution error (timeout, runtime_error, sandbox_violation)
                const issue = `[${response.error.errorType}] ${response.error.message}`;
                await this.annotateTemplateError(accountId, tmpl.id, fn.name, response.error);
                this.logger.warn("Template function execution failed.", {
                  code: "processor.template_function.error",
                  signal, thread, payload,
                  templateName: tmpl.name,
                  functionName: fn.name,
                  error: response.error,
                });
                {
                  const sigId = generateId("sgn-");
                  const sigTs = DateTime.utc().toISO()!;
                  const invalidFnResult = await this.threadDb.saveSignal({ id: sigId, signalLookupId: sigId, threadId: thread.id, accountId, source: "email", type: "invalid_template_function", status: "active", labels: [], createdAt: sigTs, ttl: Math.floor(Date.now() / 1000) + systemSignalDefaultRetentionDuration, data: { resourceName: tmpl.name, functionName: fn.name, issue } });
                  if (invalidFnResult.isErr()) { this.logger.warn("Failed to save invalid_template_function signal", { code: "processor.save_invalid_fn_signal_failed", accountId, threadId: thread.id, error: invalidFnResult.error }); }
                }
                actionVars[`fn.${fn.name}`] = "";
                preventAutoSend = true;
              } else {
                const result = (response.value as TemplateParameterResult).value;
                if (result == null || typeof result !== "string") {
                  // Non-string or null return — treat as failure
                  const issue = result == null
                    ? "Function returned no value"
                    : `Function returned non-string value (type: ${typeof result})`;
                  await this.annotateTemplateError(accountId, tmpl.id, fn.name, null);
                  this.logger.warn("Template function returned invalid value.", {
                    code: "processor.template_function.invalid_return",
                    signal, thread, payload,
                    templateName: tmpl.name,
                    functionName: fn.name,
                    issue,
                  });
                  {
                    const sigId = generateId("sgn-");
                    const sigTs = DateTime.utc().toISO()!;
                    const invalidReturnResult = await this.threadDb.saveSignal({ id: sigId, signalLookupId: sigId, threadId: thread.id, accountId, source: "email", type: "invalid_template_function", status: "active", labels: [], createdAt: sigTs, ttl: Math.floor(Date.now() / 1000) + systemSignalDefaultRetentionDuration, data: { resourceName: tmpl.name, functionName: fn.name, issue } });
                    if (invalidReturnResult.isErr()) { this.logger.warn("Failed to save invalid_template_function signal", { code: "processor.save_invalid_fn_signal_failed", accountId, threadId: thread.id, error: invalidReturnResult.error }); }
                  }
                  actionVars[`fn.${fn.name}`] = "";
                  preventAutoSend = true;
                } else {
                  actionVars[`fn.${fn.name}`] = result;
                }
              }
            }
          }

          let shouldAutoSend = autoSend && senderSetupComplete && !preventAutoSend;

          // Reply-To safety gate — suppress auto-send if Reply-To domain is untrusted
          if (shouldAutoSend && signal.data.replyTo) {
            const replyToETLD1 = getETLD1(signal.data.replyTo.address);
            const senderResult = await this.accountDb.getSender(accountId, signal.data.recipientAddress, replyToETLD1);
            const approvedDomains = senderResult.isOk() && senderResult.value?.policy === "allow"
              ? [senderResult.value.senderDomain]
              : [];
            const replyTargetResult = isReplyTargetSafe(signal, approvedDomains);
            if (!replyTargetResult.safe) {
              shouldAutoSend = false;
              this.logger.track("Auto-send suppressed — Reply-To domain mismatch.", {
                code: "processor.side_effect.reply_target_suppressed",
                signal, thread, payload,
                fromAddress: signal.data.from.address,
                replyToAddress: signal.data.replyTo.address,
                recipientAddress: signal.data.recipientAddress,
              });
              {
                const sigId = generateId("sgn-");
                const sigTs = DateTime.utc().toISO()!;
                const autoSendBlockedResult = await this.threadDb.saveSignal({ id: sigId, signalLookupId: sigId, threadId: thread.id, accountId, source: "email", type: "auto_send_blocked", status: "active", labels: [], createdAt: sigTs, ttl: Math.floor(Date.now() / 1000) + systemSignalDefaultRetentionDuration, data: { recipientAddress: signal.data.recipientAddress } });
                if (autoSendBlockedResult.isErr()) { this.logger.warn("Failed to save auto_send_blocked signal", { code: "processor.save_auto_send_blocked_failed", accountId, threadId: thread.id, error: autoSendBlockedResult.error }); }
              }
            }
          }

          // RFC 3834 §5 gate — never auto-send in response to a message that is itself automated
          // (see isAutomatedMessage / shouldPong). Otherwise an auto-draft-and-send rule fires
          // right back at whatever auto-responder sent the triggering message, unbounded except
          // by ReplySenderService's hop-count cap.
          if (shouldAutoSend && isAutomatedMessage(signal.data.headers)) {
            shouldAutoSend = false;
            this.logger.track("Auto-send suppressed — inbound message is itself automated (Auto-Submitted/null Return-Path).", {
              code: "processor.side_effect.auto_send_suppressed_automated",
              signal, thread, payload,
              fromAddress: signal.data.from.address,
              recipientAddress: signal.data.recipientAddress,
            });
            const sigId = generateId("sgn-");
            const sigTs = DateTime.utc().toISO()!;
            const autoSendBlockedResult = await this.threadDb.saveSignal({ id: sigId, signalLookupId: sigId, threadId: thread.id, accountId, source: "email", type: "auto_send_blocked", status: "active", labels: [], createdAt: sigTs, ttl: Math.floor(Date.now() / 1000) + systemSignalDefaultRetentionDuration, data: { recipientAddress: signal.data.recipientAddress } });
            if (autoSendBlockedResult.isErr()) { this.logger.warn("Failed to save auto_send_blocked signal", { code: "processor.save_auto_send_blocked_failed", accountId, threadId: thread.id, error: autoSendBlockedResult.error }); }
          }

          const sendInitiatedAt = shouldAutoSend ? now : undefined;

          const draftId = generateId("sgn-");
          const draft: Signal = {
            id: draftId,
            signalLookupId: draftId,
            threadId: thread.id,
            accountId,
            source: "user",
            type: "email",
            status: shouldAutoSend ? "pending_send" : "draft",
            labels: [],
            createdAt: now,
            data: {
              receivedAt: now,
              from: { address: signal.data.recipientAddress },
              to: [signal.data.from],
              cc: [],
              subject: renderTemplate(tmpl.subject, actionVars),
              textBody: renderTemplate(tmpl.body, actionVars),
              attachments: [],
              headers: {},
              recipientAddress: signal.data.from.address,
              workflow: signal.data.workflow,
              workflowData: signal.data.workflowData,
              actions: [],
              tags: [],
              summary: "",
              s3Key: "",
              ...(sendInitiatedAt ? { sendInitiatedAt } : {}),
            },
          };

          const draftSaveResult = await this.threadDb.saveSignal(draft);
          if (draftSaveResult.isErr()) {
            this.logger.track(`Side-effect auto-draft save failed — will force retry: ${draftSaveResult.error.message}`, { code: "processor.side_effect.auto_draft_failed", signal, thread, payload, error: draftSaveResult.error });
            criticalFailures.push(draftSaveResult.error);
            continue;
          }

          // Dispatch to SQS for delayed send (5 min undo window)
          if (shouldAutoSend) {
            const dispatchResult = await this.draftSendDispatcher.dispatch(
              { signalId: draft.id, accountId, threadId: thread.id, sendInitiatedAt: sendInitiatedAt! },
              300,
            );
            if (dispatchResult.isErr()) {
              this.logger.track(`Side-effect auto-draft SQS dispatch failed — draft remains pending_send, will not send automatically: ${dispatchResult.error.message}`, { code: "processor.side_effect.auto_draft_dispatch_failed", signal, thread, payload, signalId: draft.id, error: dispatchResult.error });
            }
          }

          if (preventAutoSend && autoSend) {
            this.logger.info("Auto-send skipped — template function returned null or errored.", { code: "processor.side_effect.auto_draft_prevent_send", accountId, signalId: signal.id, threadId: thread.id, templateId });
          }
        }
        this.logger.trackPoint("side_effect_auto_draft_complete");
      } catch (e) {
        this.logger.track(`Side-effect auto-draft threw unexpectedly: ${e instanceof Error ? e.message : e}`, { code: "processor.side_effect.auto_draft_error", signal, thread, payload, error: e });
      }
    }

    // Calendar forwarding (critical — user expects invite in their calendar)
    const calendarForwardActions = (signal.data.matchedRules ?? [])
      .flatMap(r => r.actions.filter(a => a.type === "forwardCalendarInvite"));
    if (calendarForwardActions.length > 0) {
      try {
        this.logger.trackPoint("side_effect_calendar_forward_start");

        // Resolve calendarForwardingAddress from account config
        const accountResult = await this.accountDb.getAccount(accountId);
        const calendarForwardingAddress = accountResult.isOk() ? accountResult.value?.defaultCalendarInviteForwardingTargetId ?? "" : "";

        // Find the calendar signal linked to this email signal
        const calendarSignalResult = await this.threadDb.getLinkedCalendarSignal(accountId, thread.id, signal.id);
        if (calendarSignalResult.isErr()) {
          this.logger.track(`Calendar forward failed — could not find linked calendar signal: ${calendarSignalResult.error.message}`, { code: "processor.side_effect.calendar_forward_no_signal", signal, thread, payload, error: calendarSignalResult.error });
        } else if (!calendarSignalResult.value) {
          this.logger.track("Calendar forward skipped — no linked calendar signal found.", { code: "processor.side_effect.calendar_forward_no_signal", signal, thread, payload });
        } else {
          const calendarSignal = calendarSignalResult.value;
          const forwardResult = await forwardCalendarInvite(
            {
              calendarSignal,
              calendarForwardingAddress,
              accountId,
              threadId: thread.id,
              aliasAddress: signal.data.recipientAddress,
            },
            this.calendarForwarderDeps,
            this.logger,
          );
          if (forwardResult.isErr()) {
            this.logger.track(`Calendar forward failed — will force retry: ${"message" in forwardResult.error ? forwardResult.error.message : forwardResult.error.errorName}`, { code: "processor.side_effect.calendar_forward_failed", signal, thread, payload, error: forwardResult.error });
            criticalFailures.push(forwardResult.error);
          } else {
            this.logger.trackPoint("side_effect_calendar_forward_complete");
          }
        }
      } catch (e) {
        this.logger.track(`Calendar forward threw unexpectedly — will force retry: ${e instanceof Error ? e.message : e}`, { code: "processor.side_effect.calendar_forward_error", signal, thread, payload, error: e });
        criticalFailures.push(e);
      }
    }

    this.logger.trackPoint("side_effect_all_complete");
    if (criticalFailures.length > 0) {
      const count = criticalFailures.length;
      const message = `${count} critical side-effect failure${count > 1 ? "s" : ""}`;
      return err(processorError(new AggregateError(criticalFailures, message)));
    }
    this.logger.info("Side-effects complete", { code: "processor.side_effect.complete", accountId, signalId: signal.id, threadId: thread.id });
    return ok(undefined);
  }

  async processInbound(msg: InboundSignalMessage, receiveCount: number, opts?: { force?: boolean; unsafeSkipDmarc?: boolean; forceSignalId?: string }): Promise<Result<void, DbError | InvalidResponseError | NoAccountError>> {
    try {
      return await this._processInboundUnsafe(msg, receiveCount, opts);
    } catch (e) {
      this.logger.error(`processInbound threw an unhandled exception — the message will be retried: ${e instanceof Error ? e.message : e}`, { code: "processor.unhandled_exception", error: e, compositeMailMessageId: msg.compositeMailMessageId });
      return err(dbError(e));
    }
  }

  private async _processInboundUnsafe(msg: InboundSignalMessage, receiveCount: number, opts?: { force?: boolean; unsafeSkipDmarc?: boolean; forceSignalId?: string }): Promise<Result<void, DbError | InvalidResponseError | NoAccountError>> {
    const { s3Key, idempotencyKey, timestamp, destination } = msg;
    const recipientAddress = destination[0] ?? "";

    // 0. Resolve the owning account + alias from the recipient address. Single source of
    // truth for accountId — always re-derived, never trusted from the message.
    const resolved = await this.resolveAccountIdAndAlias(recipientAddress);
    if (resolved.isErr()) return err(resolved.error);
    if (!resolved.value) {
      this.logger.track("No account owns this recipient address — dropping message.", { code: "processor.no_account_for_recipient", recipientAddress, compositeMailMessageId: msg.compositeMailMessageId, destination });
      return err(noAccountError(recipientAddress, destination, msg.compositeMailMessageId, msg.expectedAccountId));
    }
    const { accountId, aliasConfig } = resolved.value;
    if (msg.expectedAccountId !== undefined && msg.expectedAccountId !== accountId) {
      this.logger.track("Derived accountId does not match expectedAccountId on the message — proceeding with the derived value.", { code: "processor.account_id_mismatch", expectedAccountId: msg.expectedAccountId, derivedAccountId: accountId, recipientAddress, compositeMailMessageId: msg.compositeMailMessageId });
    }

    // 1. Dedup / retry-resume — a single signal lookup serves both. On force (reprocess)
    // we skip it and always run the full pipeline.
    if (!opts?.force) {
      const existingResult = await this.threadDb.getSignalByMessageId(accountId, msg.compositeMailMessageId);
      if (existingResult.isErr()) return err(existingResult.error);
      this.logger.trackPoint("signal_dedup_lookup");
      const existing = existingResult.value;
      if (existing) {
        if (receiveCount > 1) {
          // Retry after the signal was already saved — thread is guaranteed to exist (thread is
          // saved before signal). Resume from the idempotent convergence point rather than
          // re-running classify/embed/match.
          this.logger.info("Signal found in DDB on retry — resuming from the convergence point.", { code: "processor.retry_signal_found", signalId: existing.id, threadId: existing.threadId, accountId, compositeMailMessageId: msg.compositeMailMessageId, receiveCount });
          if (!existing.threadId) return err(dbError("signal missing threadId on retry"));
          const threadResult = await this.threadDb.getThread(accountId, existing.threadId);
          if (threadResult.isErr()) return err(threadResult.error);
          this.logger.trackPoint("retry_thread_lookup");
          const thread = threadResult.value;
          if (!thread) return err(dbError("thread not found on retry"));

          const accountResult = await this.accountDb.getAccount(accountId);
          if (accountResult.isErr()) return err(accountResult.error);
          const billingPlan = accountResult.value?.billingPlan ?? "Paid";

          await this.attemptS3Retention(existing, billingPlan, thread);

          const auroraResult = await this.executeAuroraUpserts(existing, thread);
          if (auroraResult.isErr()) return err(auroraResult.error);

          const dispatchResult = await this.dispatchSideEffects(existing, thread);
          if (dispatchResult.isErr()) return err(dispatchResult.error);

          return ok(undefined);
        }
        // First delivery seeing an existing signal — true duplicate, already fully
        // processed (including dispatch). Dedup and return.
        this.logger.warn("Signal already processed — dedup skip.", { code: "processor.dedup_skip", signalId: existing.id, accountId, compositeMailMessageId: msg.compositeMailMessageId });
        return ok(undefined);
      }
    }

    // 1b. Block emails that fail DKIM or DMARC — spoofed sender, reject immediately
    if (!opts?.unsafeSkipDmarc && (msg.dkimVerdict === "FAIL" || msg.dmarcVerdict === "FAIL")) {
      if (isSystemAccount(accountId)) {
        this.logger.error("SYSTEM healthcheck email failed DKIM/DMARC on inbound — our sending DKIM configuration is broken.", {
          code: "processor.healthcheck_dkim_failure",
          dkimVerdict: msg.dkimVerdict,
          dmarcVerdict: msg.dmarcVerdict,
          recipientAddress,
          compositeMailMessageId: msg.compositeMailMessageId,
        });
      }
      const signalId = generateId("sgn-");
      const signal: Signal = {
        id: signalId,
        signalLookupId: msg.compositeMailMessageId,
        accountId,
        status: "block_reject",
        source: "email",
        type: "email",
        labels: [],
        createdAt: DateTime.utc().toISO()!,
        data: {
          s3Key,
          recipientAddress: destination[0] ?? "",
          receivedAt: timestamp,
          from: { address: "" },
          to: [],
          cc: [],
          subject: "",
          attachments: [],
          headers: {},
          workflow: "notice",
          workflowData: { workflow: "notice", noticeType: "other", provider: "" } as const,
          actions: [],
          tags: [],
          summary: "",
        },
      };
      const saveResult = await this.threadDb.saveSignal(signal);
      if (saveResult.isErr()) return err(saveResult.error);
      this.logger.track("Blocked email — DKIM or DMARC verification failed.", { code: "processor.dkim_dmarc_block", signal, dkimVerdict: msg.dkimVerdict, dmarcVerdict: msg.dmarcVerdict });
      const dkimCat = statusToMetric(signal.status);
      if (dkimCat) {
        const statsResult = await this.accountDb.incrementStatMetric(accountId, dkimCat, 1, idempotencyKey);
        if (statsResult.isErr()) {
          this.logger.warn("Stats increment failed — dashboard may be slightly behind.", { code: "processor.stats_increment_failed", signal, error: statsResult.error });
        }
      }
      return ok(undefined);
    }

    // 2. Content Sanitizer — fetch, parse, sanitize, extract

    // Fetch the account early (needed for retention resolution before content sanitizer).
    const accountResult = await this.accountDb.getAccount(accountId);
    if (accountResult.isErr()) return err(accountResult.error);
    const account = accountResult.value;
    const configuredRetentionDuration = account?.retentionDuration ?? "P3M";
    const filtering = account?.filtering ?? null;
    const billingPlan: BillingPlan = account?.billingPlan ?? "Paid";

    // Alias invariant: any accepted inbound email is addressed to a real address on a registered
    // domain, so its alias record must exist regardless of the disposition (active / quarantine /
    // block). aliasConfig (resolved at the top of the pipeline) is null exactly when no alias
    // exists yet, so create it only then — cheaply, with no extra read. This is what makes an
    // unknown-sender quarantine appear in the alias list.
    if (!aliasConfig) {
      const defaultPolicy = filtering?.defaultUnknownSenderPolicy ?? DEFAULT_UNKNOWN_SENDER_POLICY;
      const ensureResult = await this.accountDb.ensureAlias(accountId, recipientAddress, defaultPolicy, null);
      if (ensureResult.isErr()) return err(ensureResult.error);
      if (ensureResult.value.created) {
        const aliasStatResult = await this.accountDb.incrementStatMetric(accountId, "totalAliases", 1, idempotencyKey + ".alias");
        if (aliasStatResult.isErr()) { this.logger.warn("Failed to increment totalAliases stat after auto-create", { code: "processor.stats_alias_increment_failed", accountId, error: aliasStatResult.error }); }
      }
    }

    // Resolve retention and generate pre-signed URLs for the content sanitizer
    // (S3 lifecycle tagging for extracted content is independent of account/DDB retention config)
    const retentionDuration = resolveRetention({}, null);
    const s3Tag = retentionToS3Tag(retentionDuration);
    const keyPrefix = `content/accounts/${accountId}/extracted/${msg.compositeMailMessageId}/`;

    const [presignedGet, presignedPost] = await Promise.all([
      this.emailContentStore.createReadUrl(s3Key),
      this.contentStore.createContentUploadTicket(keyPrefix, s3Tag),
    ]);

    const sanitizeResult = await this.contentSanitizer.invoke({
      presignedGetUrl: presignedGet,
      presignedPost,
      accountId,
      senderEtld1: "",
      keyPrefix,
      retentionTag: s3Tag,
    });

    if (sanitizeResult.isErr()) return err(sanitizeResult.error);
    const { parsed: sanitizedParsed } = sanitizeResult.value;
    const sanitizerAssets = sanitizedParsed.assets ?? [];

    if (sanitizedParsed.droppedAttachments && sanitizedParsed.droppedAttachments.length > 0) {
      const reasonSummary = summarizeDroppedReasons(sanitizedParsed.droppedAttachments);
      this.logger.warn(`Message had attachment(s) dropped by content sanitizer: ${reasonSummary}`, {
        code: "processor.attachments_dropped",
        accountId,
        droppedCount: sanitizedParsed.droppedAttachments.length,
        dropped: sanitizedParsed.droppedAttachments.map(d => ({ mimeType: d.mimeType, sizeBytes: d.sizeBytes, reason: d.reason, detail: d.detail })),
      });
    }

    // Map sanitized response to ParsedMime for downstream compatibility
    const parsed: ParsedMime = {
      from: sanitizedParsed.from,
      to: sanitizedParsed.to,
      cc: sanitizedParsed.cc,
      subject: sanitizedParsed.subject,
      attachments: sanitizedParsed.attachments.map(a => ({
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        s3Key: a.s3Key,
      })),
      headers: sanitizedParsed.headers,
      ...(sanitizedParsed.replyTo ? { replyTo: sanitizedParsed.replyTo } : {}),
      ...(sanitizedParsed.textBody !== undefined ? { textBody: sanitizedParsed.textBody } : {}),
      ...(sanitizedParsed.htmlBody !== undefined ? { htmlBody: sanitizedParsed.htmlBody } : {}),
      ...(sanitizedParsed.sentAt !== undefined ? { sentAt: sanitizedParsed.sentAt } : {}),
      ...(sanitizedParsed.inlineImages ? { inlineImages: sanitizedParsed.inlineImages } : {}),
      ...(sanitizedParsed.displayRawS3Key ? { displayRawS3Key: sanitizedParsed.displayRawS3Key } : {}),
    };
    this.logger.trackPoint("email_parsed");

    // Extract Message-ID for GSI3 threading index (used by In-Reply-To thread matching)
    const rawMessageId = parsed.headers["message-id"];
    const msgId = rawMessageId ? extractMsgId(rawMessageId) : null;
    const gsi3pk = msgId ? buildSignalGsi3pk(accountId, msgId) : undefined;

    const senderETLD1 = getETLD1(parsed.from.address);

    // 2b. Early sender block — skip classify/embed when sender is explicitly blocked for this alias
    // (aliasConfig comes from the recipient resolution at the top of this method)
    const aliasSenderResult = await this.accountDb.getSender(accountId, recipientAddress, senderETLD1);
    if (aliasSenderResult.isErr()) return err(aliasSenderResult.error);
    const aliasSenderConfig = aliasSenderResult.value;
    const effectiveAliasSenderConfig = aliasConfig ? aliasSenderConfig : null;

    if (effectiveAliasSenderConfig && effectiveAliasSenderConfig.policy !== "allow") {
      const blockStatus = effectiveAliasSenderConfig.policy; // block_hidden | block_reject | report_violation
      const now = DateTime.utc().toISO()!;
      const effectiveRetention = resolveRetention({ retentionDuration: configuredRetentionDuration }, null);
      const retentionSecs = durationToSeconds(effectiveRetention);
      const ttl = retentionSecs != null
        ? Math.floor(Date.now() / 1000) + retentionSecs
        : undefined;
      const signalId = generateId("sgn-");
      const signal: Signal = {
        id: signalId,
        signalLookupId: msg.compositeMailMessageId,
        accountId,
        status: blockStatus,
        source: "email",
        type: "email",
        labels: [],
        createdAt: now,
        retentionDuration: effectiveRetention,
        ...(gsi3pk !== undefined ? { gsi3pk } : {}),
        data: {
          s3Key,
          recipientAddress,
          receivedAt: timestamp,
          from: parsed.from,
          to: parsed.to,
          cc: parsed.cc,
          subject: parsed.subject,
          attachments: parsed.attachments,
          headers: parsed.headers,
          workflow: "notice",
          workflowData: { workflow: "notice", noticeType: "other", provider: "" } as const,
          actions: [],
          tags: [],
          summary: "",
        },
        ...(ttl !== undefined ? { ttl } : {}),
      };
      const saveResult = await this.threadDb.saveSignal(signal);
      if (saveResult.isErr()) return err(saveResult.error);
      this.logger.track("Blocked email — sender explicitly blocked for this alias (pre-classify fast path).", { code: "processor.sender_block_early", signal, senderETLD1, policy: blockStatus });
      const repResult = await this.processingDb.updateGlobalReputation(senderETLD1, blockStatus);
      if (repResult.isErr()) {
        this.logger.warn("Failed to update global sender reputation after signal processing. The DynamoDB update returned an error. Reputation data may be stale for this domain.", { code: "processor.reputation_update_failed", signal, error: repResult.error });
      }
      const senderBlockCat = statusToMetric(blockStatus);
      if (senderBlockCat) {
        const statsResult = await this.accountDb.incrementStatMetric(accountId, senderBlockCat, 1, idempotencyKey);
        if (statsResult.isErr()) {
          this.logger.warn("Stats increment failed — dashboard may be slightly behind.", { code: "processor.stats_increment_failed", signal, error: statsResult.error });
        }
      }
      return ok(undefined);
    }

    // 3. Fetch account labels for closed-set label selection
    const labelsResult = await this.accountDb.listLabels(accountId);
    const allowedLabels = labelsResult.isOk() ? labelsResult.value.map(l => l.name) : [];
    const labelInstructions: Record<string, string> = {};
    if (labelsResult.isOk()) {
      for (const label of labelsResult.value) {
        labelInstructions[label.name] = label.applyInstruction;
      }
    }

    // 4. Classify email (must complete before embedding — sequential dependency)
    const classificationHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.headers)) {
      if (RELEVANT_HEADERS.has(k.toLowerCase())) classificationHeaders[k] = v;
    }
    // Extract <html lang="..."> attribute from raw HTML as an additional locale signal
    if (parsed.htmlBody) {
      const htmlLangMatch = parsed.htmlBody.match(/<html[^>]*\slang=["']([^"']+)["']/i);
      if (htmlLangMatch?.[1]) {
        classificationHeaders["x-html-lang"] = htmlLangMatch[1];
      }
    }
    const extractedLinks = sanitizedParsed.links ?? [];
    const classification = await this.classifier.classify({
      from: parsed.from.address,
      to: parsed.to.map((a) => a.address),
      subject: parsed.subject,
      body: parsed.htmlBody != null ? stripHtmlForClassifier(parsed.htmlBody) : (parsed.textBody ?? ""),
      headers: classificationHeaders,
      receivedAt: timestamp,
      allowedLabels,
      labelInstructions,
      extractedLinks,
      signalId: msg.compositeMailMessageId,
      accountId,
      accountTimezone: account?.timezone ?? "UTC",
    });

    let classificationOutput: ClassificationOutput;
    if (classification.isErr()) {
      this.logger.warn("Classification failed — proceeding with workflow:none fallback.", { code: "processor.classification_fallback", accountId, compositeMailMessageId: msg.compositeMailMessageId, error: classification.error });
      classificationOutput = { workflow: "unspecified", workflowData: { workflow: "unspecified" }, tags: [], summary: "", labels: [], actions: [] };
    } else {
      classificationOutput = classification.value;
    }

    // 4b. requiresReply override — if the alias is not a direct recipient (only CC/BCC),
    // the email is not addressed to the user so a reply is not expected.
    if (classificationOutput.workflow === "conversation" && classificationOutput.workflowData.workflow === "conversation" && classificationOutput.workflowData.requiresReply) {
      const isDirectRecipient = parsed.to.some(addr => addr.address.toLowerCase() === recipientAddress.toLowerCase());
      if (!isDirectRecipient) {
        classificationOutput.workflowData = { ...classificationOutput.workflowData, requiresReply: false };
      }
    }

    // 5. Build embed text from classification output (attacker-free content)
    const senderDomain = parsed.from.address.split("@").pop() ?? "";
    const embedText = buildEmbedText(senderDomain, classificationOutput, parsed.subject);

    // Phase 1: Primary embedding (fail-hard) — must succeed for thread matching
    const readCluster = getPrimaryThreadMatcherRegistry();
    const primaryResult = await this.embeddingGenerator.generateForModel(embedText, readCluster.modelId);

    if (primaryResult.isErr()) {
      this.logger.error(`Primary embedding generation failed — thread matching cannot proceed, message will be retried: ${primaryResult.error.message}`, { code: "embedding.primary_failed", modelId: readCluster.modelId, error: primaryResult.error });
      return err(dbError(primaryResult.error));
    }
    const embedding = primaryResult.value.vector;
    this.logger.trackPoint("email_processed");

    const now = DateTime.utc().toISO()!;

    const effectiveRetentionForTtl = resolveRetention({ retentionDuration: configuredRetentionDuration }, null);
    const retentionSecsForTtl = durationToSeconds(effectiveRetentionForTtl);
    const ttl = retentionSecsForTtl != null
      ? Math.floor(Date.now() / 1000) + retentionSecsForTtl
      : undefined;

    // 5. SYSTEM account override — healthcheck emails always get workflow "healthcheck"
    // regardless of classifier output.
    if (isSystemAccount(accountId)) {
      classificationOutput.workflow = "healthcheck" as Workflow;
      classificationOutput.workflowData = { workflow: "healthcheck" } as unknown as WorkflowData;
    }

    // 6. Thread matching (parallel tiers)
    const groupingKey = deriveGroupingKey(classificationOutput.workflow, classificationOutput.workflowData, recipientAddress, senderETLD1);
    this.logger.trackPoint("thread_matcher_values_generated");
    this.logger.trackPoint("thread_match_search");

    // Tier 1: Grouping key lookup
    const tier1Promise = (async (): Promise<Thread | null> => {
      if (!groupingKey) return null;
      this.logger.trackPoint("thread_matcher_grouping_key_lookup");
      const gkResult = await this.threadDb.findThreadByGroupingKey(accountId, groupingKey);
      if (gkResult.isErr()) return null;
      return gkResult.value;
    })();

    // Tier 1.5: In-Reply-To GSI3 lookup
    const tier15Promise = (async (): Promise<Thread | null> => {
      const inReplyToHeader = parsed.headers["in-reply-to"];
      if (!inReplyToHeader) return null;
      const firstMsgId = extractFirstInReplyTo(inReplyToHeader);
      if (!firstMsgId) return null;
      const lookupKey = buildSignalGsi3pk(accountId, firstMsgId);
      const signalResult = await this.threadDb.findSignalByEmailMessageId(lookupKey);
      if (signalResult.isErr()) {
        this.logger.warn("GSI3 In-Reply-To lookup failed — treating as miss.", { code: "processor.in_reply_to.gsi3_error", accountId, compositeMailMessageId: msg.compositeMailMessageId, error: signalResult.error });
        return null;
      }
      const foundSignal = signalResult.value;
      if (!foundSignal || !foundSignal.threadId) return null;
      const threadResult = await this.threadDb.getThread(accountId, foundSignal.threadId);
      if (threadResult.isErr()) {
        this.logger.warn("In-Reply-To thread fetch failed — treating as miss.", { code: "processor.in_reply_to.thread_fetch_error", accountId, compositeMailMessageId: msg.compositeMailMessageId, error: threadResult.error });
        return null;
      }
      return threadResult.value;
    })();

    // Tier 2: Similarity search
    const tier2Promise = (async (): Promise<Thread | null> => {
      this.logger.trackPoint("thread_matcher_similarity_search");
      const matchResult = await this.threadMatcher.findMatch(accountId, recipientAddress, embedding);
      if (matchResult.isErr()) {
        this.logger.warn("Similarity search failed — treating as miss.", { code: "processor.thread_matcher.similarity_search_failed", accountId, compositeMailMessageId: msg.compositeMailMessageId, error: matchResult.error });
        return null;
      }
      return matchResult.value;
    })();

    const [tier1Thread, tier15Thread, tier2Thread] = await Promise.all([tier1Promise, tier15Promise, tier2Promise]);

    // Discrepancy detection — log when multiple tiers produce different results
    const matchedThreads = [
      ...(tier1Thread ? [{ tier: "groupingKey" as const, threadId: tier1Thread.id }] : []),
      ...(tier15Thread ? [{ tier: "inReplyTo" as const, threadId: tier15Thread.id }] : []),
      ...(tier2Thread ? [{ tier: "similarity" as const, threadId: tier2Thread.id }] : []),
    ];
    const uniqueThreadIds = new Set(matchedThreads.map(m => m.threadId));
    if (uniqueThreadIds.size > 1) {
      this.logger.track("Thread match discrepancy — multiple tiers returned different threads.", {
        code: "processor.thread_match_discrepancy",
        accountId,
        compositeMailMessageId: msg.compositeMailMessageId,
        tier1ThreadId: tier1Thread?.id ?? null,
        tier15ThreadId: tier15Thread?.id ?? null,
        tier2ThreadId: tier2Thread?.id ?? null,
        selectedTier: tier1Thread ? "groupingKey" : tier15Thread ? "inReplyTo" : "similarity",
      });
    }

    // Select by priority: Tier 1 > Tier 1.5 > Tier 2
    const matchedThread = tier1Thread ?? tier15Thread ?? tier2Thread;
    const matchMethod: "groupingKey" | "inReplyTo" | "similarity" | "none" =
      tier1Thread ? "groupingKey" : tier15Thread ? "inReplyTo" : tier2Thread ? "similarity" : "none";

    const isMatchedThread = matchedThread !== null;

    // 7. Build thread shell (lastSignalAt applied after rules — archive outcome suppresses it on existing threads)
    let thread: Thread;
    if (matchedThread) {
      thread = {
        ...matchedThread,
        workflow: classificationOutput.workflow,
        summary: classificationOutput.summary,
        sender: { address: parsed.from.address, ...(parsed.from.name ? { name: parsed.from.name } : {}) },
        recipientAddress,
        subject: parsed.subject,
        updatedAt: now,
        // Thread retention reflects the most recently received signal's retention,
        // so it tracks current account/alias config rather than sticking to a stale value.
        retentionDuration: effectiveRetentionForTtl,
      };
      this.logger.info("Existing thread matched.", { code: "processor.thread_matched", threadId: thread.id, matchMethod, accountId, compositeMailMessageId: msg.compositeMailMessageId });
    } else {
      thread = buildActiveThread({
        accountId,
        workflow: classificationOutput.workflow,
        summary: classificationOutput.summary,
        lastSignalAt: timestamp,
        sender: { address: parsed.from.address, ...(parsed.from.name ? { name: parsed.from.name } : {}) },
        recipientAddress,
        subject: parsed.subject,
        retentionDuration: effectiveRetentionForTtl,
        groupingKey: groupingKey ?? undefined,
      });
    }

    // 8. Assign system labels and merge classifier labels
    const effectiveFilterMode: UnknownSenderPolicy = aliasConfig
      ? aliasConfig.unknownSenderPolicy
      : filtering?.defaultUnknownSenderPolicy ?? DEFAULT_UNKNOWN_SENDER_POLICY;

    // Explicit sender block — if the sender has been explicitly blocked for this alias, short-circuit
    // (post-classify path: preserves classification data on blocked signal for audit/review)
    if (effectiveAliasSenderConfig && effectiveAliasSenderConfig.policy !== "allow") {
      const blockStatus = effectiveAliasSenderConfig.policy; // block_hidden | block_reject | report_violation
      const blockedSignal = buildSignal({ status: blockStatus, accountId, compositeMailMessageId: msg.compositeMailMessageId, recipientAddress, parsed, classification: classificationOutput, s3Key, receivedAt: timestamp, now, retentionDuration: effectiveRetentionForTtl, ...(ttl !== undefined ? { ttl } : {}) }, this.logger);
      const saveResult = await this.threadDb.saveSignal(blockedSignal);
      if (saveResult.isErr()) return err(saveResult.error);
      this.logger.track("Blocked email — sender explicitly blocked for this alias.", { code: "processor.sender_block", signal: blockedSignal, thread, senderETLD1, policy: blockStatus });
      const repResult = await this.processingDb.updateGlobalReputation(senderETLD1, blockStatus);
      if (repResult.isErr()) {
        this.logger.warn("Failed to update global sender reputation after signal processing. The DynamoDB update returned an error. Reputation data may be stale for this domain.", { code: "processor.reputation_update_failed", signal: blockedSignal, thread, error: repResult.error });
      }
      const senderBlockCat = statusToMetric(blockStatus);
      if (senderBlockCat) {
        const statsResult = await this.accountDb.incrementStatMetric(accountId, senderBlockCat, 1, idempotencyKey);
        if (statsResult.isErr()) {
          this.logger.warn("Stats increment failed — dashboard may be slightly behind.", { code: "processor.stats_increment_failed", signal: blockedSignal, thread, error: statsResult.error });
        }
      }
      return ok(undefined);
    }

    const systemLabels = assignSystemLabels({
      workflow: classificationOutput.workflow,
      workflowData: classificationOutput.workflowData,
      actions: classificationOutput.actions,
      senderETLD1,
      aliasSenderConfig: effectiveAliasSenderConfig,
      unknownSenderPolicy: effectiveFilterMode,
      hasSentMessages: (thread.sentMessageIds?.length ?? 0) > 0,
    });

    for (const label of [...systemLabels, ...classificationOutput.labels]) {
      if (!thread.labels.includes(label)) thread.labels = [...thread.labels, label];
    }

    // Forwarded email detection — attach original:* label when forwarding headers are present
    const forwardedAddress = extractForwardedAddress(parsed.headers);
    if (forwardedAddress) {
      const forwardLabel = `original:${forwardedAddress}`;
      if (!thread.labels.includes(forwardLabel)) {
        thread.labels = [...thread.labels, forwardLabel];
      }
    }

    // 9. Build signal shell
    const signalShell = buildSignal({
      threadId: thread.id,
      status: "active",
      accountId,
      compositeMailMessageId: msg.compositeMailMessageId,
      recipientAddress,
      parsed,
      classification: classificationOutput,
      s3Key,
      receivedAt: timestamp,
      now,
      retentionDuration: effectiveRetentionForTtl,
      ...(ttl !== undefined ? { ttl } : {}),
      ...(gsi3pk !== undefined ? { gsi3pk } : {}),
      ...(opts?.forceSignalId !== undefined ? { forceSignalId: opts.forceSignalId } : {}),
    }, this.logger);

    // 10. Evaluate all rules (system rules seeded at low position numbers, user rules at higher positions)
    const rulesResult = await this.accountDb.listEnabledRules(accountId);
    if (rulesResult.isErr()) return err(rulesResult.error);
    const rules = rulesResult.value;
    const matchedRules = await applyRules(rules, { signal: signalShell, thread, isMatchedThread }, this.ruleEvaluator, this.logger, (s) => this.threadDb.saveSignal(s));
    const outcome = deriveOutcome(matchedRules);
    this.logger.trackPoint("rules_evaluated", { matchedRuleCount: matchedRules.length });

    // Propagate assign_workflow to signal data — the signal should reflect the final workflow after all rules
    const finalWorkflowAction = matchedRules
      .flatMap(r => r.actions)
      .slice().reverse().find(a => a.type === "assign_workflow" && a.value);
    if (finalWorkflowAction?.value) {
      signalShell.data.workflow = finalWorkflowAction.value as Workflow;
      signalShell.data.workflowData = { workflow: finalWorkflowAction.value } as WorkflowData;
    }

    // Fallback: if no rule set a status, apply filter mode for untrusted senders
    const hasStatusOutcome = outcome.blockDisposition !== null || outcome.quarantine || outcome.archive;
    if (!hasStatusOutcome && thread.labels.includes("system:sender:untrusted")) {
      switch (effectiveFilterMode) {
        case "block_hidden":       outcome.blockDisposition = "block_hidden"; break;
        case "block_reject":       outcome.blockDisposition = "block_reject"; break;
        case "report_violation":     outcome.blockDisposition = "report_violation"; break;
        case "quarantine_hidden":  outcome.quarantine = true; outcome.quarantineHidden = true; break;
        case "quarantine_visible": outcome.quarantine = true; break;
        // "allow_all": signal proceeds as active
      }
      // SR-00: synthetic rule explaining why the unknown sender policy triggered
      if (effectiveFilterMode !== "allow_all") {
        const policySource = aliasConfig ? `alias ${recipientAddress}` : "account default";
        const ACTION_MAP = { quarantine_visible: "quarantine_visible", quarantine_hidden: "quarantine_hidden", block_hidden: "block_hidden", block_reject: "block_reject", report_violation: "block_reject" } as const;
        const sr00StatusChange = outcome.quarantineHidden ? "quarantine_hidden" as const : outcome.quarantine ? "quarantine_visible" as const : outcome.blockDisposition;
        matchedRules.push({
          ruleId: "SR-00",
          actions: [{ type: ACTION_MAP[effectiveFilterMode as keyof typeof ACTION_MAP] }],
          labelsAdded: [],
          ...(sr00StatusChange ? { statusChange: sr00StatusChange } : {}),
          text: `Sender ${senderETLD1} is not in approved senders (${policySource} policy: ${effectiveFilterMode})`,
        });
      }
    }

    const buildArgs = { accountId, compositeMailMessageId: msg.compositeMailMessageId, recipientAddress, parsed, classification: classificationOutput, s3Key, receivedAt: timestamp, now, retentionDuration: effectiveRetentionForTtl, ...(ttl !== undefined ? { ttl } : {}), ...(gsi3pk !== undefined ? { gsi3pk } : {}), ...(opts?.forceSignalId !== undefined ? { forceSignalId: opts.forceSignalId } : {}) };

    if (outcome.blockDisposition) {
      const blockSignal = buildSignal({ status: outcome.blockDisposition, ...buildArgs }, this.logger);
      const saveResult = await this.threadDb.saveSignal({ ...blockSignal, data: { ...blockSignal.data, matchedRules } });
      if (saveResult.isErr()) return err(saveResult.error);
      this.logger.track(`Blocked email — rule matched with block disposition. accountId=${accountId}, signalId=${blockSignal.id}, alias=${recipientAddress}, subject="${parsed.subject}", sender=${parsed.from.address}`, { code: "processor.rule_block", signal: blockSignal, thread, disposition: outcome.blockDisposition, matchedRules: matchedRules.map(r => r.ruleId) });
      const repResult = await this.processingDb.updateGlobalReputation(senderETLD1, outcome.blockDisposition);
      if (repResult.isErr()) {
        this.logger.warn("Failed to update global sender reputation after signal processing. The DynamoDB update returned an error. Reputation data may be stale for this domain.", { code: "processor.reputation_update_failed", signal: blockSignal, thread, error: repResult.error });
      }
      const blockCat = statusToMetric(outcome.blockDisposition);
      if (blockCat) {
        const statsResult = await this.accountDb.incrementStatMetric(accountId, blockCat, 1, idempotencyKey);
        if (statsResult.isErr()) {
          this.logger.warn("Stats increment failed — dashboard may be slightly behind.", { code: "processor.stats_increment_failed", signal: blockSignal, thread, error: statsResult.error });
        }
      }
      return ok(undefined);
    }

    // approveSender overrides quarantine — SR-01 (auto-approve on matched conversation) fires before SR-03/SR-04
    if (outcome.quarantine && !outcome.approveSender) {
      const quarantineStatus = outcome.quarantineHidden ? "quarantine_hidden" : "quarantine_visible";
      const quarantineBase = buildSignal({ status: quarantineStatus, ...buildArgs }, this.logger);
      // Persist the thread the matcher resolved so approving this quarantined signal reattaches
      // to it instead of creating a duplicate. Only record an existing thread — a fresh shell is
      // not persisted here, so the approval path creates the thread itself when there is no match.
      const quarantinedSignal: Signal = { ...quarantineBase, data: { ...quarantineBase.data, matchedRules, ...(isMatchedThread ? { matchedThreadId: thread.id } : {}) } };
      const saveResult = await this.threadDb.saveSignal(quarantinedSignal);
      if (saveResult.isErr()) return err(saveResult.error);
      this.logger.info("Quarantined email — rule or sender filter matched.", { code: "processor.quarantine", accountId, threadId: thread.id, signalId: quarantinedSignal.id, status: quarantineStatus, matchedRules: matchedRules.map(r => r.ruleId) });
      const repResult = await this.processingDb.updateGlobalReputation(senderETLD1, quarantineStatus);
      if (repResult.isErr()) {
        this.logger.warn("Failed to update global sender reputation after signal processing. The DynamoDB update returned an error. Reputation data may be stale for this domain.", { code: "processor.reputation_update_failed", signal: quarantinedSignal, thread, error: repResult.error });
      }
      const quarantineCat = statusToMetric(quarantineStatus);
      if (quarantineCat) {
        const statsResult = await this.accountDb.incrementStatMetric(accountId, quarantineCat, 1, idempotencyKey);
        if (statsResult.isErr()) {
          this.logger.warn("Stats increment failed — dashboard may be slightly behind.", { code: "processor.stats_increment_failed", signal: quarantinedSignal, thread, error: statsResult.error });
        }
      }
      return ok(undefined);
    }

    // Auto-approve: record the sender allow when approve_sender fires or allow_all mode is active.
    // The alias itself is guaranteed to exist by the invariant near the top of the pipeline.
    if (outcome.approveSender || effectiveFilterMode === "allow_all") {
      const approveResult = await this.accountDb.saveSender(accountId, recipientAddress, senderETLD1, "allow");
      if (approveResult.isErr()) return err(approveResult.error);
    }

    // 11. Apply outcome to thread
    // Always set lastSignalAt — reactivation semantics (a new signal always updates recency)
    thread.lastSignalAt = timestamp;

    for (const label of outcome.additionalLabels) {
      if (!thread.labels.includes(label)) thread.labels = [...thread.labels, label];
    }

    const signalUrgency = outcome.urgency ?? thread.urgency ?? "normal";
    if (!matchedThread) thread.urgency = signalUrgency;

    const signal: Signal = { ...signalShell, threadId: thread.id, data: { ...signalShell.data, matchedRules, urgency: signalUrgency } };
    this.logger.trackPoint("thread_updated", { threadId: thread.id });

    // 12. Pong — handled entirely in side-effect SQS handler (processSideEffect)

    // Phase 2: Secondary embeddings (warn-only) — best-effort population of write-ahead indexes
    const secondaryResults = await this.embeddingGenerator.generateForSecondaryClusters(embedText);
    for (const result of secondaryResults) {
      if (result.isErr()) {
        this.logger.warn("Secondary embedding generation failed. We will run the full re-index anyway before switching over — revalidate all WARNINGS to check for failures in generating Aurora embeddings.", { code: "embedding.secondary_failed", signal, thread, modelId: result.error.modelId, error: result.error });
      }
    }

    // Compose the embeddings map from primary + successful secondary results.
    // This is set on the signal BEFORE save so the DynamoDB cache is populated
    // regardless of whether subsequent Aurora writes succeed or fail.
    const embeddings: Record<string, number[]> = { [primaryResult.value.modelId]: primaryResult.value.vector };
    for (const result of secondaryResults) {
      if (result.isOk()) embeddings[result.value.modelId] = result.value.vector;
    }
    signal.data.embeddings = embeddings;

    // Save thread (leaf node) before signal (dependent node) — guarantees thread exists whenever signal exists
    if (matchedThread) {
      // Reactivate — a new signal always brings the thread back to active (unless a rule archives it)
      thread.status = "active";
      if (outcome.archive) thread.status = "archived";

      // Compute optional field delta
      const fields: UpdateThreadFields = {};
      if (thread.summary !== matchedThread.summary) fields.summary = thread.summary;
      if (thread.workflow !== matchedThread.workflow) fields.workflow = thread.workflow;
      if (thread.urgency !== undefined && thread.urgency !== matchedThread.urgency) fields.urgency = thread.urgency;
      if (thread.retentionDuration !== undefined && thread.retentionDuration !== matchedThread.retentionDuration) fields.retentionDuration = thread.retentionDuration;
      if (JSON.stringify(thread.labels) !== JSON.stringify(matchedThread.labels)) fields.labels = thread.labels;
      if (thread.sentMessageIds !== undefined && JSON.stringify(thread.sentMessageIds) !== JSON.stringify(matchedThread.sentMessageIds)) fields.sentMessageIds = thread.sentMessageIds;
      // Always update denormalized display fields from the latest inbound signal
      if (thread.sender !== undefined) fields.sender = thread.sender;
      if (thread.recipientAddress !== undefined) fields.recipientAddress = thread.recipientAddress;
      if (thread.subject !== undefined) fields.subject = thread.subject;

      // Clear followupAt when reactivating — signals the snooze was cancelled by new mail
      if (matchedThread.status === "archived" && thread.status === "active" && matchedThread.followupAt) {
        fields.followupAt = "";
      }

      const updateResult = await this.threadDb.updateThread(accountId, thread.id, thread.status, thread.lastSignalAt, fields);
      if (updateResult.isErr()) return err(updateResult.error);
    } else {
      if (outcome.archive) thread.status = "archived";
      const saveThreadResult = await this.threadDb.saveThread(thread);
      if (saveThreadResult.isErr()) return err(saveThreadResult.error);
      this.logger.info("New thread created.", { code: "processor.thread_created", threadId: thread.id, accountId, signalId: signal.id, compositeMailMessageId: msg.compositeMailMessageId, ...(groupingKey ? { groupingKey } : {}) });
    }
    this.logger.trackPoint("thread_saved", { threadId: thread.id });

    const saveSignalResult = await this.threadDb.saveSignal(signal);
    if (saveSignalResult.isErr()) return err(saveSignalResult.error);
    this.logger.trackPoint("signal_saved", { signalId: signal.id, threadId: thread.id });

    // Resource upsert — best-effort, derived read-model only. A failure here must not
    // fail the signal ingest or trigger an SQS retry (unlike the thread/signal saves above).
    const resourceInfo = deriveResourceInfo(signal.data.workflow, signal.data.workflowData, account?.timezone ?? "Europe/London");
    if (resourceInfo) {
      const extractedAssets: import("../types/index.js").ResourceAsset[] = sanitizerAssets.map(a => ({
        type: a.type, label: a.label, rawValue: a.rawValue, sourceSignalId: signal.id,
        extractedAt: new Date().toISOString(),
        ...(a.s3Key ? { s3Key: a.s3Key } : {}),
      }));
      const allAssets = [...resourceInfo.assets, ...extractedAssets];
      // Resource TTL always has a floor of expectedResolutionDate + 1 year — a resource must
      // outlive its own due date regardless of the signal's own retention (which may be shorter,
      // or absent entirely for unlimited-retention accounts).
      const resourceTtlFloor = Math.floor(DateTime.fromISO(resourceInfo.expectedResolutionDate).toSeconds()) + 365 * 24 * 60 * 60;
      const resourceTtl = ttl !== undefined ? Math.max(ttl, resourceTtlFloor) : resourceTtlFloor;
      const resourceResult = await this.resourceDb.saveResource({
        accountId,
        threadId: thread.id,
        workflow: signal.data.workflow,
        resourceKey: resourceInfo.resourceKey,
        expectedResolutionDate: resourceInfo.expectedResolutionDate,
        displayDate: resourceInfo.displayDate,
        ttl: resourceTtl,
        ...(allAssets.length > 0 ? { assets: allAssets } : {}),
      });
      if (resourceResult.isErr()) {
        this.logger.error(`Resource save failed: ${resourceResult.error.message}`, { code: "processor.resource_save_failed", threadId: thread.id, workflow: signal.data.workflow, error: resourceResult.error });
      }
      this.logger.trackPoint("resource_saved", { threadId: thread.id, workflow: signal.data.workflow, status: resourceResult.isOk() ? resourceResult.value.status : null });
    }

    const allowedCat = statusToMetric(signal.status);
    if (allowedCat) {
      const statsResult = await this.accountDb.incrementStatMetric(accountId, allowedCat, 1, idempotencyKey);
      if (statsResult.isErr()) {
        this.logger.warn("Stats increment failed — dashboard may be slightly behind.", { code: "processor.stats_increment_failed", signal, thread, error: statsResult.error });
      }
    }

    // 12b. Calendar attachment processing — detect .ics, parse, create calendar signal
    // Unexpected exceptions propagate to the caller (SQS retry). Only IcsParseError is caught.
    await this.processCalendarAttachment(signal, thread, accountId, ttl);

    // 13. S3 retention — best-effort (idempotent, failure means default lifecycle applies instead of plan-specific)
    await this.attemptS3Retention(signal, billingPlan, thread);

    // 14. Aurora upserts — gates side-effect dispatch. All clusters must succeed.
    const auroraResult = await this.executeAuroraUpserts(signal, thread);
    if (auroraResult.isErr()) return err(dbError(new Error("Aurora upsert failed")));

    // Dispatch side-effects via SQS after Aurora succeeds
    const dispatchResult = await this.dispatchSideEffects(signal, thread);
    if (dispatchResult.isErr()) return err(dbError(new Error("Side-effect dispatch failed")));

    // Side-effects (forward, auto-reply, auto-draft, notify) are handled by processSideEffect via SQS dispatch.

    return ok(undefined);
  }

  /**
   * Execute Aurora inserts for all active clusters in parallel.
   * Returns ok if ALL clusters succeed, err if ANY cluster fails.
   * Logs ERROR for primary cluster failures, WARN for non-primary.
   * Inserts one row per signal per cluster — duplicates are prevented by the composite PK including signalId.
   */
  async executeAuroraUpserts(signal: Signal, thread: Thread): Promise<Result<void, DbError>> {
    const activeClusters = getActiveClusters();
    this.logger.trackPoint("aurora_upsert_start", { clusterCount: activeClusters.length });

    const results = await Promise.all(
      activeClusters.map(async (cluster) => {
        const embedding = signal.data.embeddings?.[cluster.modelId];
        if (!embedding) {
          this.logger.info("Aurora upsert skipped for cluster — no embedding available for the cluster's model. This is expected when the embedding generator did not produce a vector for this model (e.g. Bedrock failure for that model).", { code: "processor.aurora_upsert_skipped", accountId: signal.accountId, signalId: signal.id, threadId: thread.id, registryId: cluster.registryId, modelId: cluster.modelId });
          return ok({ cluster }) as Result<{ cluster: typeof cluster }, DbError & { cluster: typeof cluster }>;
        }

        const upsertResult = await this.auroraWriter.upsertEmbedding({
          registryId: cluster.registryId,
          threadId: thread.id,
          accountId: signal.accountId,
          recipientAddress: signal.data.recipientAddress,
          embedding,
          signalId: signal.id,
          ...(signal.ttl != null ? { ttl: signal.ttl } : {}),
        });

        if (upsertResult.isErr()) {
          return err({ ...upsertResult.error, cluster }) as Result<{ cluster: typeof cluster }, DbError & { cluster: typeof cluster }>;
        }
        this.logger.trackPoint("aurora_upsert_cluster_complete", { registryId: cluster.registryId });
        return ok({ cluster }) as Result<{ cluster: typeof cluster }, DbError & { cluster: typeof cluster }>;
      }),
    );

    const failures = results.filter((r) => r.isErr());
    if (failures.length > 0) {
      for (const failure of failures) {
        const e = failure._unsafeUnwrapErr();
        if (e.schemaMismatch) {
          this.logger.error(`Failed to upsert embedding to Aurora cluster — schema mismatch. The cluster is healthy but its table shape does not match the code: ${e.message}. This is a migration problem, not a cluster-health problem — the applied migrations in src/migrations are behind src/database/schema.ts, or a migration failed to apply. Retrying will not help until the migration is applied.`, { code: "processor.aurora_upsert_schema_mismatch", signal, thread, registryId: e.cluster.registryId, dbMessage: e.message, error: e });
        } else {
          this.logger.error(`Failed to upsert embedding to Aurora cluster. The Data API call returned an error for the target cluster: ${e.message}. This signal's embedding won't be searchable on that cluster until the next retry succeeds. Check Aurora cluster health in the AWS console.`, { code: "processor.aurora_upsert_failed", signal, thread, registryId: e.cluster.registryId, dbMessage: e.message, error: e });
        }
      }
      return err(dbError("Aurora upsert failed for one or more clusters"));
    }

    this.logger.trackPoint("aurora_upsert_all_complete");
    return ok(undefined);
  }

  /**
   * Dispatch side-effects as a separate SQS message after Aurora upserts succeed.
   * If the SQS send fails, returns err — this causes a batchItemFailure so the
   * message is retried (Aurora succeeded but side-effects won't fire without dispatch).
   */
  async dispatchSideEffects(signal: Signal, thread: Thread): Promise<Result<void, DbError>> {
    this.logger.trackPoint("side_effect_dispatch_start");
    const payload: SideEffectPayload = { signal, thread };
    const sendResult = await this.sqsDispatcher.sendMessage(payload);
    if (sendResult.isErr()) {
      this.logger.error(`Failed to dispatch side-effect SQS message — side-effects won't fire until retry succeeds: ${sendResult.error.message}`, { code: "processor.side_effect_dispatch_failed", signal, thread, error: sendResult.error });
      return err(sendResult.error);
    }

    this.logger.info("Side-effect SQS message dispatched.", { code: "processor.side_effect_dispatched", signalId: signal.id, threadId: thread.id, accountId: signal.accountId });
    this.logger.trackPoint("side_effect_dispatch_complete");
    return ok(undefined);
  }

  /**
   * Best-effort S3 retention. Always attempted on every delivery (idempotent).
   * Errors are logged at warn level and never propagate — S3 retention failure
   * means the default 5-year lifecycle rule applies instead of the plan-specific policy.
   */
  async attemptS3Retention(signal: Signal, billingPlan: BillingPlan, thread: Thread): Promise<void> {
    // The SYSTEM account only ever holds throwaway healthcheck emails, expired by
    // the P7D TTL and the default lifecycle rule. Never tag or copy-to-saved them —
    // preserving daily healthcheck mail indefinitely is pure junk accumulation.
    if (isSystemAccount(signal.accountId)) return;

    this.logger.trackPoint("s3_retention_start");
    try {
      const retention = getRetentionForPlan(billingPlan);
      let retentionApplyResult: Result<{ s3Key: string }, DbError>;
      try {
        const retentionValue = await this.retentionService.applyPlanRetention(signal.data.s3Key, {
          s3Tag: retention.s3Tag,
          copyToSaved: retention.copyToSaved,
        });
        retentionApplyResult = ok(retentionValue);
      } catch (e) {
        retentionApplyResult = err(dbError(e));
      }
      if (retentionApplyResult.isErr()) {
        this.logger.warn("Failed to apply S3 retention policy to signal object. The S3 tagging or copy operation returned an error. The signal is saved but will use the default 5-year lifecycle rule instead of the plan-specific retention.", { code: "processor.s3_retention_failed", signal, thread, error: retentionApplyResult.error });
        return;
      }

      // The stored s3Key always points at emails/{key}; copy-to-saved keeps a
      // durable saved/ copy that readers resolve by age. No signal write needed.
      this.logger.trackPoint("s3_retention_complete");
    } catch (e) {
      this.logger.warn("S3 retention threw an unexpected error. The signal will use the default lifecycle rule. Processing continues unaffected.", { code: "processor.s3_retention_unexpected", signal, thread, error: e });
    }
  }

  /**
   * Detect and process calendar (.ics) attachments on an email signal.
   *
   * On valid parse: creates a calendar signal (source: "signal", type: "calendar_event"),
   * stores raw .ics as S3 attachment, applies system:calendar label to the thread.
   *
   * On parse rejection (IcsParseError): creates a calendar_invite_invalid signal with reason.
   *
   * On unexpected crash: does NOT catch — lets the exception propagate so SQS retries naturally.
   */
  private async processCalendarAttachment(signal: Signal, thread: Thread, accountId: string, ttl?: number): Promise<void> {
    const attachments = signal.data.attachments ?? [];
    const calendarAttachment = findCalendarAttachment(attachments, this.logger);
    if (!calendarAttachment) return;

    this.logger.trackPoint("calendar_attachment_found", { filename: calendarAttachment.filename, mimeType: calendarAttachment.mimeType });

    // Fetch .ics bytes from content store
    const icsBytes = await this.contentStore.getContent(calendarAttachment.s3Key);

    // Parse .ics
    const parseResult = parseIcs(new Uint8Array(icsBytes));

    if (parseResult.isErr()) {
      // Parse rejection — create calendar_invite_invalid signal
      const invalidId = generateId("sgn-");
      const invalidTimestamp = DateTime.utc().toISO()!;
      const invalidSignal: Signal<CalendarInviteInvalidData> = {
        id: invalidId,
        signalLookupId: invalidId,
        threadId: thread.id,
        accountId,
        source: "signal",
        type: "calendar_invite_invalid",
        status: "active",
        labels: [],
        createdAt: invalidTimestamp,
        ...(ttl !== undefined ? { ttl } : {}),
        data: {
          reason: parseResult.error.reason,
          linkedSignalId: signal.id,
        },
      };
      const saveInvalidResult = await this.threadDb.saveSignal(invalidSignal);
      if (saveInvalidResult.isErr()) {
        this.logger.warn("Failed to save calendar_invite_invalid signal.", { code: "system_signal.write_failed", signal, thread, accountId, type: "calendar_invite_invalid", error: saveInvalidResult.error });
      }
      this.logger.warn("Calendar attachment rejected by ICS parser.", { code: "processor.calendar.parse_rejected", signal, thread, reason: parseResult.error.reason });
      return;
    }

    // Valid parse — create calendar signal
    const { calendarData, rawIcsContent } = parseResult.value;
    const calendarSignalId = generateId("sgn-");
    const calendarTimestamp = DateTime.utc().toISO()!;
    const signalLookupId = buildCalendarSignalLookupId(calendarData.organizer, calendarData.veventUid);

    // Store raw .ics as S3 attachment on the calendar signal
    const icsS3Key = `content/accounts/${accountId}/calendar/${calendarSignalId}/invite.ics`;
    await this.contentStore.saveIcsContentAsCalendar(icsS3Key, rawIcsContent);

    // Build calendar signal with linkedSignalId pointing to the email signal
    const calendarSignal: Signal<CalendarEventData> = {
      id: calendarSignalId,
      signalLookupId,
      threadId: thread.id,
      accountId,
      source: "signal",
      type: "calendar_event",
      status: "active",
      labels: [],
      createdAt: calendarTimestamp,
      ...(ttl !== undefined ? { ttl } : {}),
      data: {
        ...calendarData,
        linkedSignalId: signal.id,
      },
    };

    const saveCalResult = await this.threadDb.saveSignal(calendarSignal);
    if (saveCalResult.isErr()) {
      this.logger.warn("Failed to save calendar_event signal.", { code: "system_signal.write_failed", signal, thread, accountId, type: "calendar_event", error: saveCalResult.error });
      return;
    }

    // Apply system:calendar label to the thread
    if (!thread.labels.includes("system:calendar")) {
      thread.labels = [...thread.labels, "system:calendar"];
      const updateResult = await this.threadDb.updateThread(accountId, thread.id, thread.status, thread.lastSignalAt!, { labels: thread.labels });
      if (updateResult.isErr()) {
        this.logger.warn("Failed to apply system:calendar label to thread.", { code: "processor.calendar.label_failed", signal, thread, error: updateResult.error });
      }
    }

    // Schedule a day-of reminder if event startTime is in the future
    if (calendarData.startTime) {
      const eventStart = DateTime.fromISO(calendarData.startTime, { zone: "utc" });
      const now = DateTime.utc();
      if (eventStart.isValid && eventStart > now) {
        const fireAt = eventStart.startOf("day").set({ hour: 8 }).toISO()!;
        const suffix = `calendar.${eventStart.toFormat("yyyyMMdd")}`;
        const scheduleResult = await this.schedulerClient.createFollowup({
          accountId,
          threadId: thread.id,
          scheduleKeyId: calendarSignalId,
          fireAt,
          suffix,
          sqsMessageAttributeMessageType: "signal_followup",
        });
        if (scheduleResult.isErr()) {
          this.logger.error(`Failed to create calendar day-of schedule: ${scheduleResult.error.message}`, { code: "processor.calendar.schedule_failed", signal, thread, calendarSignalId, fireAt, error: scheduleResult.error });
        }
      }
    }

    // Schedule an RSVP reminder 24h before event start (only for REQUEST invites)
    if (calendarData.method?.toUpperCase() === "REQUEST") {
      if (!calendarData.startTime) {
        this.logger.warn("Calendar REQUEST missing startTime — skipping RSVP schedule.", { code: "processor.calendar.rsvp_missing_start_time", signal, thread });
      } else {
        const eventStart = DateTime.fromISO(calendarData.startTime, { zone: "utc" });
        if (!eventStart.isValid) {
          this.logger.warn("Calendar REQUEST has invalid startTime — skipping RSVP schedule.", { code: "processor.calendar.rsvp_invalid_start_time", signal, thread, startTime: calendarData.startTime });
        } else {
          const now = DateTime.utc();
          const reminderTime = eventStart.minus({ hours: RSVP_REMINDER_HOURS_BEFORE });
          if (reminderTime > now) {
            const fireAt = reminderTime.toISO()!;
            const suffix = `rsvp.${eventStart.toFormat("yyyyMMdd")}`;
            const rsvpResult = await this.schedulerClient.createFollowup({
              accountId,
              threadId: thread.id,
              scheduleKeyId: calendarSignalId,
              fireAt,
              suffix,
              sqsMessageAttributeMessageType: "rsvp_reminder",
            });
            if (rsvpResult.isErr()) {
              this.logger.error(`Failed to create RSVP reminder schedule: ${rsvpResult.error.message}`, {
                code: "processor.calendar.rsvp_schedule_failed",
                signal, thread, calendarSignalId, fireAt,
                error: rsvpResult.error,
              });
            }
          }
        }
      }
    }

    // Inject forwardCalendarInvite action into the signal's matchedRules so the
    // side-effect handler triggers forwarding. The system rule (SR-19) won't match
    // on the first signal because the label is applied after rule evaluation.
    const existingRules = signal.data.matchedRules ?? [];
    const hasCalendarForward = existingRules.some(r => r.actions.some(a => a.type === "forwardCalendarInvite"));
    if (!hasCalendarForward) {
      signal.data.matchedRules = [
        ...existingRules,
        { ruleId: "SR-19", actions: [{ type: "forwardCalendarInvite" }], labelsAdded: [] },
      ];
    }

    this.logger.info("Calendar signal created from .ics attachment.", { code: "processor.calendar.signal_created", accountId, threadId: thread.id, signalId: signal.id, calendarSignalId, method: calendarData.method, veventUid: calendarData.veventUid });
    this.logger.trackPoint("calendar_signal_created", { calendarSignalId });
  }

  // ---------------------------------------------------------------------------
  // Reprocess — thin wrapper that calls processMessage with force flags
  // ---------------------------------------------------------------------------

  async reprocessSignal(accountId: string, signalId: string, threadId: string): Promise<Result<Signal, ProcessorError | NotFoundError>> {
    const existingResult = await this.threadDb.getSignalById(accountId, signalId, threadId);
    if (existingResult.isErr()) return err(processorError(existingResult.error));
    const existing = existingResult.value;
    if (!existing) return err(notFoundError("signal", signalId));
    if (existing.type !== "email") return err(processorError("Only email signals can be reprocessed"));

    const s3Key = existing.data.s3Key;
    if (!s3Key) return err(processorError("Signal has no s3Key — cannot reprocess"));

    const compositeMailMessageId = existing.signalLookupId;
    const recipientAddress = existing.data.recipientAddress;
    const timestamp = existing.data.receivedAt ?? existing.createdAt;

    // Pre-process cleanup: if this is the only signal on the source thread, the thread
    // will be empty after reprocessing moves it. Delete embeddings from Aurora (prevents
    // future vector matches to an empty thread) and set a 5-year TTL if absent.
    const otherSignalsResult = await this.threadDb.listSignals(accountId, threadId, { limit: 2 });
    if (otherSignalsResult.isOk()) {
      const otherSignals = otherSignalsResult.value.items.filter(s => s.id !== signalId);
      if (otherSignals.length === 0) {
        const deleteEmbResult = await this.threadMatcher.deleteEmbeddingsForThread(accountId, threadId);
        if (deleteEmbResult.isErr()) {
          this.logger.warn("Failed to delete embeddings for thread being emptied by reprocess.", { code: "processor.reprocess.pre_embedding_cleanup_failed", accountId, threadId, error: deleteEmbResult.error });
        }

        const threadResult = await this.threadDb.getThread(accountId, threadId);
        if (threadResult.isOk() && threadResult.value && !threadResult.value.ttl) {
          const fiveYearsTtl = Math.floor(Date.now() / 1000) + (5 * 365 * 24 * 60 * 60);
          const ttlResult = await this.threadDb.setThreadTtl(accountId, threadId, fiveYearsTtl);
          if (ttlResult.isErr()) {
            this.logger.warn("Failed to set 5-year TTL on thread being emptied by reprocess.", { code: "processor.reprocess.pre_ttl_set_failed", accountId, threadId, error: ttlResult.error });
          }
        }
      }
    }

    // Pass the admin-supplied accountId as expectedAccountId only — processMessage
    // re-derives the owning account from the recipient address (and tracks a mismatch).
    const msg: InboundSignalMessage = {
      expectedAccountId: accountId,
      s3Key,
      compositeMailMessageId,
      idempotencyKey: existing.id,
      timestamp,
      destination: [recipientAddress],
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
    };

    const result = await this.processInbound(msg, 1, { force: true, unsafeSkipDmarc: true, forceSignalId: existing.id });
    if (result.isErr()) {
      // Best-effort recency repair even on failure — a previous 504 may have saved the thread
      // with updated lastSignalAt while the signal save never completed.
      await this.repairThreadRecency(accountId, threadId);
      return err(processorError(result.error));
    }

    // Re-fetch by primary key — reprocessing may reassign the signal to a different
    // thread, so the gsi1-based getSignalById (scoped to the original threadId) would miss it.
    const freshResult = await this.threadDb.getSignalByMessageId(accountId, compositeMailMessageId);
    if (freshResult.isErr()) return err(processorError(freshResult.error));
    if (!freshResult.value) return err(processorError("Signal not found after reprocess"));

    // Always repair the source thread's recency — even if the signal stayed on the same thread,
    // a partial prior invocation (504) may have left lastSignalAt pointing at stale data.
    await this.repairThreadRecency(accountId, threadId);

    return ok(freshResult.value);
  }

  /** Recompute a thread's lastSignalAt from its remaining signals (epoch if it has none left). */
  private async repairThreadRecency(accountId: string, threadId: string): Promise<void> {
    const EPOCH = new Date(0).toISOString(); // 1970-01-01T00:00:00.000Z
    const threadResult = await this.threadDb.getThread(accountId, threadId);
    if (threadResult.isErr() || !threadResult.value) {
      if (threadResult.isErr()) this.logger.warn("Could not load thread to repair recency after reprocess.", { code: "processor.reprocess.recency_thread_lookup_failed", accountId, threadId, error: threadResult.error });
      return;
    }
    const thread = threadResult.value;

    // Signals are ordered newest-first (gsi1sk = time-sortable UUIDv7 id); take the max
    // receivedAt over a page to stay correct even if a reprocessed signal carries a backdated one.
    const signalsResult = await this.threadDb.listSignals(accountId, threadId, { limit: 50 });
    if (signalsResult.isErr()) {
      this.logger.warn("Could not list signals to repair thread recency after reprocess.", { code: "processor.reprocess.recency_list_failed", accountId, threadId, error: signalsResult.error });
      return;
    }
    const newLastSignalAt = signalsResult.value.items.reduce<string>((max, s) => {
      const t = s.data.receivedAt ?? s.createdAt;
      return t > max ? t : max;
    }, "") || EPOCH;

    if (newLastSignalAt === thread.lastSignalAt) return;

    const updateResult = await this.threadDb.updateThread(accountId, threadId, thread.status, newLastSignalAt, {});
    if (updateResult.isErr()) {
      this.logger.warn("Could not update thread recency after reprocess.", { code: "processor.reprocess.recency_update_failed", accountId, threadId, newLastSignalAt, error: updateResult.error });
      return;
    }
    this.logger.info("Repaired thread recency after reprocess moved a signal off it.", { code: "processor.reprocess.recency_repaired", accountId, threadId, newLastSignalAt, emptied: signalsResult.value.items.length === 0 });
  }

  private async annotateTemplateError(accountId: string, templateId: string, functionName: string, error: { message: string; errorType: string } | null): Promise<void> {
    const errorMessage = error
      ? `[${error.errorType}] ${error.message}`
      : "Function returned no value";
    try {
      const annotateResult = await this.accountDb.annotateTemplateError(accountId, templateId, functionName, errorMessage);
      if (annotateResult.isErr()) { this.logger.warn("Failed to annotate template function error", { code: "processor.annotate_template_failed", accountId, templateId, functionName, error: annotateResult.error }); }
    } catch {
      // Best-effort — don't fail draft generation if annotation fails
      this.logger.track("Failed to annotate template function error.", { code: "processor.annotate_template_failed", accountId, templateId, functionName });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => vars[key.trim()] ?? "");
}

function parseAutoDraftValue(value: string): { templateId: string; autoSend: boolean } | null {
  try {
    const parsed = JSON.parse(value) as { templateId?: string; autoSend?: boolean };
    if (!parsed.templateId) return null;
    return { templateId: parsed.templateId, autoSend: parsed.autoSend ?? false };
  } catch {
    // Legacy format: bare template ID string (no autoSend)
    return { templateId: value, autoSend: false };
  }
}

// Derive unsubscribe info from RFC 2369 List-Unsubscribe and RFC 8058 List-Unsubscribe-Post headers
function parseUnsubscribeHeaders(headers: Record<string, string>): UnsubscribeInfo | undefined {
  const listUnsubscribe = headers["list-unsubscribe"];
  if (!listUnsubscribe) return undefined;

  const hasPost = Boolean(headers["list-unsubscribe-post"]);

  // Extract URLs from angle-bracket delimited list: <https://...>, <mailto:...>
  const urls: string[] = [];
  for (const match of listUnsubscribe.matchAll(/<([^>]+)>/g)) {
    if (match[1]) urls.push(match[1]);
  }

  const httpsUrl = urls.find(u => u.startsWith("https://"));
  const mailtoUrl = urls.find(u => u.startsWith("mailto:"));

  if (hasPost && httpsUrl) {
    return { type: "server", url: httpsUrl };
  }
  if (httpsUrl) {
    return { type: "website", url: httpsUrl };
  }
  if (mailtoUrl) {
    return { type: "mailto", url: mailtoUrl };
  }
  return undefined;
}

// Fallback: scan HTML body for an <a> element whose visible text or href contains
// "unsubscribe" (case-insensitive). Returns the least-trusted tier: type "website".
function parseUnsubscribeFromBody(htmlBody: string | null | undefined): UnsubscribeInfo | undefined {
  if (!htmlBody) return undefined;

  // Match <a href="...">...</a> — non-greedy, case-insensitive
  const anchorPattern = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(htmlBody)) !== null) {
    const href = match[1] ?? "";
    const text = (match[2] ?? "").replace(/<[^>]+>/g, "").trim();

    // Check if either the link text or the URL path contains "unsubscribe"
    const combined = (text + " " + href).toLowerCase();
    if (!combined.includes("unsubscribe")) continue;

    // Validate it's a real HTTPS URL
    try {
      const url = new URL(href);
      if (url.protocol === "https:" || url.protocol === "http:") {
        return { type: "website", url: href };
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// HTML truncation — cuts at closed block-level tags to preserve valid markup.
// Full content always recoverable from S3 via s3Key.
// ---------------------------------------------------------------------------
const MAX_HTML_BODY_BYTES = 300_000; // 300 KB — leaves ~100 KB headroom for rest of DDB item

function truncateHtml(html: string, maxBytes: number): { html: string; truncated: boolean } {
  const encoded = Buffer.byteLength(html, "utf-8");
  if (encoded <= maxBytes) return { html, truncated: false };

  // Find the last block-level close tag that ends within the byte budget
  const blockClosePattern = /<\/(div|tr|p|table|section|article|li|td|th|blockquote|header|footer)>/gi;
  let lastSafeCut = 0;
  let match: RegExpExecArray | null;
  while ((match = blockClosePattern.exec(html)) !== null) {
    const endPos = match.index + match[0].length;
    if (Buffer.byteLength(html.slice(0, endPos), "utf-8") <= maxBytes) {
      lastSafeCut = endPos;
    } else {
      break;
    }
  }

  // Fallback: if no block-level tag found within budget, cut at last '>' within estimated char boundary
  if (lastSafeCut === 0) {
    const estimatedCharPos = (html.length * (maxBytes / encoded)) | 0;
    lastSafeCut = html.lastIndexOf(">", estimatedCharPos);
    if (lastSafeCut <= 0) lastSafeCut = estimatedCharPos;
  }

  return { html: html.slice(0, lastSafeCut), truncated: true };
}

function buildSignal(opts: {
  threadId?: string;
  status: Signal["status"];
  accountId: string;
  compositeMailMessageId: string;
  recipientAddress: string;
  parsed: ParsedMime;
  classification: ClassificationOutput;
  s3Key: string;
  receivedAt: string;
  now: string;
  ttl?: number;
  retentionDuration?: RetentionDuration;
  gsi3pk?: string;
  forceSignalId?: string;
}, logger?: Logger): Signal<InboundEmailSignalData> {
  const { threadId, status, accountId, compositeMailMessageId, recipientAddress, parsed, classification, s3Key, receivedAt, now, ttl, retentionDuration, gsi3pk, forceSignalId } = opts;
  const signalId = forceSignalId ?? generateId("sgn-");

  // Extract unsubscribe info from List-Unsubscribe / List-Unsubscribe-Post headers,
  // falling back to scanning the HTML body for an unsubscribe link.
  const unsubscribe = parseUnsubscribeHeaders(parsed.headers) ?? parseUnsubscribeFromBody(parsed.htmlBody);

  // Truncate HTML body if it exceeds DDB item headroom
  let htmlBody = parsed.htmlBody ?? undefined;
  let htmlBodyTruncated = false;
  if (htmlBody != null) {
    const result = truncateHtml(htmlBody, MAX_HTML_BODY_BYTES);
    if (result.truncated) {
      const originalBytes = Buffer.byteLength(htmlBody, "utf-8");
      htmlBody = result.html;
      htmlBodyTruncated = true;
      logger?.track("HTML body truncated before DynamoDB storage — full content in S3.", {
        code: "processor.html_body_truncated",
        signalId,
        originalBytes,
        storedBytes: Buffer.byteLength(htmlBody, "utf-8"),
        s3Key,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Link overlap validation & dedup — ensure no URL appears in multiple classification buckets.
  // Priority: unsubscribe > workflowData URL fields > actions.
  // Lower-priority buckets have duplicates stripped; overlaps are logged as TRACK.
  // ---------------------------------------------------------------------------
  const classifiedUrls = new Map<string, string>(); // url → first bucket that claimed it
  if (unsubscribe) {
    classifiedUrls.set(unsubscribe.url, "unsubscribe");
  }

  const workflowDataUrlFields = ["trackingUrl", "downloadUrl", "managementUrl", "paymentUrl", "documentUrl", "portalUrl", "responseUrl", "ticketUrl", "actionUrl", "muteUrl"] as const;
  const workflowDataRecord = classification.workflowData as unknown as Record<string, unknown>;
  for (const field of workflowDataUrlFields) {
    const value = workflowDataRecord[field];
    if (typeof value !== "string") continue;
    const existing = classifiedUrls.get(value);
    if (existing) {
      logger?.track(`Link overlap: "${value}" already in ${existing}, also claimed by workflowData.${field}`, {
        code: "processor.link_overlap",
        url: value,
        existingBucket: existing,
        duplicateBucket: `workflowData.${field}`,
        signalId,
        accountId,
      });
    } else {
      classifiedUrls.set(value, `workflowData.${field}`);
    }
  }

  // Deduplicate actions — strip URLs already claimed by a higher-priority bucket
  const dedupedActions: typeof classification.actions = [];
  for (const action of classification.actions) {
    const existing = classifiedUrls.get(action.url);
    if (existing) {
      logger?.track(`Link overlap: "${action.url}" already in ${existing}, stripped from actions`, {
        code: "processor.link_overlap",
        url: action.url,
        existingBucket: existing,
        duplicateBucket: "actions",
        signalId,
        accountId,
      });
    } else {
      classifiedUrls.set(action.url, "actions");
      dedupedActions.push(action);
    }
  }

  const signal: Signal<InboundEmailSignalData> = {
    id: signalId,
    signalLookupId: compositeMailMessageId,
    accountId,
    source: "email",
    type: "email",
    status,
    labels: [],
    createdAt: now,
    data: {
      receivedAt,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject,
      attachments: parsed.attachments,
      headers: parsed.headers,
      recipientAddress,
      workflow: classification.workflow,
      workflowData: classification.workflowData,
      actions: dedupedActions,
      tags: classification.tags.slice(0, 50),
      summary: classification.summary,
      s3Key,
      ...(parsed.replyTo !== undefined ? { replyTo: parsed.replyTo } : {}),
      ...(htmlBody !== undefined ? { htmlBody } : {}),
      ...(htmlBodyTruncated ? { htmlBodyTruncated: true } : {}),
      ...(parsed.sentAt !== undefined ? { sentAt: parsed.sentAt } : {}),
      ...(unsubscribe !== undefined ? { unsubscribe } : {}),
      ...(parsed.inlineImages && parsed.inlineImages.length > 0 ? { inlineImages: parsed.inlineImages } : {}),
      ...(parsed.displayRawS3Key ? { displayRawS3Key: parsed.displayRawS3Key } : {}),
    },
  };

  if (threadId !== undefined) signal.threadId = threadId;
  if (ttl !== undefined) signal.ttl = ttl;
  if (retentionDuration !== undefined) signal.retentionDuration = retentionDuration;
  if (gsi3pk !== undefined) signal.gsi3pk = gsi3pk;

  return signal;
}

// TODO: task 6.1 — move to shared utility once processor body-resolution is refactored
function stripHtmlForClassifier(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Extracts the original recipient address from forwarding headers, in priority order.
// Header values may be bare addresses or RFC 2822 "Name <addr>" form.
export function extractForwardedAddress(headers: Record<string, string>): string | null {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const raw = lower["x-forwarded-to"] ?? lower["x-original-to"] ?? lower["resent-to"] ?? null;
  if (!raw) return null;
  const match = raw.match(/<([^>]+)>/) ?? raw.match(/([^\s,;]+@[^\s,;]+)/);
  return match?.[1]?.trim() ?? null;
}


