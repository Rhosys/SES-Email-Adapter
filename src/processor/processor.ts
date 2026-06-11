import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { DateTime } from "luxon";
import { generateId } from "../utils/id.js";
import type { Logger } from "../logger.js";
import type { Result } from "neverthrow";
import { ok, err, dbError, processorError, invalidResponseError } from "../errors.js";
import type { DbError, InvalidResponseError, ProcessorError } from "../errors.js";
import type { Signal, Arc, Rule, Workflow, WorkflowData, Alias, AliasSender, SenderPolicy, AccountFilteringConfig, SignalSource, SignalStatus, Domain, ArcStatus, ArcUrgency, UnknownSenderPolicy, MatchedRuleResult, InvalidRuleFunctionData, InvalidTemplateFunctionData, AutoSendBlockedData } from "../types/index.js";
import type { ParsedMime } from "./mime.js";
import type { ContentSanitizerClient } from "./content-sanitizer-client.js";
import type { UserCodeExecutorClient, TemplateParameterResult } from "./user-code-client.js";
import type { RuleEvalResult } from "./interpret-rule-result.js";
import { buildEmbedText } from "../embedding/embed-text.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import { RELEVANT_HEADERS } from "../classifier/prompt-builder.js";
import type { EmbeddingGenerator } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { ArcDatabase, UpdateArcFields } from "../database/arc-database.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { ProcessingDatabase } from "../database/processing-database.js";
import type { S3RetentionService } from "../embedding/s3-retention-service.js";
import { getRetentionForPlan, retentionDurationToSeconds } from "../embedding/retention-tier.js";
import type { BillingPlan } from "../embedding/retention-tier.js";
import { resolveRetention, retentionToS3Tag } from "./retention.js";
import type { RetentionDuration } from "./retention.js";
import { generatePresignedGet, generatePresignedPost } from "./presign.js";
import { getPrimaryArcMatcherRegistry, getActiveClusters } from "../embedding/cluster-registry.js";
import { getETLD1, assignSystemLabels, DEFAULT_SPAM_SCORE_THRESHOLD } from "./filter.js";
import { statusToCategory } from "../database/stats-writer.js";
import type { DraftSendDispatch } from "./draft-send-dispatcher.js";
import { isReplyTargetSafe } from "./reply-target-validator.js";
import { buildWebhookPayload, deliverWebhook } from "./webhook.js";
import { parseWebhookConfig } from "../api/validate-webhook-config.js";
import { BillingHandler } from "../billing/billing-handler.js";
import type { HandlerRegistry } from "../workflow/registry.js";
import { findCalendarAttachment, parseIcs } from "./calendar/ics-parser.js";
import { buildCalendarSignalLookupId } from "./calendar/signal-lookup.js";
import { forwardCalendarInvite } from "./calendar/calendar-forwarder.js";
import type { CalendarForwarderDeps } from "./calendar/calendar-forwarder.js";
import type { CalendarEventData, CalendarInviteInvalidData } from "../types/calendar.js";
import type { SchedulerClient } from "../scheduler/scheduler-client.js";
import { buildScheduleName } from "../scheduler/schedule-name.js";
import { RSVP_REMINDER_HOURS_BEFORE } from "../scheduler/rsvp-reminder.js";

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type ProcessorMessageType = "inbound_signal" | "side_effect";

export interface SideEffectPayload {
  signal: Signal;
  arc: Arc;
}

export interface SqsDispatcher {
  sendMessage(payload: SideEffectPayload): Promise<Result<void, DbError>>;
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ProcessorAccountContext {
  retentionDays: number;
  retentionDuration?: RetentionDuration;
  filtering: AccountFilteringConfig | null;
  emailConfig: Alias | null;
  registeredDomains: string[];
  userEmails: string[];
  billingPlan: BillingPlan;
  onboardingCompleted: boolean;
}

export interface ArcMatcher {
  findMatch(accountId: string, recipientAddress: string, embedding: number[]): Promise<Result<Arc | null, DbError>>;
  upsertEmbedding(arcId: string, embedding: number[], accountId: string, recipientAddress: string): Promise<Result<void, DbError>>;
}

export interface RuleEvaluator {
  evaluate(rule: Rule, context: { signal: Signal; arc: Arc; isMatchedArc: boolean }): Promise<RuleEvalResult>;
}

export interface Notifier {
  notify(accountId: string, arc: Arc, signal: Signal, urgency: ArcUrgency): Promise<Result<void, DbError>>;
}

export interface Forwarder {
  forward(
    s3Key: string,
    toAddress: string,
    accountId: string,
    opts?: { signalId?: string; arcId?: string },
  ): Promise<Result<void, DbError>>;
}

export interface ReplySender {
  sendReply(opts: {
    to: string;
    from: string;
    subject: string;
    body: string;
    inReplyTo: string;
    accountId?: string;
    signalId?: string;
    arcId?: string;
  }): Promise<{ messageId: string }>;
}

export type SesVerdict = "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED";

interface SesReceiptNotification {
  mail: {
    messageId: string;
    timestamp: string;
    destination: string[];
  };
  receipt: {
    recipients: string[];
    dkimVerdict: { status: SesVerdict };
    dmarcVerdict: { status: SesVerdict };
    action: { bucketName: string; objectKey: string };
  };
}

export interface InboundSignalMessage {
  accountId: string;
  s3Key: string;
  sesMessageId: string;
  timestamp: string;
  destination: string[];
  dkimVerdict: SesVerdict;
  dmarcVerdict: SesVerdict;
}

// ---------------------------------------------------------------------------
// Processing outcome
// ---------------------------------------------------------------------------

interface ProcessingOutcome {
  blockDisposition: "block_hidden" | "block_reject" | "violate_report" | null;
  quarantine: boolean;
  quarantineHidden: boolean;  // true → quarantine_hidden status; false → quarantine_visible
  approveSender: boolean;
  archive: boolean;
  urgency?: ArcUrgency;
  suppressNotification: boolean;
  forwardAddresses: string[];
  additionalLabels: string[];
  doPong: boolean;
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
    doPong: false,
  };
}

async function applyRules(
  rules: Rule[],
  context: { signal: Signal; arc: Arc; isMatchedArc: boolean },
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
        ruleId: rule.id,
        ruleName: rule.name,
        accountId: rule.accountId,
        warnings: evalResult.warnings,
      });
      const id = generateId("sgn-");
      const timestamp = DateTime.utc().toISO()!;
      const ttl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
      const result = await saveSignal({
        id, signalLookupId: id, arcId: context.arc.id, accountId: rule.accountId,
        source: "email", type: "invalid_rule_function", status: "active",
        createdAt: timestamp, ttl,
        data: { resourceName: rule.name, issue: evalResult.warnings.join("; ") },
      });
      if (result.isErr()) {
        logger.warn("Failed to save invalid_rule_function signal.", { code: "system_signal.write_failed", accountId: rule.accountId, type: "invalid_rule_function", error: result.error });
      }
    }

    const staticActions = rule.actions.filter((a) => !a.disabled).map(({ type, value }) => ({ type, ...(value !== undefined ? { value } : {}) }));
    const dynamicActions = evalResult.dynamicActions.map(({ type, value }) => ({ type, ...(value !== undefined ? { value } : {}) }));
    const actions = [...staticActions, ...dynamicActions];
    const labelsAdded = actions.filter((a) => a.type === "assign_label" && a.value).map((a) => a.value!);
    const statusChange: MatchedRuleResult["statusChange"] = (
      actions.some((a) => a.type === "block_reject")      ? "block_reject"      :
      actions.some((a) => a.type === "block_hidden")      ? "block_hidden"      :
      actions.some((a) => a.type === "quarantine_hidden") ? "quarantine_hidden"  :
      actions.some((a) => a.type === "quarantine")        ? "quarantine_visible" :
      actions.some((a) => a.type === "archive")           ? "archived"           :
      undefined
    );
    matchedRules.push({ ruleId: rule.id, actions, labelsAdded, ...(statusChange ? { statusChange } : {}) });
    // assign_workflow mutates the arc so subsequent rules evaluate against the updated workflow
    const workflowAction = actions.find((a) => a.type === "assign_workflow");
    if (workflowAction?.value) context.arc.workflow = workflowAction.value as Workflow;
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
        case "quarantine":
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
        case "set_urgency":           if (!urgencySet && action.value) { outcome.urgency = action.value as ArcUrgency; urgencySet = true; } break;
        case "assign_label":          if (action.value) outcome.additionalLabels.push(action.value); break;
        case "forward":               if (action.value) outcome.forwardAddresses.push(action.value); break;
        case "pong":                  outcome.doPong = true; break;
      }
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// System rules — seeded into every new account; users can disable individually
// ---------------------------------------------------------------------------

const in_ = (label: string) => ({ "in": [label, { "var": "arc.labels" }] });
const wf_ = (w: string) => ({ "==": [{ "var": "signal.data.workflow" }, w] });
const wfData_ = (field: string) => ({ "var": `signal.data.workflowData.${field}` });

export const SYSTEM_RULES: Rule[] = [
  // --- Sender / content gating (1–8) ----------------------------------------
  { id: "SR-14", accountId: "SYSTEM", name: "Auto-approve sender on matched conversation", condition: JSON.stringify({ "and": [in_("system:workflow:conversation"), in_("system:sender:untrusted"), { "var": "isMatchedArc" }] }), actions: [{ type: "approve_sender" }], status: "enabled", priorityOrder: 1, createdAt: "", updatedAt: "" },
  { id: "SR-01", accountId: "SYSTEM", name: "Block onboarding emails", condition: JSON.stringify(in_("system:workflow:onboarding")), actions: [{ type: "block_hidden" }], status: "enabled", priorityOrder: 2, createdAt: "", updatedAt: "" },
  { id: "SR-05", accountId: "SYSTEM", name: "Block status emails", condition: JSON.stringify(in_("system:workflow:status")), actions: [{ type: "block_hidden" }], status: "enabled", priorityOrder: 3, createdAt: "", updatedAt: "" },
  { id: "SR-03", accountId: "SYSTEM", name: "Quarantine high-spam signals", condition: JSON.stringify(in_("system:spam:high")), actions: [{ type: "quarantine_hidden" }], status: "enabled", priorityOrder: 4, createdAt: "", updatedAt: "" },
  { id: "SR-25", accountId: "SYSTEM", name: "Quarantine security alert emails", condition: JSON.stringify(in_("system:auth:security_alert")), actions: [{ type: "quarantine_hidden" }], status: "enabled", priorityOrder: 5, createdAt: "", updatedAt: "" },
  { id: "SR-04", accountId: "SYSTEM", name: "Quarantine medium spam", condition: JSON.stringify(in_("system:spam:medium")), actions: [{ type: "quarantine" }], status: "enabled", priorityOrder: 6, createdAt: "", updatedAt: "" },
  { id: "SR-06", accountId: "SYSTEM", name: "Suppress notification for status emails", condition: JSON.stringify(in_("system:workflow:status")), actions: [{ type: "suppress_notification" }], status: "enabled", priorityOrder: 7, createdAt: "", updatedAt: "" },
  { id: "SR-07", accountId: "SYSTEM", name: "Suppress notification for content emails", condition: JSON.stringify(in_("system:workflow:content")), actions: [{ type: "suppress_notification" }], status: "enabled", priorityOrder: 8, createdAt: "", updatedAt: "" },
  // --- Workflow-specific urgency (9–18) ----------------------------------------
  // conversation: high when reply is needed and tone is urgent/negative
  { id: "SR-15", accountId: "SYSTEM", name: "Conversation: high urgency when reply needed and urgent/negative", condition: JSON.stringify({ "and": [wf_("conversation"), { "==": [wfData_("requiresReply"), true] }, { "in": [wfData_("sentiment"), ["urgent", "negative"]] }] }), actions: [{ type: "set_urgency", value: "high" }], status: "enabled", priorityOrder: 9, createdAt: "", updatedAt: "" },
  { id: "SR-16", accountId: "SYSTEM", name: "Conversation: low urgency when user has never replied", condition: JSON.stringify({ "and": [wf_("conversation"), { "!": [in_("system:replied")] }] }), actions: [{ type: "set_urgency", value: "low" }], status: "enabled", priorityOrder: 10, createdAt: "", updatedAt: "" },
  { id: "SR-17", accountId: "SYSTEM", name: "CRM: requires reply", condition: JSON.stringify({ "and": [wf_("crm")] }), actions: [{ type: "set_urgency", value: "normal" }], status: "enabled", priorityOrder: 11, createdAt: "", updatedAt: "" },
  // support: priority field drives urgency; urgent > priority-based > awaiting_response > lifecycle
  { id: "SR-20", accountId: "SYSTEM", name: "Support: critical urgency for urgent-priority tickets", condition: JSON.stringify({ "and": [wf_("support"), { "==": [wfData_("priority"), "urgent"] }] }), actions: [{ type: "set_urgency", value: "critical" }], status: "enabled", priorityOrder: 14, createdAt: "", updatedAt: "" },
  { id: "SR-21", accountId: "SYSTEM", name: "Support: high urgency for high-priority tickets", condition: JSON.stringify({ "and": [wf_("support"), { "==": [wfData_("priority"), "high"] }] }), actions: [{ type: "set_urgency", value: "high" }], status: "enabled", priorityOrder: 15, createdAt: "", updatedAt: "" },
  { id: "SR-22", accountId: "SYSTEM", name: "Support: high urgency when agent is awaiting response", condition: JSON.stringify({ "and": [wf_("support"), { "==": [wfData_("eventType"), "awaiting_response"] }] }), actions: [{ type: "set_urgency", value: "high" }], status: "enabled", priorityOrder: 16, createdAt: "", updatedAt: "" },
  { id: "SR-23", accountId: "SYSTEM", name: "Support: low urgency for low-priority tickets", condition: JSON.stringify({ "and": [wf_("support"), { "==": [wfData_("priority"), "low"] }, { "!": [in_("system:replied")] }] }), actions: [{ type: "set_urgency", value: "low" }], status: "enabled", priorityOrder: 17, createdAt: "", updatedAt: "" },
  // ticket_opened/resolved/closed are passive lifecycle events — low unless urgency field says otherwise (fired after priority rules so those win)
  { id: "SR-24", accountId: "SYSTEM", name: "Support: low urgency for passive lifecycle events", condition: JSON.stringify({ "and": [wf_("support"), { "in": [wfData_("eventType"), ["ticket_opened", "ticket_resolved", "ticket_closed"]] }, { "!": [in_("system:replied")] }] }), actions: [{ type: "set_urgency", value: "low" }], status: "enabled", priorityOrder: 18, createdAt: "", updatedAt: "" },
  { id: "SR-13", accountId: "SYSTEM", name: "Auto-reply to test emails (pong)", condition: JSON.stringify(in_("system:test")), actions: [{ type: "pong" }], status: "enabled", priorityOrder: 19, createdAt: "", updatedAt: "" },
  // --- Calendar forwarding (20) ----------------------------------------
  { id: "SR-26", accountId: "SYSTEM", name: "Forward calendar invite to user's real calendar", condition: JSON.stringify(in_("system:calendar")), actions: [{ type: "forwardCalendarInvite" }], status: "enabled", priorityOrder: 20, createdAt: "", updatedAt: "" },
];

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

interface SignalProcessorOptions {
  arcDb: ArcDatabase;
  accountDb: AccountDatabase;
  processingDb: ProcessingDatabase;
  contentSanitizer: ContentSanitizerClient;
  userCodeExecutor: UserCodeExecutorClient;
  classifier: Pick<SignalClassifier, "classify">;
  embeddingGenerator: EmbeddingGenerator;
  auroraWriter: MultiClusterAuroraWriter;
  arcMatcher: ArcMatcher;
  ruleEvaluator: RuleEvaluator;
  logger: Logger;
  notifier: Notifier;
  forwarder: Forwarder;
  retentionService: S3RetentionService;
  replySender: ReplySender;
  sqsDispatcher: SqsDispatcher;
  draftSendDispatcher: DraftSendDispatch;
  billingHandler: BillingHandler;
  handlerRegistry: HandlerRegistry;
  calendarForwarderDeps: CalendarForwarderDeps;
  schedulerClient: SchedulerClient;
  s3Client: S3Client;
  emailBucket: string;
  contentBucket: string;
}

export class SignalProcessor {
  private readonly arcDb: ArcDatabase;
  private readonly accountDb: AccountDatabase;
  private readonly processingDb: ProcessingDatabase;
  private readonly contentSanitizer: ContentSanitizerClient;
  private readonly userCodeExecutor: UserCodeExecutorClient;
  private readonly classifier: Pick<SignalClassifier, "classify">;
  private readonly embeddingGenerator: EmbeddingGenerator;
  private readonly auroraWriter: MultiClusterAuroraWriter;
  private readonly arcMatcher: ArcMatcher;
  private readonly ruleEvaluator: RuleEvaluator;
  private readonly logger: Logger;
  private readonly notifier: Notifier;
  private readonly forwarder: Forwarder;
  private readonly replySender: ReplySender;
  private readonly retentionService: S3RetentionService;
  private readonly sqsDispatcher: SqsDispatcher;
  private readonly draftSendDispatcher: DraftSendDispatch;
  private readonly billingHandler: BillingHandler;
  private readonly handlerRegistry: HandlerRegistry;
  private readonly calendarForwarderDeps: CalendarForwarderDeps;
  private readonly schedulerClient: SchedulerClient;
  private readonly s3Client: S3Client;
  private readonly emailBucket: string;
  private readonly contentBucket: string;

  constructor(opts: SignalProcessorOptions) {
    this.arcDb = opts.arcDb;
    this.accountDb = opts.accountDb;
    this.processingDb = opts.processingDb;
    this.contentSanitizer = opts.contentSanitizer;
    this.userCodeExecutor = opts.userCodeExecutor;
    this.classifier = opts.classifier;
    this.embeddingGenerator = opts.embeddingGenerator;
    this.auroraWriter = opts.auroraWriter;
    this.arcMatcher = opts.arcMatcher;
    this.ruleEvaluator = opts.ruleEvaluator;
    this.logger = opts.logger;
    this.notifier = opts.notifier;
    this.forwarder = opts.forwarder;
    this.replySender = opts.replySender;
    this.retentionService = opts.retentionService;
    this.sqsDispatcher = opts.sqsDispatcher;
    this.draftSendDispatcher = opts.draftSendDispatcher;
    this.billingHandler = opts.billingHandler;
    this.handlerRegistry = opts.handlerRegistry;
    this.calendarForwarderDeps = opts.calendarForwarderDeps;
    this.schedulerClient = opts.schedulerClient;
    this.s3Client = opts.s3Client;
    this.emailBucket = opts.emailBucket;
    this.contentBucket = opts.contentBucket;
  }

  async processRecord(message: InboundSignalMessage, receiveCount: number): Promise<Result<void, ProcessorError>> {
    // On redelivery, check DDB for existing signal before doing expensive work
    if (receiveCount > 1) {
      this.logger.info("Retry path activated — checking DDB for existing signal state before re-processing.", { code: "processor.retry_path_activated", receiveCount, accountId: message.accountId, sesMessageId: message.sesMessageId });

      const existingResult = await this.arcDb.getSignalByMessageId(message.accountId, message.sesMessageId);
      if (existingResult.isErr()) return err(processorError(existingResult.error));
      this.logger.trackPoint("retry_signal_lookup");

      if (existingResult.value) {
        const signal = existingResult.value;
        this.logger.info("Signal found in DDB on retry — resuming from Aurora upserts.", { code: "processor.retry_signal_found", signalId: signal.id, arcId: signal.arcId, accountId: message.accountId, sesMessageId: message.sesMessageId, receiveCount });

        // Signal exists — arc is guaranteed to exist (arc saved before signal).
        // Load arc to resume from the convergence point.
        if (!signal.arcId) return err(processorError("signal missing arcId on retry"));
        const arcResult = await this.arcDb.getArc(message.accountId, signal.arcId);
        if (arcResult.isErr()) return err(processorError(arcResult.error));
        this.logger.trackPoint("retry_arc_lookup");
        const arc = arcResult.value;
        if (!arc) return err(processorError("arc not found on retry"));

        // Fetch account context (needed for S3 retention)
        const accountCtxResult = await this.accountDb.getProcessorAccountContext(message.accountId, signal.data.recipientAddress);
        if (accountCtxResult.isErr()) return err(processorError(accountCtxResult.error));
        const accountCtx = accountCtxResult.value;

        // S3 retention — always attempt, fire-and-forget (idempotent)
        await this.attemptS3Retention(signal, accountCtx, arc);

        // Aurora upserts — always run (idempotent). Gates side-effect dispatch.
        const auroraResult = await this.executeAuroraUpserts(signal, arc);
        if (auroraResult.isErr()) return err(processorError(auroraResult.error));

        // Dispatch side-effects via SQS after Aurora succeeds
        const dispatchResult = await this.dispatchSideEffects(signal, arc);
        if (dispatchResult.isErr()) return err(processorError(dispatchResult.error));

        return ok(undefined);
      }

      // Signal not found in DDB on retry — fall through to full pipeline
      this.logger.info("Signal NOT found in DDB on retry — running full pipeline.", { code: "processor.retry_signal_not_found", accountId: message.accountId, sesMessageId: message.sesMessageId, receiveCount });
    }

    let processResult: Result<void, DbError | InvalidResponseError>;
    try {
      processResult = await this.processMessage(message);
    } catch (e) {
      this.logger.error("processMessage threw an unhandled exception. This should not happen — all errors should be returned as Result types. The message will be retried.", { code: "processor.unhandled_exception", error: e, accountId: message.accountId, sesMessageId: message.sesMessageId });
      return err(processorError(e));
    }
    if (processResult.isErr()) return err(processorError(processResult.error));

    return ok(undefined);
  }

  async processSideEffect(payload: SideEffectPayload, receiveCount = 1): Promise<Result<void, ProcessorError>> {
    const { signal, arc: payloadArc } = payload;
    const accountId = signal.accountId;

    // On retries the payload arc snapshot may be stale — refetch from DDB
    let arc: Arc;
    if (receiveCount > 1) {
      const arcResult = await this.arcDb.getArc(accountId, payloadArc.id);
      if (arcResult.isErr()) return err(processorError(arcResult.error));
      arc = arcResult.value ?? payloadArc;
    } else {
      arc = payloadArc;
    }

    // Re-derive outcome from persisted matchedRules
    const outcome = deriveOutcome(signal.data.matchedRules ?? []);

    this.logger.trackPoint("side_effect_received");

    // Determine which effect types will execute
    const autoDraftActions = (signal.data.matchedRules ?? []).flatMap(r => r.actions.filter(a => a.type === "auto_draft" && a.value));
    const effectTypes: string[] = [];
    if (outcome.forwardAddresses.length > 0) effectTypes.push("forward");
    if (!outcome.suppressNotification) effectTypes.push("notify");
    if (outcome.doPong) effectTypes.push("pong");
    if (autoDraftActions.length > 0) effectTypes.push("auto_draft");
    this.logger.info("Outcome derived from matchedRules — executing side-effects.", { code: "processor.side_effect.outcome_derived", accountId, signalId: signal.id, arcId: arc.id, effectTypes });

    // Critical side-effects (forward, pong) force retry on failure.
    // Best-effort side-effects (notify, auto-send) are logged and swallowed.
    let criticalFailure: unknown = null;

    // Forward (critical — recipient loses the email if this fails)
    if (outcome.forwardAddresses.length > 0) {
      for (const toAddress of outcome.forwardAddresses) {
        try {
          this.logger.trackPoint("side_effect_forward_start");
          const forwardResult = await this.forwarder.forward(signal.data.s3Key, toAddress, accountId, {
            signalId: signal.id,
            arcId: arc.id,
          });
          if (forwardResult.isErr()) {
            this.logger.track("Side-effect forward failed — will force retry.", { code: "processor.side_effect.forward_failed", accountId, toAddress, error: forwardResult.error });
            criticalFailure = forwardResult.error;
          } else {
            this.logger.trackPoint("side_effect_forward_complete");
          }
        } catch (e) {
          this.logger.track("Side-effect forward threw unexpectedly — will force retry.", { code: "processor.side_effect.forward_error", accountId, toAddress, error: e });
          criticalFailure = e;
        }
      }
    }

    // Notify
    if (!outcome.suppressNotification) {
      try {
        this.logger.trackPoint("side_effect_notify_start");
        const notifyResult = await this.notifier.notify(accountId, arc, signal, arc.urgency ?? "normal");
        if (notifyResult.isErr()) {
          this.logger.track("Side-effect notification failed.", { code: "processor.side_effect.notify_failed", accountId, error: notifyResult.error });
        }
        this.logger.trackPoint("side_effect_notify_complete");
      } catch (e) {
        this.logger.error("Side-effect notification threw unexpectedly.", { code: "processor.side_effect.notify_error", accountId, error: e });
      }
    }

    // Workflow dispatch (critical — handler decides retriability)
    this.logger.trackPoint("side_effect_workflow_start");
    const dispatchResult = await this.handlerRegistry.dispatch(signal, arc, accountId);
    this.logger.trackPoint("side_effect_workflow_complete");
    if (dispatchResult.isErr()) {
      criticalFailure = dispatchResult.error;
    }

    // Pong (critical — the test confirmation is the product's first impression)
    if (outcome.doPong) {
      try {
        this.logger.trackPoint("side_effect_pong_start");
        const recipientDomain = signal.data.recipientAddress.split("@")[1] ?? "";
        const domainResult = await this.accountDb.getDomainByName(accountId, recipientDomain);
        const domain = domainResult.isOk() ? domainResult.value : null;
        const from = domain?.senderSetupComplete
          ? signal.data.recipientAddress
          : `noreply@${process.env["MAIL_DOMAIN"] ?? "platform.email.rhosys.cloud"}`;
        await this.replySender.sendReply({
          to: signal.data.from.address,
          from,
          subject: signal.data.subject ?? "",
          body: signal.data.textBody ?? "",
          inReplyTo: signal.id,
          accountId,
          signalId: signal.id,
          arcId: arc.id,
        });
        this.logger.trackPoint("side_effect_pong_complete");
      } catch (e) {
        this.logger.track("Side-effect pong failed — will force retry.", { code: "processor.side_effect.pong_failed", accountId, error: e });
        criticalFailure = e;
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
          "arc.workflow": signal.data.workflow ?? "",
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
                  signal: { id: signal.id, from: signal.data.from, subject: signal.data.subject, summary: signal.data.summary, spamScore: signal.data.spamScore, workflow: signal.data.workflow, recipientAddress: signal.data.recipientAddress, workflowData: signal.data.workflowData },
                  arc: { id: arc.id, labels: arc.labels, ...(arc.urgency !== undefined ? { urgency: arc.urgency } : {}), summary: arc.summary, workflow: arc.workflow, status: arc.status },
                },
              });
              if (!response.success) {
                // Execution error (timeout, runtime_error, sandbox_violation)
                const issue = `[${response.error.type}] ${response.error.message}`;
                await this.annotateTemplateError(accountId, tmpl.id, fn.name, response.error);
                this.logger.warn("Template function execution failed.", {
                  code: "processor.template_function.error",
                  accountId,
                  templateName: tmpl.name,
                  functionName: fn.name,
                  errorType: response.error.type,
                  errorMessage: response.error.message,
                });
                {
                  const sigId = generateId("sgn-");
                  const sigTs = DateTime.utc().toISO()!;
                  await this.arcDb.saveSignal({ id: sigId, signalLookupId: sigId, arcId: arc.id, accountId, source: "email", type: "invalid_template_function", status: "active", createdAt: sigTs, ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60, data: { resourceName: tmpl.name, functionName: fn.name, issue } });
                }
                actionVars[`fn.${fn.name}`] = "";
                preventAutoSend = true;
              } else {
                const result = (response as TemplateParameterResult).result;
                if (result == null || typeof result !== "string") {
                  // Non-string or null return — treat as failure
                  const issue = result == null
                    ? "Function returned no value"
                    : `Function returned non-string value (type: ${typeof result})`;
                  await this.annotateTemplateError(accountId, tmpl.id, fn.name, null);
                  this.logger.warn("Template function returned invalid value.", {
                    code: "processor.template_function.invalid_return",
                    accountId,
                    templateName: tmpl.name,
                    functionName: fn.name,
                    issue,
                  });
                  {
                    const sigId = generateId("sgn-");
                    const sigTs = DateTime.utc().toISO()!;
                    await this.arcDb.saveSignal({ id: sigId, signalLookupId: sigId, arcId: arc.id, accountId, source: "email", type: "invalid_template_function", status: "active", createdAt: sigTs, ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60, data: { resourceName: tmpl.name, functionName: fn.name, issue } });
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
                accountId,
                fromAddress: signal.data.from.address,
                replyToAddress: signal.data.replyTo.address,
                recipientAddress: signal.data.recipientAddress,
              });
              {
                const sigId = generateId("sgn-");
                const sigTs = DateTime.utc().toISO()!;
                await this.arcDb.saveSignal({ id: sigId, signalLookupId: sigId, arcId: arc.id, accountId, source: "email", type: "auto_send_blocked", status: "active", createdAt: sigTs, ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60, data: { recipientAddress: signal.data.recipientAddress } });
              }
            }
          }

          const sendInitiatedAt = shouldAutoSend ? now : undefined;

          const draftId = generateId("sgn-");
          const draft: Signal = {
            id: draftId,
            signalLookupId: draftId,
            arcId: arc.id,
            accountId,
            source: "user",
            type: "email",
            status: shouldAutoSend ? "pending_send" : "draft",
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
              spamScore: 0,
              summary: "",
              s3Key: "",
              ...(sendInitiatedAt ? { sendInitiatedAt } : {}),
            },
          };

          const draftSaveResult = await this.arcDb.saveSignal(draft);
          if (draftSaveResult.isErr()) {
            this.logger.track("Side-effect auto-draft save failed — will force retry.", { code: "processor.side_effect.auto_draft_failed", accountId, error: draftSaveResult.error });
            criticalFailure = draftSaveResult.error;
            continue;
          }

          // Dispatch to SQS for delayed send (5 min undo window)
          if (shouldAutoSend) {
            const dispatchResult = await this.draftSendDispatcher.dispatch(
              { signalId: draft.id, accountId, sendInitiatedAt: sendInitiatedAt! },
              300,
            );
            if (dispatchResult.isErr()) {
              this.logger.track("Side-effect auto-draft SQS dispatch failed — draft remains pending_send, will not send automatically.", { code: "processor.side_effect.auto_draft_dispatch_failed", accountId, signalId: draft.id, error: dispatchResult.error });
            }
          }

          if (preventAutoSend && autoSend) {
            this.logger.info("Auto-send skipped — template function returned null or errored.", { code: "processor.side_effect.auto_draft_prevent_send", accountId, templateId });
          }
        }
        this.logger.trackPoint("side_effect_auto_draft_complete");
      } catch (e) {
        this.logger.track("Side-effect auto-draft threw unexpectedly.", { code: "processor.side_effect.auto_draft_error", accountId, error: e });
      }
    }

    // Webhook (best-effort — never blocks or retries)
    const webhookActions = (signal.data.matchedRules ?? [])
      .flatMap(r => r.actions.filter(a => a.type === "webhook" && a.value));
    if (webhookActions.length > 0) {
      const accountCtxResult = await this.accountDb.getProcessorAccountContext(accountId, signal.data.recipientAddress);
      const accountPlan = accountCtxResult.isOk() ? accountCtxResult.value.billingPlan : "Free";

      if (!this.billingHandler.isFeatureEnabled(accountPlan, "webhook")) {
        this.logger.info("Webhook action skipped — feature not enabled for plan.", {
          code: "processor.side_effect.webhook_plan_gated",
          accountId,
          plan: accountPlan,
        });
      } else {
        const payload = buildWebhookPayload(signal, arc);
        for (const action of webhookActions) {
          const configResult = parseWebhookConfig(action.value);
          if (configResult.isErr()) {
            this.logger.track("Webhook action skipped — invalid config at processing time.", {
              code: "processor.side_effect.webhook_invalid_config",
              accountId,
              value: action.value,
              error: configResult.error,
            });
            continue;
          }
          await deliverWebhook(configResult.value.url, payload, this.logger);
        }
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
        const calendarForwardingAddress = accountResult.isOk() ? accountResult.value?.defaultCalendarInviteForwardingAddress ?? "" : "";

        // Find the calendar signal linked to this email signal
        const calendarSignalResult = await this.arcDb.getLinkedCalendarSignal(accountId, arc.id, signal.id);
        if (calendarSignalResult.isErr()) {
          this.logger.track("Calendar forward failed — could not find linked calendar signal.", { code: "processor.side_effect.calendar_forward_no_signal", accountId, signalId: signal.id, arcId: arc.id, error: calendarSignalResult.error });
        } else if (!calendarSignalResult.value) {
          this.logger.track("Calendar forward skipped — no linked calendar signal found.", { code: "processor.side_effect.calendar_forward_no_signal", accountId, signalId: signal.id, arcId: arc.id });
        } else {
          const calendarSignal = calendarSignalResult.value;
          const forwardResult = await forwardCalendarInvite(
            {
              calendarSignal,
              calendarForwardingAddress,
              accountId,
              arcId: arc.id,
              aliasAddress: signal.data.recipientAddress,
            },
            this.calendarForwarderDeps,
            this.logger,
          );
          if (forwardResult.isErr()) {
            this.logger.track("Calendar forward failed — will force retry.", { code: "processor.side_effect.calendar_forward_failed", accountId, signalId: signal.id, error: forwardResult.error });
            criticalFailure = forwardResult.error;
          } else {
            this.logger.trackPoint("side_effect_calendar_forward_complete");
          }
        }
      } catch (e) {
        this.logger.track("Calendar forward threw unexpectedly — will force retry.", { code: "processor.side_effect.calendar_forward_error", accountId, error: e });
        criticalFailure = e;
      }
    }

    this.logger.trackPoint("side_effect_all_complete");
    if (criticalFailure) {
      return err(processorError(criticalFailure));
    }
    return ok(undefined);
  }

  private async processMessage(msg: InboundSignalMessage): Promise<Result<void, DbError | InvalidResponseError>> {
    const { accountId, s3Key, sesMessageId, timestamp, destination } = msg;

    // 1. Dedup
    const existingResult = await this.arcDb.getSignalByMessageId(accountId, sesMessageId);
    if (existingResult.isErr()) return err(existingResult.error);
    if (existingResult.value) return ok(undefined);

    // 1b. Block emails that fail DKIM or DMARC — spoofed sender, reject immediately
    if (msg.dkimVerdict !== "PASS" || msg.dmarcVerdict !== "PASS") {
      const signalId = generateId("sgn-");
      const signal: Signal = {
        id: signalId,
        signalLookupId: "ses-" + sesMessageId,
        accountId,
        status: "block_reject",
        source: "email",
        type: "email",
        createdAt: DateTime.utc().toISO()!,
        data: {
          sesMessageId,
          s3Key,
          recipientAddress: destination[0] ?? "",
          receivedAt: timestamp,
          from: { address: "" },
          to: [],
          cc: [],
          subject: "",
          textBody: "",
          attachments: [],
          headers: {},
          workflow: "status",
          workflowData: { workflow: "status", statusType: "other", provider: "" } as const,
          spamScore: 0,
          summary: "",
        },
      };
      const saveResult = await this.arcDb.saveSignal(signal);
      if (saveResult.isErr()) return err(saveResult.error);
      this.logger.track("Blocked email — DKIM or DMARC verification failed.", { code: "processor.dkim_dmarc_block", accountId, sesMessageId, dkimVerdict: msg.dkimVerdict, dmarcVerdict: msg.dmarcVerdict });
      const dkimCat = statusToCategory(signal.status);
      if (dkimCat) {
        const statsResult = await this.accountDb.incrementStats(accountId, dkimCat);
        if (statsResult.isErr()) {
          this.logger.warn("Stats increment failed — dashboard may be slightly behind.", { code: "processor.stats_increment_failed", accountId, error: statsResult.error });
        }
      }
      return ok(undefined);
    }

    // 2. Content Sanitizer — fetch, parse, sanitize, extract
    const recipientAddress = destination[0] ?? "";

    // Fetch account context early (needed for retention resolution before content sanitizer)
    const accountCtxResult = await this.accountDb.getProcessorAccountContext(accountId, recipientAddress);
    if (accountCtxResult.isErr()) return err(accountCtxResult.error);
    const accountCtx = accountCtxResult.value;

    // Resolve retention and generate pre-signed URLs for the content sanitizer
    const retentionDuration = resolveRetention({}, null);
    const s3Tag = retentionToS3Tag(retentionDuration);
    const signalId = sesMessageId;
    const keyPrefix = `content/accounts/${accountId}/extracted/${signalId}/`;

    const [presignedGet, presignedPost] = await Promise.all([
      generatePresignedGet(this.s3Client, this.emailBucket, s3Key),
      generatePresignedPost(this.s3Client, this.contentBucket, keyPrefix, s3Tag),
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
    };
    this.logger.trackPoint("email_parsed");

    const senderETLD1 = getETLD1(parsed.from.address);

    // 3. Fetch account labels for closed-set label selection
    const labelsResult = await this.accountDb.listLabels(accountId);
    const allowedLabels = labelsResult.isOk() ? labelsResult.value.map(l => l.name) : [];

    // 4. Classify email (must complete before embedding — sequential dependency)
    const classificationHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.headers)) {
      if (RELEVANT_HEADERS.has(k.toLowerCase())) classificationHeaders[k] = v;
    }
    const classification = await this.classifier.classify({
      from: parsed.from.address,
      to: parsed.to.map((a) => a.address),
      subject: parsed.subject,
      body: parsed.htmlBody != null ? stripHtmlForClassifier(parsed.htmlBody) : (parsed.textBody ?? ""),
      headers: classificationHeaders,
      receivedAt: timestamp,
      allowedLabels,
      signalId,
      accountId,
    });

    if (classification.isErr()) {
      return err(invalidResponseError());
    }
    const classificationOutput = classification.value;

    // 5. Build embed text from classification output (attacker-free content)
    const embedText = buildEmbedText(classificationOutput);

    // Phase 1: Primary embedding (fail-hard) — must succeed for arc matching
    const readCluster = getPrimaryArcMatcherRegistry();
    const primaryResult = await this.embeddingGenerator.generateForModel(embedText, readCluster.modelId);

    if (primaryResult.isErr()) {
      this.logger.error("Primary embedding generation failed. The Bedrock InvokeModel call for the read cluster returned an error. Arc matching cannot proceed without a valid vector — the message will be retried via batch item failure.", { code: "embedding.primary_failed", modelId: readCluster.modelId, error: primaryResult.error });
      return err(dbError(primaryResult.error.cause));
    }
    const embedding = primaryResult.value.vector;
    this.logger.trackPoint("email_processed");

    const now = DateTime.utc().toISO()!;

    // 4. Fetch sender entry (account context already fetched for retention resolution)
    const senderEntryResult = await this.accountDb.getSender(accountId, recipientAddress, senderETLD1);
    if (senderEntryResult.isErr()) return err(senderEntryResult.error);
    const senderEntry = senderEntryResult.value;
    const ttl = accountCtx.retentionDays > 0
      ? Math.floor(Date.now() / 1000) + accountCtx.retentionDays * 86400
      : undefined;

    // 5. Test detection override
    const fromDomain = getETLD1(parsed.from.address);
    const isTestEmail =
      accountCtx.registeredDomains.includes(fromDomain) ||
      accountCtx.userEmails.map((e) => e.toLowerCase()).includes(parsed.from.address.toLowerCase());
    if (isTestEmail) {
      classificationOutput.workflow = "test";
      classificationOutput.workflowData = { workflow: "test", triggeredBy: "user" };

      // Auto-mark onboarding testEmailReceived if not yet completed
      if (!accountCtx.onboardingCompleted) {
        const onboardingResult = await this.accountDb.updateAccount(accountId, {
          onboarding: { completed: false, testEmailReceived: true, testEmailReceivedAt: DateTime.utc().toISO()! },
        });
        if (onboardingResult.isErr()) {
          this.logger.warn("Failed to mark onboarding testEmailReceived", { code: "processor.onboarding_mark_failed", accountId, error: onboardingResult.error });
        }
      }
    }

    const spamScoreThreshold =
      accountCtx.emailConfig?.spamScoreThreshold ??
      accountCtx.filtering?.spamScoreThreshold ??
      DEFAULT_SPAM_SCORE_THRESHOLD;

    // 6. Arc matching
    const groupingKey = deriveGroupingKey(classificationOutput.workflow, classificationOutput.workflowData, recipientAddress, senderETLD1);
    this.logger.trackPoint("arc_matcher_values_generated");
    let matchedArc: Arc | null;
    this.logger.trackPoint("arc_match_search");
    if (groupingKey) {
      this.logger.trackPoint("arc_matcher_grouping_key_lookup");
      const gkResult = await this.arcDb.fastFindArcByAlternativeLookupKey(accountId, groupingKey);
      if (gkResult.isErr()) return err(gkResult.error);
      matchedArc = gkResult.value;
    } else {
      this.logger.trackPoint("arc_matcher_similarity_search");
      const matchResult = await this.arcMatcher.findMatch(accountId, recipientAddress, embedding);
      if (matchResult.isErr()) return err(matchResult.error);
      matchedArc = matchResult.value;
      if (matchedArc) {
        this.logger.info("Similarity search returned match.", { code: "processor.arc_matcher.similarity_match", arcId: matchedArc.id, accountId, sesMessageId });
      } else {
        this.logger.info("Similarity search returned no match.", { code: "processor.arc_matcher.no_match", accountId, sesMessageId });
      }
    }

    const isMatchedArc = matchedArc !== null;

    // 7. Build arc shell (lastSignalAt applied after rules — archive outcome suppresses it on existing arcs)
    let arc: Arc;
    if (matchedArc) {
      arc = {
        ...matchedArc,
        workflow: classificationOutput.workflow,
        summary: classificationOutput.summary,
        updatedAt: now,
      };
      this.logger.info("Existing arc matched.", { code: "processor.arc_matched", arcId: arc.id, matchMethod: groupingKey ? "groupingKey" : "similarity", accountId, sesMessageId });
    } else {
      arc = {
        id: generateId("arc-"),
        accountId,
        ...(groupingKey ? { groupingKey } : {}),
        workflow: classificationOutput.workflow,
        labels: [],
        status: "active",
        summary: classificationOutput.summary,
        lastSignalAt: timestamp,
        createdAt: now,
        updatedAt: now,
        ...(ttl !== undefined ? { ttl } : {}),
      };
      this.logger.info("New arc created.", { code: "processor.arc_created", arcId: arc.id, accountId, sesMessageId, ...(groupingKey ? { groupingKey } : {}) });
    }

    // 8. Assign system labels and merge classifier labels
    const emailConfig = accountCtx.emailConfig;
    const effectiveFilterMode: UnknownSenderPolicy = emailConfig
      ? emailConfig.unknownSenderPolicy
      : accountCtx.filtering?.newAddressHandling === "block_until_approved"
        ? "quarantine_visible"
        : "allow_all";
    // When no alias exists for the recipient, sender entries don't apply — treat as no entry
    const effectiveSenderEntry = emailConfig ? senderEntry : null;

    // Explicit sender block — if the sender has been explicitly blocked for this alias, short-circuit
    if (effectiveSenderEntry && effectiveSenderEntry.policy !== "allow") {
      const blockStatus = effectiveSenderEntry.policy; // block_hidden | block_reject | violate_report
      const blockedSignal = buildSignal({ status: blockStatus, accountId, sesMessageId, recipientAddress, parsed, classification: classificationOutput, s3Key, receivedAt: timestamp, now, ...(ttl !== undefined ? { ttl } : {}) });
      const saveResult = await this.arcDb.saveSignal(blockedSignal);
      if (saveResult.isErr()) return err(saveResult.error);
      this.logger.track("Blocked email — sender explicitly blocked for this alias.", { code: "processor.sender_block", accountId, sesMessageId, recipientAddress, senderETLD1, policy: blockStatus });
      const repResult = await this.processingDb.updateGlobalReputation(senderETLD1, { wasSpam: classificationOutput.spamScore >= spamScoreThreshold, wasBlocked: true });
      if (repResult.isErr()) {
        this.logger.warn("Failed to update global sender reputation after signal processing. The DynamoDB update returned an error. Reputation data may be stale for this domain.", { code: "processor.reputation_update_failed", accountId, error: repResult.error });
      }
      const senderBlockCat = statusToCategory(blockStatus);
      if (senderBlockCat) {
        const statsResult = await this.accountDb.incrementStats(accountId, senderBlockCat);
        if (statsResult.isErr()) {
          this.logger.warn("Stats increment failed — dashboard may be slightly behind.", { code: "processor.stats_increment_failed", accountId, error: statsResult.error });
        }
      }
      return ok(undefined);
    }

    const systemLabels = assignSystemLabels({
      workflow: classificationOutput.workflow,
      workflowData: classificationOutput.workflowData,
      spamScore: classificationOutput.spamScore,
      spamScoreThreshold,
      senderETLD1,
      senderEntry: effectiveSenderEntry,
      unknownSenderPolicy: effectiveFilterMode,
      hasSentMessages: (arc.sentMessageIds?.length ?? 0) > 0,
    });

    for (const label of [...systemLabels, ...classificationOutput.labels]) {
      if (!arc.labels.includes(label)) arc.labels = [...arc.labels, label];
    }

    // Forwarded email detection — attach original:* label when forwarding headers are present
    const forwardedAddress = extractForwardedAddress(parsed.headers);
    if (forwardedAddress) {
      const forwardLabel = `original:${forwardedAddress}`;
      if (!arc.labels.includes(forwardLabel)) {
        arc.labels = [...arc.labels, forwardLabel];
      }
    }

    // 9. Build signal shell
    const signalShell = buildSignal({
      arcId: arc.id,
      status: "active",
      accountId,
      sesMessageId,
      recipientAddress,
      parsed,
      classification: classificationOutput,
      s3Key,
      receivedAt: timestamp,
      now,
      ...(ttl !== undefined ? { ttl } : {}),
    });

    // 10. Evaluate all rules (system rules seeded at low position numbers, user rules at higher positions)
    const rulesResult = await this.accountDb.listEnabledRules(accountId);
    if (rulesResult.isErr()) return err(rulesResult.error);
    const rules = rulesResult.value;
    const matchedRules = await applyRules(rules, { signal: signalShell, arc, isMatchedArc }, this.ruleEvaluator, this.logger, (s) => this.arcDb.saveSignal(s));
    const outcome = deriveOutcome(matchedRules);
    this.logger.trackPoint("rules_evaluated", { matchedRuleCount: matchedRules.length });

    // Fallback: if no rule set a status, apply filter mode for untrusted senders
    const hasStatusOutcome = outcome.blockDisposition !== null || outcome.quarantine || outcome.archive;
    if (!hasStatusOutcome && arc.labels.includes("system:sender:untrusted")) {
      switch (effectiveFilterMode) {
        case "block_hidden":       outcome.blockDisposition = "block_hidden"; break;
        case "block_reject":       outcome.blockDisposition = "block_reject"; break;
        case "violate_report":     outcome.blockDisposition = "violate_report"; break;
        case "quarantine_hidden":  outcome.quarantine = true; outcome.quarantineHidden = true; break;
        case "quarantine_visible": outcome.quarantine = true; break;
        // "allow_all": signal proceeds as active
      }
    }

    const buildArgs = { accountId, sesMessageId, recipientAddress, parsed, classification: classificationOutput, s3Key, receivedAt: timestamp, now, ...(ttl !== undefined ? { ttl } : {}) };

    if (outcome.blockDisposition) {
      const blockSignal = buildSignal({ status: outcome.blockDisposition, ...buildArgs });
      const saveResult = await this.arcDb.saveSignal({ ...blockSignal, data: { ...blockSignal.data, matchedRules } });
      if (saveResult.isErr()) return err(saveResult.error);
      this.logger.track("Blocked email — rule matched with block disposition.", { code: "processor.rule_block", accountId, sesMessageId, recipientAddress, disposition: outcome.blockDisposition, matchedRules: matchedRules.map(r => r.ruleId) });
      const repResult = await this.processingDb.updateGlobalReputation(senderETLD1, { wasSpam: classificationOutput.spamScore >= spamScoreThreshold, wasBlocked: true });
      if (repResult.isErr()) {
        this.logger.warn("Failed to update global sender reputation after signal processing. The DynamoDB update returned an error. Reputation data may be stale for this domain.", { code: "processor.reputation_update_failed", accountId, error: repResult.error });
      }
      const blockCat = statusToCategory(outcome.blockDisposition);
      if (blockCat) {
        const statsResult = await this.accountDb.incrementStats(accountId, blockCat);
        if (statsResult.isErr()) {
          this.logger.warn("Stats increment failed — dashboard may be slightly behind.", { code: "processor.stats_increment_failed", accountId, error: statsResult.error });
        }
      }
      return ok(undefined);
    }

    // approveSender overrides quarantine — SR-14 (auto-approve on matched conversation) fires before SR-02
    if (outcome.quarantine && !outcome.approveSender) {
      const quarantineStatus = outcome.quarantineHidden ? "quarantine_hidden" : "quarantine_visible";
      const quarantineBase = buildSignal({ status: quarantineStatus, ...buildArgs });
      const quarantinedSignal: Signal = { ...quarantineBase, data: { ...quarantineBase.data, matchedRules } };
      const saveResult = await this.arcDb.saveSignal(quarantinedSignal);
      if (saveResult.isErr()) return err(saveResult.error);
      this.logger.track("Quarantined email — rule or sender filter matched.", { code: "processor.quarantine", accountId, sesMessageId, recipientAddress, status: quarantineStatus, matchedRules: matchedRules.map(r => r.ruleId) });
      const repResult = await this.processingDb.updateGlobalReputation(senderETLD1, { wasSpam: classificationOutput.spamScore >= spamScoreThreshold, wasBlocked: true });
      if (repResult.isErr()) {
        this.logger.warn("Failed to update global sender reputation after signal processing. The DynamoDB update returned an error. Reputation data may be stale for this domain.", { code: "processor.reputation_update_failed", accountId, error: repResult.error });
      }
      const quarantineCat = statusToCategory(quarantineStatus);
      if (quarantineCat) {
        const statsResult = await this.accountDb.incrementStats(accountId, quarantineCat);
        if (statsResult.isErr()) {
          this.logger.warn("Stats increment failed — dashboard may be slightly behind.", { code: "processor.stats_increment_failed", accountId, error: statsResult.error });
        }
      }
      return ok(undefined);
    }

    // Auto-approve: sender gets added to approvedSenders when approve_sender fires, allow_all mode, or brand-new address with auto-allow policy
    if (outcome.approveSender || effectiveFilterMode === "allow_all") {
      const approveResult = await this.autoApprove(accountId, recipientAddress, senderETLD1, emailConfig, accountCtx.filtering?.defaultUnknownSenderPolicy);
      if (approveResult.isErr()) return err(approveResult.error);
    }

    // 11. Apply outcome to arc
    // Always set lastSignalAt — reactivation semantics (a new signal always updates recency)
    arc.lastSignalAt = timestamp;

    for (const label of outcome.additionalLabels) {
      if (!arc.labels.includes(label)) arc.labels = [...arc.labels, label];
    }

    const signalUrgency = outcome.urgency ?? arc.urgency ?? "normal";
    if (!matchedArc) arc.urgency = signalUrgency;

    const signal: Signal = { ...signalShell, arcId: arc.id, data: { ...signalShell.data, matchedRules, urgency: signalUrgency } };
    this.logger.trackPoint("arc_updated", { arcId: arc.id });

    // 12. Pong — handled entirely in side-effect SQS handler (processSideEffect)

    // Phase 2: Secondary embeddings (warn-only) — best-effort population of write-ahead indexes
    const secondaryResults = await this.embeddingGenerator.generateForSecondaryClusters(embedText);
    for (const result of secondaryResults) {
      if (result.isErr()) {
        this.logger.warn("Secondary embedding generation failed. We will run the full re-index anyway before switching over — revalidate all WARNINGS to check for failures in generating Aurora embeddings.", { code: "embedding.secondary_failed", modelId: result.error.modelId, error: result.error });
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

    // Save arc (leaf node) before signal (dependent node) — guarantees arc exists whenever signal exists
    if (matchedArc) {
      // Reactivate — a new signal always brings the arc back to active (unless a rule archives it)
      arc.status = "active";
      if (outcome.archive) arc.status = "archived";

      // Compute optional field delta
      const fields: UpdateArcFields = {};
      if (arc.summary !== matchedArc.summary) fields.summary = arc.summary;
      if (arc.workflow !== matchedArc.workflow) fields.workflow = arc.workflow;
      if (arc.urgency !== undefined && arc.urgency !== matchedArc.urgency) fields.urgency = arc.urgency;
      if (arc.retentionDuration !== undefined && arc.retentionDuration !== matchedArc.retentionDuration) fields.retentionDuration = arc.retentionDuration;
      if (JSON.stringify(arc.labels) !== JSON.stringify(matchedArc.labels)) fields.labels = arc.labels;
      if (arc.sentMessageIds !== undefined && JSON.stringify(arc.sentMessageIds) !== JSON.stringify(matchedArc.sentMessageIds)) fields.sentMessageIds = arc.sentMessageIds;

      const updateResult = await this.arcDb.updateArc(accountId, arc.id, arc.status, arc.lastSignalAt, fields);
      if (updateResult.isErr()) return err(updateResult.error);

      // Cancel pending followup schedule when reactivating an archived arc
      if (matchedArc.status === "archived" && arc.status === "active" && this.schedulerClient) {
        const signalsResult = await this.arcDb.listSignals(accountId, arc.id, { limit: 1 });
        const scheduleSignalId = signalsResult.isOk() ? signalsResult.value.items[0]?.id ?? arc.id : arc.id;
        const scheduleName = buildScheduleName(accountId, scheduleSignalId, "followup");
        const deleteResult = await this.schedulerClient.deleteFollowup(scheduleName);
        if (deleteResult.isErr()) {
          this.logger.warn("Failed to cancel followup schedule on arc reactivation — stale-fire will handle it.", { code: "processor.followup.cancel_failed", accountId, arcId: arc.id, scheduleName, error: deleteResult.error });
        }
      }
    } else {
      if (outcome.archive) arc.status = "archived";
      const saveArcResult = await this.arcDb.saveArc(arc);
      if (saveArcResult.isErr()) return err(saveArcResult.error);
    }
    this.logger.trackPoint("arc_saved", { arcId: arc.id });

    const saveSignalResult = await this.arcDb.saveSignal(signal);
    if (saveSignalResult.isErr()) return err(saveSignalResult.error);
    this.logger.trackPoint("signal_saved", { signalId: signal.id, arcId: arc.id });

    const allowedCat = statusToCategory(signal.status);
    if (allowedCat) {
      const statsResult = await this.accountDb.incrementStats(accountId, allowedCat);
      if (statsResult.isErr()) {
        this.logger.warn("Stats increment failed — dashboard may be slightly behind.", { code: "processor.stats_increment_failed", accountId, error: statsResult.error });
      }
    }

    // 12b. Calendar attachment processing — detect .ics, parse, create calendar signal
    // Unexpected exceptions propagate to the caller (SQS retry). Only IcsParseError is caught.
    await this.processCalendarAttachment(signal, arc, accountId, ttl);

    // 13. S3 retention — fire-and-forget (idempotent, always attempted)
    await this.attemptS3Retention(signal, accountCtx, arc);

    // 14. Aurora upserts — gates side-effect dispatch. All clusters must succeed.
    const auroraResult = await this.executeAuroraUpserts(signal, arc);
    if (auroraResult.isErr()) return err(dbError(new Error("Aurora upsert failed")));

    // Dispatch side-effects via SQS after Aurora succeeds
    const dispatchResult = await this.dispatchSideEffects(signal, arc);
    if (dispatchResult.isErr()) return err(dbError(new Error("Side-effect dispatch failed")));

    // Side-effects (forward, auto-reply, auto-draft, notify) are handled by processSideEffect via SQS dispatch.

    const finalRepResult = await this.processingDb.updateGlobalReputation(senderETLD1, {
      wasSpam: classificationOutput.spamScore >= spamScoreThreshold,
      wasBlocked: false,
    });
    if (finalRepResult.isErr()) {
      this.logger.warn("Failed to update global sender reputation after signal processing. The DynamoDB update returned an error. Reputation data may be stale for this domain.", { code: "processor.reputation_update_failed", accountId, error: finalRepResult.error });
    }

    return ok(undefined);
  }

  /**
   * Execute Aurora upserts for all active clusters in parallel.
   * Returns ok if ALL clusters succeed, err if ANY cluster fails.
   * Logs ERROR for primary cluster failures, WARN for non-primary.
   * Upserts are idempotent (ON CONFLICT DO UPDATE) — safe to re-run on every attempt.
   */
  async executeAuroraUpserts(signal: Signal, arc: Arc): Promise<Result<void, DbError>> {
    const activeClusters = getActiveClusters();
    this.logger.trackPoint("aurora_upsert_start", { clusterCount: activeClusters.length });

    const results = await Promise.all(
      activeClusters.map(async (cluster) => {
        const embedding = signal.data.embeddings?.[cluster.modelId];
        if (!embedding) {
          this.logger.info("Aurora upsert skipped for cluster — no embedding available for the cluster's model. This is expected when the embedding generator did not produce a vector for this model (e.g. Bedrock failure for that model).", { code: "processor.aurora_upsert_skipped", accountId: signal.accountId, registryId: cluster.registryId, modelId: cluster.modelId });
          return { cluster, success: true as const };
        }

        let upsertResult: Result<void, DbError>;
        upsertResult = await this.auroraWriter.upsertEmbedding({
          registryId: cluster.registryId,
          arcId: arc.id,
          accountId: signal.accountId,
          recipientAddress: signal.data.recipientAddress,
          embedding,
        });

        if (upsertResult.isErr()) {
          return { cluster, success: false as const, error: upsertResult.error };
        }
        this.logger.trackPoint("aurora_upsert_cluster_complete", { registryId: cluster.registryId });
        return { cluster, success: true as const };
      }),
    );

    const failures = results.filter((r) => !r.success);
    if (failures.length > 0) {
      for (const failure of failures) {
        if (!failure.success) {
          this.logger.error("Failed to upsert embedding to Aurora cluster. The Data API call returned an error for the target cluster. This signal's embedding won't be searchable on that cluster until the next retry succeeds. Check Aurora cluster health in the AWS console.", { code: "processor.aurora_upsert_failed", accountId: signal.accountId, registryId: failure.cluster.registryId, error: failure.error });
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
  async dispatchSideEffects(signal: Signal, arc: Arc): Promise<Result<void, DbError>> {
    this.logger.trackPoint("side_effect_dispatch_start");
    const payload: SideEffectPayload = { signal, arc };
    const sendResult = await this.sqsDispatcher.sendMessage(payload);
    if (sendResult.isErr()) {
      this.logger.error("Failed to dispatch side-effect SQS message. Aurora upserts succeeded but side-effects won't fire until the message is retried and dispatch succeeds. Check SQS queue health and permissions.", { code: "processor.side_effect_dispatch_failed", accountId: signal.accountId, signalId: signal.id, arcId: arc.id, error: sendResult.error });
      return err(sendResult.error);
    }

    this.logger.info("Side-effect SQS message dispatched.", { code: "processor.side_effect_dispatched", signalId: signal.id, arcId: arc.id, accountId: signal.accountId });
    this.logger.trackPoint("side_effect_dispatch_complete");
    return ok(undefined);
  }

  /**
   * Fire-and-forget S3 retention. Always attempted on every delivery (idempotent).
   * Errors are logged at warn level and never propagate — S3 retention failure
   * must not alter the processing outcome or prevent Aurora/side-effect execution.
   */
  async attemptS3Retention(signal: Signal, accountCtx: ProcessorAccountContext, arc: Arc): Promise<void> {
    this.logger.trackPoint("s3_retention_start");
    try {
      const retention = getRetentionForPlan(accountCtx.billingPlan);
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
        this.logger.warn("Failed to apply S3 retention policy to signal object. The S3 tagging or copy operation returned an error. The signal is saved but will use the default 5-year lifecycle rule instead of the plan-specific retention.", { code: "processor.s3_retention_failed", accountId: signal.accountId, error: retentionApplyResult.error });
        return;
      }

      const { s3Key: updatedS3Key } = retentionApplyResult.value;

      // Persist retention metadata on the signal record
      const retentionUpdate: { retentionDuration?: RetentionDuration; s3Key?: string } = {
        retentionDuration: retention.retentionDuration as RetentionDuration,
      };
      if (updatedS3Key !== signal.data.s3Key) {
        retentionUpdate.s3Key = updatedS3Key;
      }
      const retentionSaveResult = await this.arcDb.updateSignalRetention(signal.accountId, signal.signalLookupId, retentionUpdate);
      if (retentionSaveResult.isErr()) {
        this.logger.warn("Failed to persist retention metadata on signal record. The DynamoDB update returned an error. The S3 retention is applied but the signal record won't reflect the retention duration.", { code: "processor.retention_metadata_save_failed", accountId: signal.accountId, error: retentionSaveResult.error });
      }

      // Set TTL on the arc based on retentionDuration
      const ttlSeconds = retentionDurationToSeconds(retention.retentionDuration);
      const arcTtl = Math.floor(Date.now() / 1000) + ttlSeconds;
      arc.ttl = arcTtl;
      this.logger.trackPoint("s3_retention_complete");
    } catch (e) {
      this.logger.warn("S3 retention threw an unexpected error. The signal will use the default lifecycle rule. Processing continues unaffected.", { code: "processor.s3_retention_unexpected", accountId: signal.accountId, error: e });
    }
  }

  /**
   * Detect and process calendar (.ics) attachments on an email signal.
   *
   * On valid parse: creates a calendar signal (source: "signal", type: "calendar_event"),
   * stores raw .ics as S3 attachment, applies system:calendar label to the arc.
   *
   * On parse rejection (IcsParseError): creates a calendar_invite_invalid signal with reason.
   *
   * On unexpected crash: does NOT catch — lets the exception propagate so SQS retries naturally.
   */
  private async processCalendarAttachment(signal: Signal, arc: Arc, accountId: string, ttl?: number): Promise<void> {
    const attachments = signal.data.attachments ?? [];
    const calendarAttachment = findCalendarAttachment(attachments, this.logger);
    if (!calendarAttachment) return;

    this.logger.trackPoint("calendar_attachment_found", { filename: calendarAttachment.filename, mimeType: calendarAttachment.mimeType });

    // Fetch .ics bytes from S3
    const getResult = await this.s3Client.send(new GetObjectCommand({
      Bucket: this.contentBucket,
      Key: calendarAttachment.s3Key,
    }));
    const icsBytes = await getResult.Body!.transformToByteArray();

    // Parse .ics
    const parseResult = parseIcs(new Uint8Array(icsBytes));

    if (parseResult.isErr()) {
      // Parse rejection — create calendar_invite_invalid signal
      const invalidId = generateId("sgn-");
      const invalidTimestamp = DateTime.utc().toISO()!;
      const invalidSignal: Signal<CalendarInviteInvalidData> = {
        id: invalidId,
        signalLookupId: invalidId,
        arcId: arc.id,
        accountId,
        source: "signal",
        type: "calendar_invite_invalid",
        status: "active",
        createdAt: invalidTimestamp,
        ...(ttl !== undefined ? { ttl } : {}),
        data: {
          reason: parseResult.error.reason,
          linkedSignalId: signal.id,
        },
      };
      const saveInvalidResult = await this.arcDb.saveSignal(invalidSignal);
      if (saveInvalidResult.isErr()) {
        this.logger.warn("Failed to save calendar_invite_invalid signal.", { code: "system_signal.write_failed", accountId, type: "calendar_invite_invalid", error: saveInvalidResult.error });
      }
      this.logger.warn("Calendar attachment rejected by ICS parser.", { code: "processor.calendar.parse_rejected", accountId, signalId: signal.id, reason: parseResult.error.reason });
      return;
    }

    // Valid parse — create calendar signal
    const { calendarData, rawIcsContent } = parseResult.value;
    const calendarSignalId = generateId("sgn-");
    const calendarTimestamp = DateTime.utc().toISO()!;
    const signalLookupId = buildCalendarSignalLookupId(calendarData.organizer, calendarData.veventUid);

    // Store raw .ics as S3 attachment on the calendar signal
    const icsS3Key = `content/accounts/${accountId}/calendar/${calendarSignalId}/invite.ics`;
    await this.s3Client.send(new PutObjectCommand({
      Bucket: this.contentBucket,
      Key: icsS3Key,
      Body: Buffer.from(rawIcsContent, "utf-8"),
      ContentType: "text/calendar",
    }));

    // Build calendar signal with linkedSignalId pointing to the email signal
    const calendarSignal: Signal<CalendarEventData> = {
      id: calendarSignalId,
      signalLookupId,
      arcId: arc.id,
      accountId,
      source: "signal",
      type: "calendar_event",
      status: "active",
      createdAt: calendarTimestamp,
      ...(ttl !== undefined ? { ttl } : {}),
      data: {
        ...calendarData,
        linkedSignalId: signal.id,
      },
    };

    const saveCalResult = await this.arcDb.saveSignal(calendarSignal);
    if (saveCalResult.isErr()) {
      this.logger.warn("Failed to save calendar_event signal.", { code: "system_signal.write_failed", accountId, type: "calendar_event", error: saveCalResult.error });
      return;
    }

    // Apply system:calendar label to the arc
    if (!arc.labels.includes("system:calendar")) {
      arc.labels = [...arc.labels, "system:calendar"];
      const updateResult = await this.arcDb.updateArc(accountId, arc.id, arc.status, arc.lastSignalAt!, { labels: arc.labels });
      if (updateResult.isErr()) {
        this.logger.warn("Failed to apply system:calendar label to arc.", { code: "processor.calendar.label_failed", accountId, arcId: arc.id, error: updateResult.error });
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
          signalId: calendarSignalId,
          arcId: arc.id,
          fireAt,
          suffix,
          sqsMessageAttributeMessageType: "signal_followup",
        });
        if (scheduleResult.isErr()) {
          this.logger.error("Failed to create calendar day-of schedule.", { code: "processor.calendar.schedule_failed", accountId, arcId: arc.id, signalId: calendarSignalId, fireAt, error: scheduleResult.error });
        }
      }
    }

    // Schedule an RSVP reminder 24h before event start (only for REQUEST invites)
    if (calendarData.method?.toUpperCase() === "REQUEST") {
      if (!calendarData.startTime) {
        this.logger.warn("Calendar REQUEST missing startTime — skipping RSVP schedule.", { code: "processor.calendar.rsvp_missing_start_time", accountId, arcId: arc.id, signalId: calendarSignalId });
      } else {
        const eventStart = DateTime.fromISO(calendarData.startTime, { zone: "utc" });
        if (!eventStart.isValid) {
          this.logger.warn("Calendar REQUEST has invalid startTime — skipping RSVP schedule.", { code: "processor.calendar.rsvp_invalid_start_time", accountId, arcId: arc.id, signalId: calendarSignalId, startTime: calendarData.startTime });
        } else {
          const now = DateTime.utc();
          const reminderTime = eventStart.minus({ hours: RSVP_REMINDER_HOURS_BEFORE });
          if (reminderTime > now) {
            const fireAt = reminderTime.toISO()!;
            const suffix = `rsvp.${eventStart.toFormat("yyyyMMdd")}`;
            const rsvpResult = await this.schedulerClient.createFollowup({
              accountId,
              signalId: calendarSignalId,
              arcId: arc.id,
              fireAt,
              suffix,
              sqsMessageAttributeMessageType: "rsvp_reminder",
            });
            if (rsvpResult.isErr()) {
              this.logger.error("Failed to create RSVP reminder schedule.", {
                code: "processor.calendar.rsvp_schedule_failed",
                accountId, arcId: arc.id, signalId: calendarSignalId, fireAt,
                error: rsvpResult.error,
              });
            }
          }
        }
      }
    }

    // Inject forwardCalendarInvite action into the signal's matchedRules so the
    // side-effect handler triggers forwarding. The system rule (SR-26) won't match
    // on the first signal because the label is applied after rule evaluation.
    const existingRules = signal.data.matchedRules ?? [];
    const hasCalendarForward = existingRules.some(r => r.actions.some(a => a.type === "forwardCalendarInvite"));
    if (!hasCalendarForward) {
      signal.data.matchedRules = [
        ...existingRules,
        { ruleId: "SR-26", actions: [{ type: "forwardCalendarInvite" }], labelsAdded: [] },
      ];
    }

    this.logger.info("Calendar signal created from .ics attachment.", { code: "processor.calendar.signal_created", accountId, calendarSignalId, emailSignalId: signal.id, arcId: arc.id, method: calendarData.method, veventUid: calendarData.veventUid });
    this.logger.trackPoint("calendar_signal_created", { calendarSignalId });
  }

  private async autoApprove(
    accountId: string,
    address: string,
    senderETLD1: string,
    existing: Alias | null,
    defaultUnknownSenderPolicy: AccountFilteringConfig["defaultUnknownSenderPolicy"] = "quarantine_visible",
  ): Promise<Result<void, DbError>> {
    const now = DateTime.utc().toISO()!;
    if (!existing) {
      const aliasResult = await this.accountDb.saveAlias({
        id: address,
        accountId,
        address,
        domain: address.split("@")[1]!,
        alias: address.split("@")[0]!,
        unknownSenderPolicy: defaultUnknownSenderPolicy,
        createdAt: now,
        updatedAt: now,
      });
      if (aliasResult.isErr()) return err(aliasResult.error);
    }
    const senderResult = await this.accountDb.saveSender(accountId, address, senderETLD1, "allow");
    if (senderResult.isErr()) return err(senderResult.error);
    return ok(undefined);
  }

  private async annotateTemplateError(accountId: string, templateId: string, functionName: string, error: { message: string; type: string } | null): Promise<void> {
    const errorMessage = error
      ? `[${error.type}] ${error.message}`
      : "Function returned no value";
    try {
      await this.accountDb.annotateTemplateError(accountId, templateId, functionName, errorMessage);
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

function buildSignal(opts: {
  arcId?: string;
  status: Signal["status"];
  accountId: string;
  sesMessageId: string;
  recipientAddress: string;
  parsed: ParsedMime;
  classification: ClassificationOutput;
  s3Key: string;
  receivedAt: string;
  now: string;
  ttl?: number;
}): Signal {
  const { arcId, status, accountId, sesMessageId, recipientAddress, parsed, classification, s3Key, receivedAt, now, ttl } = opts;
  const signalId = generateId("sgn-");
  const signal: Signal = {
    id: signalId,
    signalLookupId: "ses-" + sesMessageId,
    accountId,
    source: "email",
    type: "email",
    status,
    createdAt: now,
    data: {
      sesMessageId,
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
      spamScore: classification.spamScore,
      summary: classification.summary,
      s3Key,
      ...(parsed.replyTo !== undefined ? { replyTo: parsed.replyTo } : {}),
      ...(parsed.textBody !== undefined ? { textBody: parsed.textBody } : {}),
      ...(parsed.htmlBody != null ? { htmlBody: parsed.htmlBody } : {}),
      ...(parsed.sentAt !== undefined ? { sentAt: parsed.sentAt } : {}),
    },
  };

  if (arcId !== undefined) signal.arcId = arcId;
  if (ttl !== undefined) signal.ttl = ttl;

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


export function deriveGroupingKey(
  workflow: Workflow,
  workflowData: WorkflowData,
  recipientAddress: string,
  senderETLD1: string,
): string | null {
  const base = `${recipientAddress}:${workflow}`;

  switch (workflow) {
    case "auth":
    case "content":
    case "onboarding":
    case "status":
    case "payments":
    case "alert":
    case "test":
      return `${base}:${senderETLD1}`;

    case "package": {
      const { orderNumber } = workflowData as { orderNumber?: string };
      return orderNumber ? `${base}:${orderNumber}` : null;
    }

    case "support": {
      const { ticketId } = workflowData as { ticketId?: string };
      return ticketId ? `${base}:${ticketId}` : null;
    }

    default:
      return null;
  }
}
