import { randomUUID } from "crypto";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { ResultAsync } from "neverthrow";
import type { Logger } from "../logger.js";
import type { Result } from "neverthrow";
import { ok, err, dbError, processError } from "../errors.js";
import type { DbError, InvalidResponseError, ProcessError } from "../errors.js";
import type { Signal, Arc, Rule, Workflow, WorkflowData, Alias, AliasSender, SenderMode, AccountFilteringConfig, SignalSource, SignalStatus, Domain, ArcUrgency, SenderFilterMode, MatchedRuleResult } from "../types/index.js";
import type { MimeParser, ParsedMime } from "./mime.js";
import { buildEmbedText, extractEmbedTextInput } from "../embedding/embed-text.js";
import type { SignalClassifier } from "../classifier/classifier.js";
import type { EmbeddingGenerator } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { S3RetentionService } from "../embedding/s3-retention-service.js";
import { getRetentionForPlan, retentionDurationToSeconds } from "../embedding/retention-tier.js";
import type { BillingPlan } from "../embedding/retention-tier.js";
import { getReadCluster, getActiveClusters } from "../embedding/cluster-registry.js";
import { getETLD1, assignSystemLabels, DEFAULT_SPAM_SCORE_THRESHOLD } from "./filter.js";

const RETRY_TRACK_THRESHOLD = 30;

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type ProcessorMessageType = "inbound_signal" | "side_effect";

export interface SideEffectPayload {
  signal: Signal;
  arc: Arc;
}

export interface SqsDispatcher {
  sendMessage(payload: SideEffectPayload): ResultAsync<void, DbError>;
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ProcessorAccountContext {
  retentionDays: number;
  filtering: AccountFilteringConfig | null;
  emailConfig: Alias | null;
  registeredDomains: string[];
  userEmails: string[];
  billingPlan: BillingPlan;
}

export interface ProcessorDatabase {
  getSignalByMessageId(accountId: string, sesMessageId: string): ResultAsync<Signal | null, DbError>;
  saveSignal(signal: Signal): ResultAsync<void, DbError>;
  updateSignalRetention(accountId: string, signalId: string, update: Partial<Pick<Signal, "s3Key" | "retentionDuration">>): ResultAsync<void, DbError>;
  getArc(accountId: string, id: string): ResultAsync<Arc | null, DbError>;
  findArcByGroupingKey(accountId: string, key: string): ResultAsync<Arc | null, DbError>;
  saveArc(arc: Arc): ResultAsync<void, DbError>;
  listEnabledRules(accountId: string): ResultAsync<Rule[], DbError>;
  getProcessorAccountContext(accountId: string, recipientAddress: string): ResultAsync<ProcessorAccountContext, DbError> | Promise<ResultAsync<ProcessorAccountContext, DbError>>;
  saveAlias(alias: Alias): ResultAsync<Alias, DbError>;
  getSender(accountId: string, address: string, domain: string): ResultAsync<AliasSender | null, DbError>;
  saveSender(accountId: string, address: string, domain: string, mode: SenderMode): ResultAsync<void, DbError>;
  getTemplate(accountId: string, id: string): ResultAsync<import("../types/index.js").EmailTemplate | null, DbError>;
  updateGlobalReputation(domain: string, update: { wasSpam: boolean; wasBlocked: boolean }): ResultAsync<void, DbError>;
  getDomainByName(accountId: string, domainName: string): ResultAsync<Domain | null, DbError>;
}

export interface ArcMatcher {
  findMatch(accountId: string, recipientAddress: string, embedding: number[]): ResultAsync<Arc | null, DbError>;
  upsertEmbedding(arcId: string, embedding: number[], accountId: string, recipientAddress: string): ResultAsync<void, DbError>;
}

export interface RuleEvaluator {
  evaluate(rule: Rule, context: { signal: Signal; arc: Arc; isMatchedArc: boolean }): Promise<boolean>;
}

export interface Notifier {
  notify(accountId: string, arc: Arc, signal: Signal): ResultAsync<void, DbError>;
  notifyBlocked(accountId: string, signal: Signal): ResultAsync<void, DbError>;
}

export interface ForwardOptions {
  senderDomain: string;
  dkimPass: boolean;
  dmarcPass: boolean;
}

export interface Forwarder {
  forward(s3Key: string, toAddress: string, accountId: string, opts: ForwardOptions): ResultAsync<void, DbError>;
}

export interface TestReplier {
  pong(opts: {
    to: string;
    from: string;
    subject: string;
    body: string;
    inReplyTo: string;
  }): Promise<{ messageId: string }>;
}

type SesVerdict = "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED";

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

interface InboundSignalMessage {
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
  block: boolean;
  quarantine: boolean;
  quarantineHidden: boolean;  // true → quarantine_hidden status; false → quarantine_visible
  approveSender: boolean;
  archive: boolean;
  delete: boolean;
  urgency?: ArcUrgency;
  suppressNotification: boolean;
  forwardAddresses: string[];
  additionalLabels: string[];
  doPong: boolean;
  autoReplyTemplateIds: string[];
  autoDraftTemplateIds: string[];
}

function emptyOutcome(): ProcessingOutcome {
  return {
    block: false,
    quarantine: false,
    quarantineHidden: false,
    approveSender: false,
    archive: false,
    delete: false,
    suppressNotification: false,
    forwardAddresses: [],
    additionalLabels: [],
    doPong: false,
    autoReplyTemplateIds: [],
    autoDraftTemplateIds: [],
  };
}

async function applyRules(
  rules: Rule[],
  context: { signal: Signal; arc: Arc; isMatchedArc: boolean },
  evaluator: RuleEvaluator,
): Promise<MatchedRuleResult[]> {
  const matchedRules: MatchedRuleResult[] = [];
  for (const rule of rules) {
    if (!await evaluator.evaluate(rule, context)) continue;
    const actions = rule.actions.filter((a) => !a.disabled).map(({ type, value }) => ({ type, ...(value !== undefined ? { value } : {}) }));
    const labelsAdded = actions.filter((a) => a.type === "assign_label" && a.value).map((a) => a.value!);
    const statusChange: MatchedRuleResult["statusChange"] = (
      actions.some((a) => a.type === "block")             ? "blocked"            :
      actions.some((a) => a.type === "quarantine_hidden") ? "quarantine_hidden"  :
      actions.some((a) => a.type === "quarantine")        ? "quarantine_visible" :
      actions.some((a) => a.type === "archive")           ? "archived"           :
      actions.some((a) => a.type === "delete")            ? "deleted"            :
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
        case "block":
          if (!statusSet) { outcome.block = true; statusSet = true; }
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
        case "delete":
          if (!statusSet) { outcome.delete = true; statusSet = true; }
          break;
        case "approve_sender":        outcome.approveSender = true; break;
        case "suppress_notification": outcome.suppressNotification = true; break;
        case "set_urgency":           if (!urgencySet && action.value) { outcome.urgency = action.value as ArcUrgency; urgencySet = true; } break;
        case "assign_label":          if (action.value) outcome.additionalLabels.push(action.value); break;
        case "forward":               if (action.value) outcome.forwardAddresses.push(action.value); break;
        case "pong":                  outcome.doPong = true; break;
        case "auto_reply":            if (action.value) outcome.autoReplyTemplateIds.push(action.value); break;
        case "auto_draft":            if (action.value) outcome.autoDraftTemplateIds.push(action.value); break;
      }
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// System rules — seeded into every new account; users can disable individually
// ---------------------------------------------------------------------------

const in_ = (label: string) => ({ "in": [label, { "var": "arc.labels" }] });
const wf_ = (w: string) => ({ "==": [{ "var": "signal.workflow" }, w] });
const wfData_ = (field: string) => ({ "var": `signal.workflowData.${field}` });

export const SYSTEM_RULES: Rule[] = [
  // --- Sender / content gating (1–8) ----------------------------------------
  { id: "SR-14", accountId: "SYSTEM", name: "Auto-approve sender on matched conversation", condition: JSON.stringify({ "and": [in_("system:workflow:conversation"), in_("system:sender:untrusted"), { "var": "isMatchedArc" }] }), actions: [{ type: "approve_sender" }], status: "enabled", priorityOrder: 1, createdAt: "", updatedAt: "" },
  { id: "SR-01", accountId: "SYSTEM", name: "Block onboarding emails", condition: JSON.stringify(in_("system:workflow:onboarding")), actions: [{ type: "block" }], status: "enabled", priorityOrder: 2, createdAt: "", updatedAt: "" },
  { id: "SR-05", accountId: "SYSTEM", name: "Block status emails", condition: JSON.stringify(in_("system:workflow:status")), actions: [{ type: "block" }], status: "enabled", priorityOrder: 3, createdAt: "", updatedAt: "" },
  { id: "SR-03", accountId: "SYSTEM", name: "Quarantine high-spam signals", condition: JSON.stringify(in_("system:spam:high")), actions: [{ type: "quarantine" }], status: "enabled", priorityOrder: 4, createdAt: "", updatedAt: "" },
  { id: "SR-04", accountId: "SYSTEM", name: "Suppress notification for medium spam", condition: JSON.stringify(in_("system:spam:medium")), actions: [{ type: "suppress_notification" }], status: "enabled", priorityOrder: 6, createdAt: "", updatedAt: "" },
  { id: "SR-06", accountId: "SYSTEM", name: "Suppress notification for status emails", condition: JSON.stringify(in_("system:workflow:status")), actions: [{ type: "suppress_notification" }], status: "enabled", priorityOrder: 7, createdAt: "", updatedAt: "" },
  { id: "SR-07", accountId: "SYSTEM", name: "Suppress notification for content emails", condition: JSON.stringify(in_("system:workflow:content")), actions: [{ type: "suppress_notification" }], status: "enabled", priorityOrder: 8, createdAt: "", updatedAt: "" },
  // --- Workflow-specific urgency (9–18) ----------------------------------------
  // conversation: high when reply is needed and tone is urgent/negative
  { id: "SR-15", accountId: "SYSTEM", name: "Conversation: high urgency when reply needed and urgent/negative", condition: JSON.stringify({ "and": [wf_("conversation"), { "==": [wfData_("requiresReply"), true] }, { "in": [wfData_("sentiment"), ["urgent", "negative"]] }] }), actions: [{ type: "set_urgency", value: "high" }], status: "enabled", priorityOrder: 9, createdAt: "", updatedAt: "" },
  { id: "SR-16", accountId: "SYSTEM", name: "Conversation: low urgency when user has never replied", condition: JSON.stringify({ "and": [wf_("conversation"), { "!": [in_("system:replied")] }] }), actions: [{ type: "set_urgency", value: "low" }], status: "enabled", priorityOrder: 10, createdAt: "", updatedAt: "" },
  // crm: contract/proposal always warrant a decision — treat as high regardless of urgency field
  { id: "SR-17", accountId: "SYSTEM", name: "CRM: high urgency for contracts and proposals", condition: JSON.stringify({ "and": [wf_("crm"), { "in": [wfData_("crmType"), ["contract", "proposal"]] }] }), actions: [{ type: "set_urgency", value: "high" }], status: "enabled", priorityOrder: 11, createdAt: "", updatedAt: "" },
  { id: "SR-18", accountId: "SYSTEM", name: "CRM: high urgency when urgency field is high", condition: JSON.stringify({ "and": [wf_("crm"), { "==": [wfData_("urgency"), "high"] }] }), actions: [{ type: "set_urgency", value: "high" }], status: "enabled", priorityOrder: 12, createdAt: "", updatedAt: "" },
  { id: "SR-19", accountId: "SYSTEM", name: "CRM: low urgency for low-priority outreach", condition: JSON.stringify({ "and": [wf_("crm"), { "==": [wfData_("urgency"), "low"] }, { "!": [in_("system:replied")] }] }), actions: [{ type: "set_urgency", value: "low" }], status: "enabled", priorityOrder: 13, createdAt: "", updatedAt: "" },
  // support: priority field drives urgency; urgent > priority-based > awaiting_response > lifecycle
  { id: "SR-20", accountId: "SYSTEM", name: "Support: critical urgency for urgent-priority tickets", condition: JSON.stringify({ "and": [wf_("support"), { "==": [wfData_("priority"), "urgent"] }] }), actions: [{ type: "set_urgency", value: "critical" }], status: "enabled", priorityOrder: 14, createdAt: "", updatedAt: "" },
  { id: "SR-21", accountId: "SYSTEM", name: "Support: high urgency for high-priority tickets", condition: JSON.stringify({ "and": [wf_("support"), { "==": [wfData_("priority"), "high"] }] }), actions: [{ type: "set_urgency", value: "high" }], status: "enabled", priorityOrder: 15, createdAt: "", updatedAt: "" },
  { id: "SR-22", accountId: "SYSTEM", name: "Support: high urgency when agent is awaiting response", condition: JSON.stringify({ "and": [wf_("support"), { "==": [wfData_("eventType"), "awaiting_response"] }] }), actions: [{ type: "set_urgency", value: "high" }], status: "enabled", priorityOrder: 16, createdAt: "", updatedAt: "" },
  { id: "SR-23", accountId: "SYSTEM", name: "Support: low urgency for low-priority tickets", condition: JSON.stringify({ "and": [wf_("support"), { "==": [wfData_("priority"), "low"] }, { "!": [in_("system:replied")] }] }), actions: [{ type: "set_urgency", value: "low" }], status: "enabled", priorityOrder: 17, createdAt: "", updatedAt: "" },
  // ticket_opened/resolved/closed are passive lifecycle events — low unless urgency field says otherwise (fired after priority rules so those win)
  { id: "SR-24", accountId: "SYSTEM", name: "Support: low urgency for passive lifecycle events", condition: JSON.stringify({ "and": [wf_("support"), { "in": [wfData_("eventType"), ["ticket_opened", "ticket_resolved", "ticket_closed"]] }, { "!": [in_("system:replied")] }] }), actions: [{ type: "set_urgency", value: "low" }], status: "enabled", priorityOrder: 18, createdAt: "", updatedAt: "" },
  { id: "SR-13", accountId: "SYSTEM", name: "Auto-reply to test emails (pong)", condition: JSON.stringify(in_("system:test")), actions: [{ type: "pong" }], status: "enabled", priorityOrder: 19, createdAt: "", updatedAt: "" },
];

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

interface SignalProcessorOptions {
  store: ProcessorDatabase;
  mimeParser: MimeParser;
  classifier: Pick<SignalClassifier, "classify">;
  embeddingGenerator: EmbeddingGenerator;
  auroraWriter: MultiClusterAuroraWriter;
  arcMatcher: ArcMatcher;
  ruleEvaluator: RuleEvaluator;
  logger: Logger;
  notifier?: Notifier;
  forwarder?: Forwarder;
  testReplier?: TestReplier;
  retentionService?: S3RetentionService;
  sqsDispatcher?: SqsDispatcher;
}

export class SignalProcessor {
  private readonly store: ProcessorDatabase;
  private readonly mimeParser: MimeParser;
  private readonly classifier: Pick<SignalClassifier, "classify">;
  private readonly embeddingGenerator: EmbeddingGenerator;
  private readonly auroraWriter: MultiClusterAuroraWriter;
  private readonly arcMatcher: ArcMatcher;
  private readonly ruleEvaluator: RuleEvaluator;
  private readonly logger: Logger;
  private readonly notifier: Notifier | undefined;
  private readonly forwarder: Forwarder | undefined;
  private readonly testReplier: TestReplier | undefined;
  private readonly retentionService: S3RetentionService | undefined;
  private readonly sqsDispatcher: SqsDispatcher | undefined;

  constructor(opts: SignalProcessorOptions) {
    this.store = opts.store;
    this.mimeParser = opts.mimeParser;
    this.classifier = opts.classifier;
    this.embeddingGenerator = opts.embeddingGenerator;
    this.auroraWriter = opts.auroraWriter;
    this.arcMatcher = opts.arcMatcher;
    this.ruleEvaluator = opts.ruleEvaluator;
    this.logger = opts.logger;
    this.notifier = opts.notifier;
    this.forwarder = opts.forwarder;
    this.testReplier = opts.testReplier;
    this.retentionService = opts.retentionService;
    this.sqsDispatcher = opts.sqsDispatcher;
  }

  async processRecord(record: SQSRecord): Promise<Result<void, ProcessError>> {
    const receiveCount = Number(record.attributes?.ApproximateReceiveCount ?? "1");

    // Parse the SQS message body
    let message: InboundSignalMessage;
    try {
      const sns = JSON.parse(record.body) as { Message: string };
      const notification = JSON.parse(sns.Message) as SesReceiptNotification & { accountId?: string };
      message = {
        accountId: notification.accountId ?? notification.mail.destination[0]!,
        s3Key: notification.receipt.action.objectKey,
        sesMessageId: notification.mail.messageId,
        timestamp: notification.mail.timestamp,
        destination: notification.mail.destination,
        dkimVerdict: notification.receipt.dkimVerdict.status,
        dmarcVerdict: notification.receipt.dmarcVerdict.status,
      };
    } catch (e) {
      this.logger.error("Failed to parse inbound signal from SQS record. The JSON payload could not be deserialized as a valid SES notification. This message will be retried.", { code: "processor.parse_failed", error: e, record });
      return err(processError(record.messageId));
    }

    // On redelivery, check DDB for existing signal before doing expensive work
    if (receiveCount > 1) {
      this.logger.info("Retry path activated — checking DDB for existing signal state before re-processing.", { code: "processor.retry_path_activated", receiveCount, accountId: message.accountId, sesMessageId: message.sesMessageId });

      const existingResult = await this.store.getSignalByMessageId(message.accountId, message.sesMessageId);
      if (existingResult.isErr()) return err(processError(record.messageId));
      this.logger.trackPoint("retry_signal_lookup");

      if (existingResult.value) {
        const signal = existingResult.value;
        this.logger.info("Signal found in DDB on retry — resuming from Aurora upserts.", { code: "processor.retry_signal_found", signalId: signal.id, arcId: signal.arcId, accountId: message.accountId, sesMessageId: message.sesMessageId, receiveCount });

        // Signal exists — arc is guaranteed to exist (arc saved before signal).
        // Load arc to resume from the convergence point.
        if (!signal.arcId) return err(processError(record.messageId));
        const arcResult = await this.store.getArc(message.accountId, signal.arcId);
        if (arcResult.isErr()) return err(processError(record.messageId));
        this.logger.trackPoint("retry_arc_lookup");
        const arc = arcResult.value;
        if (!arc) return err(processError(record.messageId));

        // Fetch account context (needed for S3 retention)
        const accountCtxResultAsync = await this.store.getProcessorAccountContext(message.accountId, signal.recipientAddress);
        const accountCtxResult = await accountCtxResultAsync;
        if (accountCtxResult.isErr()) return err(processError(record.messageId));
        const accountCtx = accountCtxResult.value;

        // S3 retention — always attempt, fire-and-forget (idempotent)
        await this.attemptS3Retention(signal, accountCtx, arc);

        // Aurora upserts — always run (idempotent). Gates side-effect dispatch.
        const auroraResult = await this.executeAuroraUpserts(signal, arc);
        if (auroraResult.isErr()) return err(processError(record.messageId));

        // Dispatch side-effects via SQS after Aurora succeeds
        const dispatchResult = await this.dispatchSideEffects(signal, arc);
        if (dispatchResult.isErr()) return err(processError(record.messageId));

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
      return err(processError(record.messageId));
    }
    if (processResult.isErr()) return err(processError(record.messageId));

    return ok(undefined);
  }

  async process(event: SQSEvent): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
    this.logger.startInvocation();

    const failures: Array<{ itemIdentifier: string }> = [];

    for (const record of event.Records) {
      const messageType = record.messageAttributes?.["messageType"]?.stringValue ?? "inbound_signal";

      const result = messageType === "side_effect"
        ? await this.processSideEffectRecord(record)
        : await this.processRecord(record);

      if (result.isErr()) {
        const receiveCount = Number(record.attributes?.ApproximateReceiveCount ?? "1");
        const level = receiveCount > RETRY_TRACK_THRESHOLD ? "error" : "warn";
        if (level === "error") {
          this.logger.error("Signal processing failed after exceeding retry threshold. SQS message was redelivered " + receiveCount + " times without successful completion. The message will keep being redelivered indefinitely until the root cause is fixed. Investigate earlier track-level logs for this messageId to identify the failure.", { code: "processor.signal.failed", messageId: result.error.messageId, receiveCount });
        } else {
          this.logger.warn("Signal processing failed on attempt " + receiveCount + ". The SQS message will be retried automatically. If this pattern persists at high volume, investigate the root cause in earlier logs for this messageId.", { code: "processor.signal.failed", messageId: result.error.messageId, receiveCount });
        }
        failures.push({ itemIdentifier: record.messageId });
      }
    }

    return { batchItemFailures: failures };
  }

  private async processSideEffectRecord(record: SQSRecord): Promise<Result<void, ProcessError>> {
    // Parse SideEffectPayload from record body
    let payload: SideEffectPayload;
    try {
      payload = JSON.parse(record.body) as SideEffectPayload;
      if (!payload.signal || !payload.arc) throw new Error("Missing signal or arc in payload");
    } catch (e) {
      this.logger.error("Malformed side-effect payload — cannot parse. Dropping message to prevent infinite retry of unparseable content.", { code: "processor.side_effect.malformed_payload", messageId: record.messageId, error: e });
      return ok(undefined);
    }

    const { signal, arc } = payload;
    const accountId = signal.accountId;

    // Re-derive outcome from persisted matchedRules
    const outcome = deriveOutcome(signal.matchedRules ?? []);

    this.logger.trackPoint("side_effect_received");

    // Determine which effect types will execute
    const effectTypes: string[] = [];
    if (outcome.forwardAddresses.length > 0) effectTypes.push("forward");
    if (!outcome.suppressNotification) effectTypes.push("notify");
    if (outcome.doPong) effectTypes.push("pong");
    if (outcome.autoReplyTemplateIds.length > 0) effectTypes.push("auto_reply");
    if (outcome.autoDraftTemplateIds.length > 0) effectTypes.push("auto_draft");
    this.logger.info("Outcome derived from matchedRules — executing side-effects.", { code: "processor.side_effect.outcome_derived", accountId, signalId: signal.id, arcId: arc.id, effectTypes });

    // Execute all indicated side-effects — individual failures are logged and do NOT cause batchItemFailure

    // Forward
    if (this.forwarder && outcome.forwardAddresses.length > 0) {
      for (const toAddress of outcome.forwardAddresses) {
        try {
          this.logger.trackPoint("side_effect_forward_start");
          const forwardResult = await this.forwarder.forward(signal.s3Key, toAddress, accountId, {
            senderDomain: getETLD1(signal.from.address),
            dkimPass: false,
            dmarcPass: false,
          });
          if (forwardResult.isErr()) {
            this.logger.error("Side-effect forward failed. The SES send-raw-email call returned an error. The recipient won't receive the forwarded copy.", { code: "processor.side_effect.forward_failed", accountId, toAddress, error: forwardResult.error });
          }
          this.logger.trackPoint("side_effect_forward_complete");
        } catch (e) {
          this.logger.error("Side-effect forward threw unexpectedly.", { code: "processor.side_effect.forward_error", accountId, toAddress, error: e });
        }
      }
    }

    // Notify
    if (this.notifier && !outcome.suppressNotification) {
      try {
        this.logger.trackPoint("side_effect_notify_start");
        const notifyResult = await this.notifier.notify(accountId, arc, signal);
        if (notifyResult.isErr()) {
          this.logger.track("Side-effect notification failed.", { code: "processor.side_effect.notify_failed", accountId, error: notifyResult.error });
        }
        this.logger.trackPoint("side_effect_notify_complete");
      } catch (e) {
        this.logger.error("Side-effect notification threw unexpectedly.", { code: "processor.side_effect.notify_error", accountId, error: e });
      }
    }

    // Pong
    if (outcome.doPong && this.testReplier) {
      try {
        this.logger.trackPoint("side_effect_pong_start");
        const from = signal.recipientAddress;
        await this.testReplier.pong({
          to: signal.from.address,
          from,
          subject: signal.subject ?? "",
          body: signal.textBody ?? "",
          inReplyTo: signal.id,
        });
        this.logger.trackPoint("side_effect_pong_complete");
      } catch (e) {
        this.logger.error("Side-effect pong failed.", { code: "processor.side_effect.pong_failed", accountId, error: e });
      }
    }

    // Auto-reply
    if (this.testReplier && outcome.autoReplyTemplateIds.length > 0) {
      try {
        this.logger.trackPoint("side_effect_auto_reply_start");
        const recipientDomain = signal.recipientAddress.split("@")[1] ?? "";
        const domainResult = await this.store.getDomainByName(accountId, recipientDomain);
        if (domainResult.isOk() && domainResult.value?.senderSetupComplete) {
          const vars = {
            "signal.subject": signal.subject ?? "",
            "sender.name": signal.from.name ?? "",
            "sender.address": signal.from.address,
            "arc.workflow": signal.workflow ?? "",
          };
          for (const templateId of outcome.autoReplyTemplateIds) {
            const tmplResult = await this.store.getTemplate(accountId, templateId);
            if (tmplResult.isErr() || !tmplResult.value) continue;
            const tmpl = tmplResult.value;
            await this.testReplier.pong({
              to: signal.from.address,
              from: signal.recipientAddress,
              subject: renderTemplate(tmpl.subject, vars),
              body: renderTemplate(tmpl.body, vars),
              inReplyTo: signal.id,
            });
          }
        }
        this.logger.trackPoint("side_effect_auto_reply_complete");
      } catch (e) {
        this.logger.error("Side-effect auto-reply failed.", { code: "processor.side_effect.auto_reply_failed", accountId, error: e });
      }
    }

    // Auto-draft
    if (outcome.autoDraftTemplateIds.length > 0) {
      try {
        this.logger.trackPoint("side_effect_auto_draft_start");
        const now = new Date().toISOString();
        const vars = {
          "signal.subject": signal.subject ?? "",
          "sender.name": signal.from.name ?? "",
          "sender.address": signal.from.address,
          "arc.workflow": signal.workflow ?? "",
        };
        for (const templateId of outcome.autoDraftTemplateIds) {
          const tmplResult = await this.store.getTemplate(accountId, templateId);
          if (tmplResult.isErr() || !tmplResult.value) continue;
          const tmpl = tmplResult.value;
          const draft: Signal = {
            id: `USR#${randomUUID()}`,
            arcId: arc.id,
            accountId,
            source: "user",
            status: "draft",
            receivedAt: now,
            from: { address: signal.recipientAddress },
            to: [signal.from],
            cc: [],
            subject: renderTemplate(tmpl.subject, vars),
            textBody: renderTemplate(tmpl.body, vars),
            attachments: [],
            headers: {},
            recipientAddress: signal.from.address,
            workflow: signal.workflow,
            workflowData: signal.workflowData,
            spamScore: 0,
            summary: "",
            classificationModelId: "",
            s3Key: "",
            createdAt: now,
          };
          const draftSaveResult = await this.store.saveSignal(draft);
          if (draftSaveResult.isErr()) {
            this.logger.error("Side-effect auto-draft save failed.", { code: "processor.side_effect.auto_draft_failed", accountId, error: draftSaveResult.error });
          }
        }
        this.logger.trackPoint("side_effect_auto_draft_complete");
      } catch (e) {
        this.logger.error("Side-effect auto-draft threw unexpectedly.", { code: "processor.side_effect.auto_draft_error", accountId, error: e });
      }
    }

    this.logger.trackPoint("side_effect_all_complete");
    return ok(undefined);
  }

  private async processMessage(msg: InboundSignalMessage): Promise<Result<void, DbError | InvalidResponseError>> {
    const { accountId, s3Key, sesMessageId, timestamp, destination } = msg;

    // 1. Dedup
    const existingResult = await this.store.getSignalByMessageId(accountId, sesMessageId);
    if (existingResult.isErr()) return err(existingResult.error);
    if (existingResult.value) return ok(undefined);

    // 2. Parse MIME
    const parsedResult = await this.mimeParser.parse(s3Key);
    if (parsedResult.isErr()) return err(parsedResult.error);
    const parsed = parsedResult.value;
    this.logger.trackPoint("email_parsed");

    const recipientAddress = destination[0] ?? "";
    const senderETLD1 = getETLD1(parsed.from.address);

    // 3. Build EmbedTextInput and construct embed text
    // Reuses existing MIME parser; ensures from / reply-to / return-path / subject / text body extraction
    const embedTextInput = extractEmbedTextInput(parsed, accountId, recipientAddress);
    const embedText = buildEmbedText(embedTextInput);

    // Phase 1: Primary embedding (fail-hard) — must succeed for arc matching
    const readCluster = getReadCluster();
    const [primaryResult, classification] = await Promise.all([
      this.embeddingGenerator.generateForModel(embedText, readCluster.modelId),
      this.classifier.classify({
        from: parsed.from.address,
        to: parsed.to.map((a) => a.address),
        subject: parsed.subject,
        ...(parsed.textBody != null && { textBody: parsed.textBody }),
        ...(parsed.htmlBody != null && { htmlBody: parsed.htmlBody }),
        headers: parsed.headers,
        receivedAt: timestamp,
      }),
    ]);

    if (primaryResult.isErr()) {
      this.logger.error("Primary embedding generation failed. The Bedrock InvokeModel call for the read cluster returned an error. Arc matching cannot proceed without a valid vector — the message will be retried via batch item failure.", { code: "embedding.primary_failed", modelId: readCluster.modelId, error: primaryResult.error });
      return err(dbError(primaryResult.error.cause));
    }
    const embedding = primaryResult.value.vector;
    this.logger.trackPoint("email_processed");

    const now = new Date().toISOString();

    // 4. Fetch account context + sender entry in parallel
    const [accountCtxResultAsync, senderEntryResult] = await Promise.all([
      this.store.getProcessorAccountContext(accountId, recipientAddress),
      this.store.getSender(accountId, recipientAddress, senderETLD1),
    ]);
    const accountCtxResult = await accountCtxResultAsync;
    if (accountCtxResult.isErr()) return err(accountCtxResult.error);
    const accountCtx = accountCtxResult.value;
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
      classification.workflow = "test";
      classification.workflowData = { workflow: "test", triggeredBy: "user" };
    }

    const spamScoreThreshold =
      accountCtx.emailConfig?.spamScoreThreshold ??
      accountCtx.filtering?.spamScoreThreshold ??
      DEFAULT_SPAM_SCORE_THRESHOLD;

    // 6. Arc matching
    const groupingKey = deriveGroupingKey(classification.workflow, classification.workflowData, recipientAddress, senderETLD1);
    this.logger.trackPoint("arc_matcher_values_generated");
    let matchedArc: Arc | null;
    this.logger.trackPoint("arc_match_search");
    if (groupingKey) {
      this.logger.trackPoint("arc_matcher_grouping_key_lookup");
      const gkResult = await this.store.findArcByGroupingKey(accountId, groupingKey);
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
        workflow: classification.workflow,
        summary: classification.summary,
        updatedAt: now,
      };
      this.logger.info("Existing arc matched.", { code: "processor.arc_matched", arcId: arc.id, matchMethod: groupingKey ? "groupingKey" : "similarity", accountId, sesMessageId });
    } else {
      arc = {
        id: randomUUID(),
        accountId,
        ...(groupingKey ? { groupingKey } : {}),
        workflow: classification.workflow,
        labels: [],
        status: "active",
        summary: classification.summary,
        lastSignalAt: timestamp,
        createdAt: now,
        updatedAt: now,
        ...(ttl !== undefined ? { ttl } : {}),
      };
      this.logger.info("New arc created.", { code: "processor.arc_created", arcId: arc.id, accountId, sesMessageId, ...(groupingKey ? { groupingKey } : {}) });
    }

    // 8. Assign system labels and merge classifier labels
    const emailConfig = accountCtx.emailConfig;
    const effectiveFilterMode: SenderFilterMode = emailConfig
      ? emailConfig.filterMode
      : accountCtx.filtering?.newAddressHandling === "block_until_approved"
        ? "quarantine_visible"
        : "allow_all";
    // When no alias exists for the recipient, sender entries don't apply — treat as no entry
    const effectiveSenderEntry = emailConfig ? senderEntry : null;
    const systemLabels = assignSystemLabels({
      workflow: classification.workflow,
      workflowData: classification.workflowData,
      spamScore: classification.spamScore,
      spamScoreThreshold,
      senderETLD1,
      senderEntry: effectiveSenderEntry,
      filterMode: effectiveFilterMode,
      hasSentMessages: (arc.sentMessageIds?.length ?? 0) > 0,
    });

    for (const label of [...systemLabels, ...classification.labels]) {
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
      classification,
      s3Key,
      receivedAt: timestamp,
      now,
      ...(ttl !== undefined ? { ttl } : {}),
    });

    // 10. Evaluate all rules (system rules seeded at low position numbers, user rules at higher positions)
    const rulesResult = await this.store.listEnabledRules(accountId);
    if (rulesResult.isErr()) return err(rulesResult.error);
    const rules = rulesResult.value;
    const matchedRules = await applyRules(rules, { signal: signalShell, arc, isMatchedArc }, this.ruleEvaluator);
    const outcome = deriveOutcome(matchedRules);
    this.logger.trackPoint("rules_evaluated", { matchedRuleCount: matchedRules.length });

    // Fallback: if no rule set a status, apply filter mode for untrusted senders
    const hasStatusOutcome = outcome.block || outcome.quarantine || outcome.archive || outcome.delete;
    if (!hasStatusOutcome && arc.labels.includes("system:sender:untrusted")) {
      switch (effectiveFilterMode) {
        case "block":              outcome.block = true; break;
        case "quarantine_hidden":  outcome.quarantine = true; outcome.quarantineHidden = true; break;
        case "quarantine_visible": outcome.quarantine = true; break;
        // "allow_all": signal proceeds as active
      }
    }

    const buildArgs = { accountId, sesMessageId, recipientAddress, parsed, classification, s3Key, receivedAt: timestamp, now, ...(ttl !== undefined ? { ttl } : {}) };

    if (outcome.block) {
      const saveResult = await this.store.saveSignal({ ...buildSignal({ status: "blocked", ...buildArgs }), matchedRules });
      if (saveResult.isErr()) return err(saveResult.error);
      const repResult = await this.store.updateGlobalReputation(senderETLD1, { wasSpam: classification.spamScore >= spamScoreThreshold, wasBlocked: true });
      if (repResult.isErr()) {
        this.logger.warn("Failed to update global sender reputation after signal processing. The DynamoDB update returned an error. Reputation data may be stale for this domain.", { code: "processor.reputation_update_failed", accountId, error: repResult.error });
      }
      return ok(undefined);
    }

    // approveSender overrides quarantine — SR-14 (auto-approve on matched conversation) fires before SR-02
    if (outcome.quarantine && !outcome.approveSender) {
      const quarantineStatus = outcome.quarantineHidden ? "quarantine_hidden" : "quarantine_visible";
      const quarantinedSignal: Signal = { ...buildSignal({ status: quarantineStatus, ...buildArgs }), matchedRules };
      const saveResult = await this.store.saveSignal(quarantinedSignal);
      if (saveResult.isErr()) return err(saveResult.error);
      if (this.notifier && !outcome.quarantineHidden) {
        const notifyResult = await this.notifier.notifyBlocked(accountId, quarantinedSignal);
        if (notifyResult.isErr()) {
          this.logger.track("Failed to send quarantine notification to user. The notification service returned an error. The signal is quarantined but the user won't be alerted. Tracked for notification reliability monitoring.", { code: "processor.quarantine_notification_failed", accountId, error: notifyResult.error });
        }
      }
      const repResult = await this.store.updateGlobalReputation(senderETLD1, { wasSpam: classification.spamScore >= spamScoreThreshold, wasBlocked: true });
      if (repResult.isErr()) {
        this.logger.warn("Failed to update global sender reputation after signal processing. The DynamoDB update returned an error. Reputation data may be stale for this domain.", { code: "processor.reputation_update_failed", accountId, error: repResult.error });
      }
      return ok(undefined);
    }

    // Auto-approve: sender gets added to approvedSenders when approve_sender fires, allow_all mode, or brand-new address with auto-allow policy
    if (outcome.approveSender || effectiveFilterMode === "allow_all") {
      const approveResult = await this.autoApprove(accountId, recipientAddress, senderETLD1, emailConfig, accountCtx.filtering?.defaultFilterMode);
      if (approveResult.isErr()) return err(approveResult.error);
    }

    // 11. Apply outcome to arc
    // Don't bump lastSignalAt when a rule archives an incoming signal onto an existing arc — prevents status/notice emails from pushing an arc to the top of the inbox
    if (!matchedArc || !outcome.archive) arc.lastSignalAt = timestamp;

    for (const label of outcome.additionalLabels) {
      if (!arc.labels.includes(label)) arc.labels = [...arc.labels, label];
    }
    if (outcome.archive) arc.status = "archived";
    if (outcome.delete) { arc.status = "deleted"; arc.deletedAt = now; }

    const signalUrgency = outcome.urgency ?? arc.urgency ?? "normal";
    if (!matchedArc) arc.urgency = signalUrgency;

    const signal: Signal = { ...signalShell, arcId: arc.id, matchedRules, urgency: signalUrgency };
    this.logger.trackPoint("arc_updated", { arcId: arc.id });

    // 12. Pong (driven by SR-13 rule action)
    if (outcome.doPong && this.testReplier) {
      const recipientDomain = recipientAddress.split("@")[1] ?? "";
      const domainResult = await this.store.getDomainByName(accountId, recipientDomain);
      if (domainResult.isErr()) return err(domainResult.error);
      const domain = domainResult.value;
      const from = domain?.senderSetupComplete
        ? recipientAddress
        : (process.env["NOTIFICATION_FROM"] ?? recipientAddress);
      const pongResult = await ResultAsync.fromPromise(
        this.testReplier.pong({
          to: parsed.from.address,
          from,
          subject: parsed.subject,
          body: parsed.textBody ?? parsed.htmlBody ?? "",
          inReplyTo: sesMessageId,
        }),
        (e) => dbError(e instanceof Error ? e : new Error(String(e))),
      );
      if (pongResult.isErr()) {
        this.logger.error("Failed to send pong reply to test email sender. The SES send call returned an error. The sender won't receive the automated test confirmation. Check SES sending limits and verify the from-address domain is configured.", { code: "processor.pong_reply_failed", accountId, error: pongResult.error });
      } else if (pongResult.value) {
        arc.sentMessageIds = [...(arc.sentMessageIds ?? []), pongResult.value.messageId];
      }
    }

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
    signal.embeddings = embeddings;

    // Save arc (leaf node) before signal (dependent node) — guarantees arc exists whenever signal exists
    const saveArcResult = await this.store.saveArc(arc);
    if (saveArcResult.isErr()) return err(saveArcResult.error);
    this.logger.trackPoint("arc_saved", { arcId: arc.id });

    const saveSignalResult = await this.store.saveSignal(signal);
    if (saveSignalResult.isErr()) return err(saveSignalResult.error);
    this.logger.trackPoint("signal_saved", { signalId: signal.id, arcId: arc.id });

    // 13. S3 retention — fire-and-forget (idempotent, always attempted)
    await this.attemptS3Retention(signal, accountCtx, arc);

    // 14. Aurora upserts — gates side-effect dispatch. All clusters must succeed.
    const auroraResult = await this.executeAuroraUpserts(signal, arc);
    if (auroraResult.isErr()) return err(dbError(new Error("Aurora upsert failed")));

    // Dispatch side-effects via SQS after Aurora succeeds
    const dispatchResult = await this.dispatchSideEffects(signal, arc);
    if (dispatchResult.isErr()) return err(dbError(new Error("Side-effect dispatch failed")));

    // 16. Forward
    if (this.forwarder && outcome.forwardAddresses.length > 0) {
      const forwardOpts: ForwardOptions = {
        senderDomain: senderETLD1,
        dkimPass: msg.dkimVerdict === "PASS",
        dmarcPass: msg.dmarcVerdict === "PASS",
      };
      for (const toAddress of outcome.forwardAddresses) {
        const forwardResult = await this.forwarder.forward(s3Key, toAddress, accountId, forwardOpts);
        if (forwardResult.isErr()) {
          this.logger.error("Failed to forward email to configured address. The SES send-raw-email call returned an error. The recipient won't receive the forwarded copy. Check SES sending quota and verify the forward address isn't suppressed.", { code: "processor.forward_failed", accountId, toAddress, error: forwardResult.error });
        }
      }
    }

    // 15. Auto-reply (fire-and-forget composed emails from templates)
    if (this.testReplier && outcome.autoReplyTemplateIds.length > 0) {
      const recipientDomain = recipientAddress.split("@")[1] ?? "";
      const autoReplyDomainResult = await this.store.getDomainByName(accountId, recipientDomain);
      if (autoReplyDomainResult.isOk() && autoReplyDomainResult.value?.senderSetupComplete) {
        const vars = {
          "signal.subject": parsed.subject,
          "sender.name": parsed.from.name ?? "",
          "sender.address": parsed.from.address,
          "arc.workflow": classification.workflow,
        };
        for (const templateId of outcome.autoReplyTemplateIds) {
          const tmplResult = await this.store.getTemplate(accountId, templateId);
          if (tmplResult.isErr() || !tmplResult.value) continue;
          const tmpl = tmplResult.value;
          const replyResult = await ResultAsync.fromPromise(
            this.testReplier.pong({
              to: parsed.from.address,
              from: recipientAddress,
              subject: renderTemplate(tmpl.subject, vars),
              body: renderTemplate(tmpl.body, vars),
              inReplyTo: sesMessageId,
            }),
            (e) => dbError(e instanceof Error ? e : new Error(String(e))),
          );
          if (replyResult.isErr()) {
            this.logger.error("Failed to send auto-reply from template. The SES send call returned an error. The sender won't receive the automated response. Check SES limits and template configuration.", { code: "processor.auto_reply_failed", accountId, error: replyResult.error });
          } else if (replyResult.value) {
            arc.sentMessageIds = [...(arc.sentMessageIds ?? []), replyResult.value.messageId];
          }
        }
      }
    }

    // Note: arc was saved earlier (before signal). Later mutations (TTL from S3 retention,
    // sentMessageIds from auto-reply) will be persisted when side-effects move to a separate handler.

    // 16. Auto-draft (create held draft signals from templates)
    if (outcome.autoDraftTemplateIds.length > 0) {
      const vars = {
        "signal.subject": parsed.subject,
        "sender.name": parsed.from.name ?? "",
        "sender.address": parsed.from.address,
        "arc.workflow": classification.workflow,
      };
      for (const templateId of outcome.autoDraftTemplateIds) {
        const tmplResult = await this.store.getTemplate(accountId, templateId);
        if (tmplResult.isErr() || !tmplResult.value) continue;
        const tmpl = tmplResult.value;
        const draft: Signal = {
          id: `USR#${randomUUID()}`,
          arcId: arc.id,
          accountId,
          source: "user",
          status: "draft",
          receivedAt: now,
          from: { address: recipientAddress },
          to: [parsed.from],
          cc: [],
          subject: renderTemplate(tmpl.subject, vars),
          textBody: renderTemplate(tmpl.body, vars),
          attachments: [],
          headers: {},
          recipientAddress: parsed.from.address,
          workflow: classification.workflow,
          workflowData: classification.workflowData,
          spamScore: 0,
          summary: "",
          classificationModelId: "",
          s3Key: "",
          createdAt: now,
          ...(ttl !== undefined ? { ttl } : {}),
        };
        const draftSaveResult = await this.store.saveSignal(draft);
        if (draftSaveResult.isErr()) {
          this.logger.track("Failed to save auto-draft signal from template. The DynamoDB put returned an error. The draft won't appear in the user's arc. Tracked for auto-draft feature reliability.", { code: "processor.auto_draft_save_failed", accountId, error: draftSaveResult.error });
        }
      }
    }

    // 17. Notify
    if (this.notifier && !outcome.suppressNotification) {
      const notifyResult = await this.notifier.notify(accountId, arc, signal);
      if (notifyResult.isErr()) {
        this.logger.track("Failed to send new-signal notification to user. The notification service returned an error. The signal is processed but the user won't be alerted. Tracked for notification reliability monitoring.", { code: "processor.notification_failed", accountId, error: notifyResult.error });
      }
    }

    const finalRepResult = await this.store.updateGlobalReputation(senderETLD1, {
      wasSpam: classification.spamScore >= spamScoreThreshold,
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
  async executeAuroraUpserts(signal: Signal, arc: Arc): Promise<Result<void, ProcessError>> {
    const activeClusters = getActiveClusters();
    this.logger.trackPoint("aurora_upsert_start", { clusterCount: activeClusters.length });

    const results = await Promise.all(
      activeClusters.map(async (cluster) => {
        const embedding = signal.embeddings?.[cluster.modelId];
        if (!embedding) {
          this.logger.info("Aurora upsert skipped for cluster — no embedding available for the cluster's model. This is expected when the embedding generator did not produce a vector for this model (e.g. Bedrock failure for that model).", { code: "processor.aurora_upsert_skipped", accountId: signal.accountId, clusterId: cluster.clusterId, modelId: cluster.modelId });
          return { cluster, success: true as const };
        }

        const upsertResult = await ResultAsync.fromPromise(
          this.auroraWriter.upsertEmbedding({
            clusterId: cluster.clusterId,
            arcId: arc.id,
            accountId: signal.accountId,
            recipientAddress: signal.recipientAddress,
            embedding,
          }),
          (e) => dbError(e instanceof Error ? e : new Error(String(e))),
        );

        if (upsertResult.isErr()) {
          return { cluster, success: false as const, error: upsertResult.error };
        }
        this.logger.trackPoint("aurora_upsert_cluster_complete", { clusterId: cluster.clusterId });
        return { cluster, success: true as const };
      }),
    );

    const failures = results.filter((r) => !r.success);
    if (failures.length > 0) {
      for (const failure of failures) {
        if (!failure.success) {
          this.logger.error("Failed to upsert embedding to Aurora cluster. The Data API call returned an error for the target cluster. This signal's embedding won't be searchable on that cluster until the next retry succeeds. Check Aurora cluster health in the AWS console.", { code: "processor.aurora_upsert_failed", accountId: signal.accountId, clusterId: failure.cluster.clusterId, error: failure.error });
        }
      }
      return err(processError(signal.id));
    }

    this.logger.trackPoint("aurora_upsert_all_complete");
    return ok(undefined);
  }

  /**
   * Dispatch side-effects as a separate SQS message after Aurora upserts succeed.
   * If sqsDispatcher is not provided (backward compatibility during rollout),
   * returns ok(undefined) — side-effects execute inline as they do today.
   * If the SQS send fails, returns err — this causes a batchItemFailure so the
   * message is retried (Aurora succeeded but side-effects won't fire without dispatch).
   */
  async dispatchSideEffects(signal: Signal, arc: Arc): Promise<Result<void, ProcessError>> {
    if (!this.sqsDispatcher) return ok(undefined);

    this.logger.trackPoint("side_effect_dispatch_start");
    const payload: SideEffectPayload = { signal, arc };
    const sendResult = await this.sqsDispatcher.sendMessage(payload);
    if (sendResult.isErr()) {
      this.logger.error("Failed to dispatch side-effect SQS message. Aurora upserts succeeded but side-effects won't fire until the message is retried and dispatch succeeds. Check SQS queue health and permissions.", { code: "processor.side_effect_dispatch_failed", accountId: signal.accountId, signalId: signal.id, arcId: arc.id, error: sendResult.error });
      return err(processError(signal.id));
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
    if (!this.retentionService) return;

    this.logger.trackPoint("s3_retention_start");
    try {
      const retention = getRetentionForPlan(accountCtx.billingPlan);
      const retentionApplyResult = await ResultAsync.fromPromise(
        this.retentionService.applyPlanRetention(signal.s3Key, {
          s3Tag: retention.s3Tag,
          copyToSaved: retention.copyToSaved,
        }),
        (e) => dbError(e instanceof Error ? e : new Error(String(e))),
      );
      if (retentionApplyResult.isErr()) {
        this.logger.warn("Failed to apply S3 retention policy to signal object. The S3 tagging or copy operation returned an error. The signal is saved but will use the default 5-year lifecycle rule instead of the plan-specific retention.", { code: "processor.s3_retention_failed", accountId: signal.accountId, error: retentionApplyResult.error });
        return;
      }

      const { s3Key: updatedS3Key } = retentionApplyResult.value;

      // Persist retention metadata on the signal record
      const retentionUpdate: Partial<Pick<Signal, "s3Key" | "retentionDuration">> = {
        retentionDuration: retention.retentionDuration,
      };
      if (updatedS3Key !== signal.s3Key) {
        retentionUpdate.s3Key = updatedS3Key;
      }
      const retentionSaveResult = await this.store.updateSignalRetention(signal.accountId, signal.id, retentionUpdate);
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

  private async autoApprove(
    accountId: string,
    address: string,
    senderETLD1: string,
    existing: Alias | null,
    defaultFilterMode: AccountFilteringConfig["defaultFilterMode"] = "quarantine_visible",
  ): Promise<Result<void, DbError>> {
    const now = new Date().toISOString();
    if (!existing) {
      const aliasResult = await this.store.saveAlias({
        id: randomUUID(),
        accountId,
        address,
        filterMode: defaultFilterMode,
        createdAt: now,
        updatedAt: now,
      });
      if (aliasResult.isErr()) return err(aliasResult.error);
    }
    const senderResult = await this.store.saveSender(accountId, address, senderETLD1, "allow");
    if (senderResult.isErr()) return err(senderResult.error);
    return ok(undefined);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => vars[key.trim()] ?? "");
}

function buildSignal(opts: {
  arcId?: string;
  status: Signal["status"];
  accountId: string;
  sesMessageId: string;
  recipientAddress: string;
  parsed: ParsedMime;
  classification: Awaited<ReturnType<SignalClassifier["classify"]>>;
  s3Key: string;
  receivedAt: string;
  now: string;
  ttl?: number;
}): Signal {
  const { arcId, status, accountId, sesMessageId, recipientAddress, parsed, classification, s3Key, receivedAt, now, ttl } = opts;
  const signal: Signal = {
    id: `SES#${sesMessageId}`,
    accountId,
    source: "email",
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
    classificationModelId: classification.classificationModelId,
    s3Key,
    status,
    createdAt: now,
  };

  if (arcId !== undefined) signal.arcId = arcId;
  if (parsed.replyTo !== undefined) signal.replyTo = parsed.replyTo;
  if (parsed.textBody !== undefined) signal.textBody = parsed.textBody;
  if (parsed.htmlBody != null) signal.htmlBody = parsed.htmlBody;
  if (parsed.sentAt !== undefined) signal.sentAt = parsed.sentAt;
  if (ttl !== undefined) signal.ttl = ttl;

  return signal;
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
