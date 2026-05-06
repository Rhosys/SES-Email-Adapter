import { randomUUID } from "crypto";
import type { SQSEvent } from "aws-lambda";
import type { Signal, Arc, Rule, Workflow, WorkflowData, Alias, AccountFilteringConfig, SignalSource, SchedulingData, SignalStatus, Domain, ArcUrgency, SenderFilterMode, MatchedRuleResult } from "../types/index.js";
import { baseUrgency } from "./priority.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier } from "../classifier/classifier.js";
import { getETLD1, assignSystemLabels, DEFAULT_SPAM_SCORE_THRESHOLD } from "./filter.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ProcessorAccountContext {
  retentionDays: number;
  filtering: AccountFilteringConfig | null;
  emailConfig: Alias | null;
  registeredDomains: string[];
  userEmails: string[];
}

export interface ProcessorDatabase {
  getSignalByMessageId(accountId: string, sesMessageId: string): Promise<Pick<Signal, "id"> | null>;
  saveSignal(signal: Signal): Promise<void>;
  getArc(accountId: string, id: string): Promise<Arc | null>;
  findArcByGroupingKey(accountId: string, key: string): Promise<Arc | null>;
  saveArc(arc: Arc): Promise<void>;
  listEnabledRules(accountId: string): Promise<Rule[]>;
  getProcessorAccountContext(accountId: string, recipientAddress: string): Promise<ProcessorAccountContext>;
  saveAlias(alias: Alias): Promise<Alias>;
  updateGlobalReputation(domain: string, update: { wasSpam: boolean; wasBlocked: boolean }): Promise<void>;
  getDomainByName(accountId: string, domainName: string): Promise<Pick<Domain, "senderSetupComplete"> | null>;
}

export interface ArcMatcher {
  findMatch(accountId: string, recipientAddress: string, embedding: number[]): Promise<Arc | null>;
  upsertEmbedding(arcId: string, embedding: number[], accountId: string, recipientAddress: string): Promise<void>;
}

export interface RuleEvaluator {
  evaluate(rule: Rule, context: { signal: Signal; arc: Arc; isMatchedArc: boolean }): boolean;
}

export interface Notifier {
  notify(accountId: string, arc: Arc, signal: Signal): Promise<void>;
  notifyBlocked(accountId: string, signal: Signal): Promise<void>;
}

export interface ForwardOptions {
  senderDomain: string;
  dkimPass: boolean;
  dmarcPass: boolean;
}

export interface Forwarder {
  forward(s3Key: string, toAddress: string, accountId: string, opts: ForwardOptions): Promise<void>;
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
  approveSender: boolean;
  archive: boolean;
  delete: boolean;
  urgency?: ArcUrgency;
  suppressNotification: boolean;
  forwardAddresses: string[];
  additionalLabels: string[];
  doPong: boolean;
}

function emptyOutcome(): ProcessingOutcome {
  return {
    block: false,
    quarantine: false,
    approveSender: false,
    archive: false,
    delete: false,
    suppressNotification: false,
    forwardAddresses: [],
    additionalLabels: [],
    doPong: false,
  };
}

function applyRules(
  rules: Rule[],
  context: { signal: Signal; arc: Arc; isMatchedArc: boolean },
  evaluator: RuleEvaluator,
  outcome: ProcessingOutcome,
): { outcome: ProcessingOutcome; matchedRules: MatchedRuleResult[] } {
  const matchedRules: MatchedRuleResult[] = [];
  for (const rule of rules) {
    if (!evaluator.evaluate(rule, context)) continue;
    const result: MatchedRuleResult = {
      ruleId: rule.id,
      ruleName: rule.name,
      actions: rule.actions.filter((a) => !a.disabled),
      labelsAdded: [],
    };
    for (const action of rule.actions) {
      if (action.disabled) continue;
      switch (action.type) {
        case "block":                 outcome.block = true; if (!result.statusChange) result.statusChange = "blocked"; break;
        case "quarantine":            outcome.quarantine = true; if (!result.statusChange) result.statusChange = "quarantined"; break;
        case "approve_sender":        outcome.approveSender = true; break;
        case "archive":               outcome.archive = true; if (!result.statusChange) result.statusChange = "archived"; break;
        case "delete":                outcome.delete = true; if (!result.statusChange) result.statusChange = "deleted"; break;
        case "suppress_notification": outcome.suppressNotification = true; break;
        case "set_urgency":           if (action.value) outcome.urgency = action.value as ArcUrgency; break;
        case "assign_label":          if (action.value) { outcome.additionalLabels.push(action.value); result.labelsAdded.push(action.value); } break;
        case "assign_workflow":       if (action.value) context.arc.workflow = action.value as Workflow; break;
        case "forward":               if (action.value) outcome.forwardAddresses.push(action.value); break;
        case "pong":                  outcome.doPong = true; break;
      }
    }
    matchedRules.push(result);
  }
  return { outcome, matchedRules };
}

// ---------------------------------------------------------------------------
// System rules — seeded into every new account; users can disable individually
// ---------------------------------------------------------------------------

const in_ = (label: string) => ({ "in": [label, { "var": "arc.labels" }] });

export const SYSTEM_RULES: Rule[] = [
  { id: "SR-14", accountId: "SYSTEM", name: "Auto-approve sender on matched conversation", condition: JSON.stringify({ "and": [in_("system:workflow:conversation"), in_("system:sender:untrusted"), { "var": "isMatchedArc" }] }), actions: [{ type: "approve_sender" }], status: "enabled", priorityOrder: 1, createdAt: "", updatedAt: "" },
  { id: "SR-01", accountId: "SYSTEM", name: "Block onboarding emails", condition: JSON.stringify(in_("system:workflow:onboarding")), actions: [{ type: "block" }], status: "enabled", priorityOrder: 2, createdAt: "", updatedAt: "" },
  { id: "SR-02", accountId: "SYSTEM", name: "Quarantine untrusted senders", condition: JSON.stringify(in_("system:sender:untrusted")), actions: [{ type: "quarantine" }], status: "enabled", priorityOrder: 3, createdAt: "", updatedAt: "" },
  { id: "SR-03", accountId: "SYSTEM", name: "Quarantine high-spam signals", condition: JSON.stringify(in_("system:spam:high")), actions: [{ type: "quarantine" }], status: "enabled", priorityOrder: 4, createdAt: "", updatedAt: "" },
  { id: "SR-04", accountId: "SYSTEM", name: "Suppress notification for medium spam", condition: JSON.stringify(in_("system:spam:medium")), actions: [{ type: "suppress_notification" }], status: "enabled", priorityOrder: 5, createdAt: "", updatedAt: "" },
  { id: "SR-05", accountId: "SYSTEM", name: "Auto-archive status emails", condition: JSON.stringify(in_("system:workflow:status")), actions: [{ type: "archive" }], status: "enabled", priorityOrder: 6, createdAt: "", updatedAt: "" },
  { id: "SR-06", accountId: "SYSTEM", name: "Suppress notification for status emails", condition: JSON.stringify(in_("system:workflow:status")), actions: [{ type: "suppress_notification" }], status: "enabled", priorityOrder: 7, createdAt: "", updatedAt: "" },
  { id: "SR-07", accountId: "SYSTEM", name: "Suppress notification for content emails", condition: JSON.stringify(in_("system:workflow:content")), actions: [{ type: "suppress_notification" }], status: "enabled", priorityOrder: 8, createdAt: "", updatedAt: "" },
  { id: "SR-08", accountId: "SYSTEM", name: "Set urgency: critical", condition: JSON.stringify(in_("system:urgency:critical")), actions: [{ type: "set_urgency", value: "critical" }], status: "enabled", priorityOrder: 9, createdAt: "", updatedAt: "" },
  { id: "SR-09", accountId: "SYSTEM", name: "Set urgency: high", condition: JSON.stringify(in_("system:urgency:high")), actions: [{ type: "set_urgency", value: "high" }], status: "enabled", priorityOrder: 10, createdAt: "", updatedAt: "" },
  { id: "SR-10", accountId: "SYSTEM", name: "Set urgency: normal", condition: JSON.stringify(in_("system:urgency:normal")), actions: [{ type: "set_urgency", value: "normal" }], status: "enabled", priorityOrder: 11, createdAt: "", updatedAt: "" },
  { id: "SR-11", accountId: "SYSTEM", name: "Set urgency: low", condition: JSON.stringify(in_("system:urgency:low")), actions: [{ type: "set_urgency", value: "low" }], status: "enabled", priorityOrder: 12, createdAt: "", updatedAt: "" },
  { id: "SR-12", accountId: "SYSTEM", name: "Set urgency: silent", condition: JSON.stringify(in_("system:urgency:silent")), actions: [{ type: "set_urgency", value: "silent" }], status: "enabled", priorityOrder: 13, createdAt: "", updatedAt: "" },
  { id: "SR-13", accountId: "SYSTEM", name: "Auto-reply to test emails (pong)", condition: JSON.stringify(in_("system:test")), actions: [{ type: "pong" }], status: "enabled", priorityOrder: 14, createdAt: "", updatedAt: "" },
];

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

interface SignalProcessorOptions {
  store: ProcessorDatabase;
  mimeParser: MimeParser;
  classifier: Pick<SignalClassifier, "classify" | "embed">;
  arcMatcher: ArcMatcher;
  ruleEvaluator: RuleEvaluator;
  notifier?: Notifier;
  forwarder?: Forwarder;
  testReplier?: TestReplier;
}

export class SignalProcessor {
  private readonly store: ProcessorDatabase;
  private readonly mimeParser: MimeParser;
  private readonly classifier: Pick<SignalClassifier, "classify" | "embed">;
  private readonly arcMatcher: ArcMatcher;
  private readonly ruleEvaluator: RuleEvaluator;
  private readonly notifier: Notifier | undefined;
  private readonly forwarder: Forwarder | undefined;
  private readonly testReplier: TestReplier | undefined;

  constructor(opts: SignalProcessorOptions) {
    this.store = opts.store;
    this.mimeParser = opts.mimeParser;
    this.classifier = opts.classifier;
    this.arcMatcher = opts.arcMatcher;
    this.ruleEvaluator = opts.ruleEvaluator;
    this.notifier = opts.notifier;
    this.forwarder = opts.forwarder;
    this.testReplier = opts.testReplier;
  }

  async process(event: SQSEvent): Promise<void> {
    for (const record of event.Records) {
      try {
        const sns = JSON.parse(record.body) as { Message: string };
        const notification = JSON.parse(sns.Message) as SesReceiptNotification & { accountId?: string };
        const msg: InboundSignalMessage = {
          accountId: notification.accountId ?? notification.mail.destination[0]!,
          s3Key: notification.receipt.action.objectKey,
          sesMessageId: notification.mail.messageId,
          timestamp: notification.mail.timestamp,
          destination: notification.mail.destination,
          dkimVerdict: notification.receipt.dkimVerdict.status,
          dmarcVerdict: notification.receipt.dmarcVerdict.status,
        };
        await this.processMessage(msg);
      } catch (err) {
        console.error("Failed to process SQS record:", err);
      }
    }
  }

  private async processMessage(msg: InboundSignalMessage): Promise<void> {
    const { accountId, s3Key, sesMessageId, timestamp, destination } = msg;

    // 1. Dedup
    const existing = await this.store.getSignalByMessageId(accountId, sesMessageId);
    if (existing) return;

    // 2. Parse MIME
    const parsed = await this.mimeParser.parse(s3Key);

    const recipientAddress = destination[0] ?? "";
    const senderETLD1 = getETLD1(parsed.from.address);

    // 3. Embed + classify in parallel
    const embedText = [parsed.subject, parsed.textBody ?? ""].join(" ").slice(0, 4000);
    const [embedding, classification] = await Promise.all([
      this.classifier.embed(embedText),
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

    const now = new Date().toISOString();

    // 4. Fetch account context
    const accountCtx = await this.store.getProcessorAccountContext(accountId, recipientAddress);
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
    const matchedArc = groupingKey
      ? await this.store.findArcByGroupingKey(accountId, groupingKey)
      : await this.arcMatcher.findMatch(accountId, recipientAddress, embedding);

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
    }

    // 8. Assign system labels and merge classifier labels
    const emailConfig = accountCtx.emailConfig;
    // Brand-new address (null emailConfig) with auto-allow account policy → treat as allow_all for label purposes
    const effectiveFilterMode: SenderFilterMode = emailConfig
      ? emailConfig.filterMode
      : accountCtx.filtering?.newAddressHandling === "block_until_approved"
        ? "notify_new"
        : "allow_all";
    const systemLabels = assignSystemLabels({
      workflow: classification.workflow,
      workflowData: classification.workflowData,
      spamScore: classification.spamScore,
      spamScoreThreshold,
      senderETLD1,
      approvedSenders: emailConfig?.approvedSenders ?? [],
      filterMode: effectiveFilterMode,
      hasSentMessages: (arc.sentMessageIds?.length ?? 0) > 0,
    });

    for (const label of [...systemLabels, ...classification.labels]) {
      if (!arc.labels.includes(label)) arc.labels = [...arc.labels, label];
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
    const rules = await this.store.listEnabledRules(accountId);
    const { outcome, matchedRules } = applyRules(rules, { signal: signalShell, arc, isMatchedArc }, this.ruleEvaluator, emptyOutcome());

    // Block/quarantine: approveSender overrides quarantine (SR-14 fires before SR-02)
    if (outcome.block || (outcome.quarantine && !outcome.approveSender)) {
      const status: SignalStatus = outcome.quarantine ? "quarantined" : "blocked";
      const blockedSignal: Signal = {
        ...buildSignal({
          status,
          accountId,
          sesMessageId,
          recipientAddress,
          parsed,
          classification,
          s3Key,
          receivedAt: timestamp,
          now,
          ...(ttl !== undefined ? { ttl } : {}),
        }),
        matchedRules,
      };
      await this.store.saveSignal(blockedSignal);
      if (status === "quarantined" && this.notifier) {
        await this.notifier.notifyBlocked(accountId, blockedSignal).catch((err) => {
          console.error("Quarantine notification failed:", err);
        });
      }
      this.store.updateGlobalReputation(senderETLD1, {
        wasSpam: classification.spamScore >= spamScoreThreshold,
        wasBlocked: true,
      }).catch((err) => console.error("Reputation update failed:", err));
      return;
    }

    // Auto-approve: sender gets added to approvedSenders when approve_sender fires, allow_all mode, or brand-new address with auto-allow policy
    if (outcome.approveSender || effectiveFilterMode === "allow_all") {
      await this.autoApprove(accountId, recipientAddress, senderETLD1, emailConfig, accountCtx.filtering?.defaultFilterMode);
    }

    // 11. Apply outcome to arc
    // Don't bump lastSignalAt when a rule archives an incoming signal onto an existing arc — prevents status/notice emails from pushing an arc to the top of the inbox
    if (!matchedArc || !outcome.archive) arc.lastSignalAt = timestamp;

    for (const label of outcome.additionalLabels) {
      if (!arc.labels.includes(label)) arc.labels = [...arc.labels, label];
    }
    if (outcome.archive) arc.status = "archived";
    if (outcome.delete) { arc.status = "deleted"; arc.deletedAt = now; }
    if (outcome.urgency) arc.urgency = outcome.urgency;
    // Fall back to baseUrgency if no set_urgency rule fired
    if (!arc.urgency) arc.urgency = baseUrgency(arc.workflow, classification.workflowData);

    const signal: Signal = { ...signalShell, arcId: arc.id, matchedRules };

    // 12. Pong (driven by SR-13 rule action)
    if (outcome.doPong && this.testReplier) {
      const recipientDomain = recipientAddress.split("@")[1] ?? "";
      const domain = await this.store.getDomainByName(accountId, recipientDomain);
      const from = domain?.senderSetupComplete
        ? recipientAddress
        : (process.env["NOTIFICATION_FROM"] ?? recipientAddress);
      const pongResult = await this.testReplier.pong({
        to: parsed.from.address,
        from,
        subject: parsed.subject,
        body: parsed.textBody ?? parsed.htmlBody ?? "",
        inReplyTo: sesMessageId,
      }).catch((err) => {
        console.error("Pong reply failed:", err);
        return null;
      });
      if (pongResult) {
        arc.sentMessageIds = [...(arc.sentMessageIds ?? []), pongResult.messageId];
      }
    }

    await this.store.saveArc(arc);
    await this.store.saveSignal(signal);

    // 13. Calendar synthetic signal
    if (classification.workflow === "scheduling") {
      const calSignal = buildCalendarSignal(arc, signal, now, ttl);
      await this.store.saveSignal(calSignal);
    }

    await this.arcMatcher.upsertEmbedding(arc.id, embedding, accountId, recipientAddress);

    // 14. Forward
    if (this.forwarder && outcome.forwardAddresses.length > 0) {
      const forwardOpts: ForwardOptions = {
        senderDomain: senderETLD1,
        dkimPass: msg.dkimVerdict === "PASS",
        dmarcPass: msg.dmarcVerdict === "PASS",
      };
      for (const toAddress of outcome.forwardAddresses) {
        await this.forwarder.forward(s3Key, toAddress, accountId, forwardOpts).catch((err) => {
          console.error("Forward failed:", err);
        });
      }
    }

    // 15. Notify
    if (this.notifier && !outcome.suppressNotification) {
      await this.notifier.notify(accountId, arc, signal).catch((err) => {
        console.error("Notification failed:", err);
      });
    }

    this.store.updateGlobalReputation(senderETLD1, {
      wasSpam: classification.spamScore >= spamScoreThreshold,
      wasBlocked: false,
    }).catch((err) => console.error("Reputation update failed:", err));
  }

  private async autoApprove(
    accountId: string,
    address: string,
    senderETLD1: string,
    existing: Alias | null,
    defaultFilterMode: AccountFilteringConfig["defaultFilterMode"] = "notify_new",
  ): Promise<void> {
    const now = new Date().toISOString();
    if (existing) {
      await this.store.saveAlias({
        ...existing,
        approvedSenders: [...existing.approvedSenders, senderETLD1],
        updatedAt: now,
      });
    } else {
      await this.store.saveAlias({
        id: randomUUID(),
        accountId,
        address,
        filterMode: defaultFilterMode,
        approvedSenders: [senderETLD1],
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSignal(opts: {
  arcId?: string;
  status: Signal["status"];
  accountId: string;
  sesMessageId: string;
  recipientAddress: string;
  parsed: Awaited<ReturnType<MimeParser["parse"]>>;
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

function buildCalendarSignal(arc: Arc, emailSignal: Signal, now: string, ttl: number | undefined): Signal {
  const data = emailSignal.workflowData as SchedulingData;
  const calSignal: Signal = {
    id: `SYS#${randomUUID()}`,
    arcId: arc.id,
    accountId: arc.accountId,
    source: "system",
    receivedAt: emailSignal.receivedAt,
    from: emailSignal.from,
    to: emailSignal.to,
    cc: [],
    subject: data.title,
    attachments: [],
    headers: {},
    recipientAddress: emailSignal.recipientAddress,
    workflow: "scheduling",
    workflowData: emailSignal.workflowData,
    spamScore: 0,
    summary: emailSignal.summary,
    classificationModelId: emailSignal.classificationModelId,
    s3Key: "",
    status: "active",
    createdAt: now,
  };
  if (ttl !== undefined) calSignal.ttl = ttl;
  return calSignal;
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
