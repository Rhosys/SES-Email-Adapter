import { randomUUID } from "crypto";
import type { SQSEvent } from "aws-lambda";
import type { Signal, Arc, Rule, Workflow, WorkflowData, Alias, AliasSender, SenderMode, AccountFilteringConfig, SignalSource, SchedulingData, SignalStatus, Domain, ArcUrgency, SenderFilterMode, MatchedRuleResult } from "../types/index.js";
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
  getSender(accountId: string, address: string, domain: string): Promise<AliasSender | null>;
  saveSender(accountId: string, address: string, domain: string, mode: SenderMode): Promise<void>;
  getTemplate(accountId: string, id: string): Promise<import("../types/index.js").EmailTemplate | null>;
  updateGlobalReputation(domain: string, update: { wasSpam: boolean; wasBlocked: boolean }): Promise<void>;
  getDomainByName(accountId: string, domainName: string): Promise<Pick<Domain, "senderSetupComplete"> | null>;
}

export interface ArcMatcher {
  findMatch(accountId: string, recipientAddress: string, embedding: number[]): Promise<Arc | null>;
  upsertEmbedding(arcId: string, embedding: number[], accountId: string, recipientAddress: string): Promise<void>;
}

export interface RuleEvaluator {
  evaluate(rule: Rule, context: { signal: Signal; arc: Arc; isMatchedArc: boolean }): Promise<boolean>;
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
  autoReplyTemplateIds: string[];
  autoDraftTemplateIds: string[];
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
      actions.some((a) => a.type === "block")      ? "blocked"     :
      actions.some((a) => a.type === "quarantine") ? "quarantined" :
      actions.some((a) => a.type === "archive")    ? "archived"    :
      actions.some((a) => a.type === "delete")     ? "deleted"     :
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

    // 4. Fetch account context + sender entry in parallel
    const [accountCtx, senderEntry] = await Promise.all([
      this.store.getProcessorAccountContext(accountId, recipientAddress),
      this.store.getSender(accountId, recipientAddress, senderETLD1),
    ]);
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
    const effectiveFilterMode: SenderFilterMode = emailConfig
      ? emailConfig.filterMode
      : accountCtx.filtering?.newAddressHandling === "block_until_approved"
        ? "quarantine_notify"
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
    const matchedRules = await applyRules(rules, { signal: signalShell, arc, isMatchedArc }, this.ruleEvaluator);
    const outcome = deriveOutcome(matchedRules);

    // Fallback: if no rule set a status, apply filter mode for untrusted senders
    const hasStatusOutcome = outcome.block || outcome.quarantine || outcome.archive || outcome.delete;
    if (!hasStatusOutcome && arc.labels.includes("system:sender:untrusted")) {
      switch (effectiveFilterMode) {
        case "block":             outcome.block = true; break;
        case "quarantine_silent": outcome.quarantine = true; outcome.suppressNotification = true; break;
        case "quarantine_notify": outcome.quarantine = true; break;
        // "allow_all": signal proceeds as active
      }
    }

    const buildArgs = { accountId, sesMessageId, recipientAddress, parsed, classification, s3Key, receivedAt: timestamp, now, ...(ttl !== undefined ? { ttl } : {}) };

    if (outcome.block) {
      await this.store.saveSignal({ ...buildSignal({ status: "blocked", ...buildArgs }), matchedRules });
      this.store.updateGlobalReputation(senderETLD1, { wasSpam: classification.spamScore >= spamScoreThreshold, wasBlocked: true }).catch((err) => console.error("Reputation update failed:", err));
      return;
    }

    // approveSender overrides quarantine — SR-14 (auto-approve on matched conversation) fires before fallback
    if (outcome.quarantine && !outcome.approveSender) {
      const quarantinedSignal: Signal = { ...buildSignal({ status: "quarantined", ...buildArgs }), matchedRules };
      await this.store.saveSignal(quarantinedSignal);
      if (this.notifier && !outcome.suppressNotification) {
        await this.notifier.notifyBlocked(accountId, quarantinedSignal).catch((err) => {
          console.error("Quarantine notification failed:", err);
        });
      }
      this.store.updateGlobalReputation(senderETLD1, { wasSpam: classification.spamScore >= spamScoreThreshold, wasBlocked: true }).catch((err) => console.error("Reputation update failed:", err));
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

    const signalUrgency = outcome.urgency ?? arc.urgency ?? "normal";
    if (!matchedArc) arc.urgency = signalUrgency;

    const signal: Signal = { ...signalShell, arcId: arc.id, matchedRules, urgency: signalUrgency };

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

    // 15. Auto-reply (fire-and-forget composed emails from templates)
    if (this.testReplier && outcome.autoReplyTemplateIds.length > 0) {
      const recipientDomain = recipientAddress.split("@")[1] ?? "";
      const domain = await this.store.getDomainByName(accountId, recipientDomain);
      if (domain?.senderSetupComplete) {
        const vars = {
          "signal.subject": parsed.subject,
          "sender.name": parsed.from.name ?? "",
          "sender.address": parsed.from.address,
          "arc.workflow": classification.workflow,
        };
        for (const templateId of outcome.autoReplyTemplateIds) {
          const tmpl = await this.store.getTemplate(accountId, templateId);
          if (!tmpl) continue;
          const replyResult = await this.testReplier.pong({
            to: parsed.from.address,
            from: recipientAddress,
            subject: renderTemplate(tmpl.subject, vars),
            body: renderTemplate(tmpl.body, vars),
            inReplyTo: sesMessageId,
          }).catch((err) => { console.error("Auto-reply failed:", err); return null; });
          if (replyResult) {
            arc.sentMessageIds = [...(arc.sentMessageIds ?? []), replyResult.messageId];
            await this.store.saveArc(arc);
          }
        }
      }
    }

    // 16. Auto-draft (create held draft signals from templates)
    if (outcome.autoDraftTemplateIds.length > 0) {
      const vars = {
        "signal.subject": parsed.subject,
        "sender.name": parsed.from.name ?? "",
        "sender.address": parsed.from.address,
        "arc.workflow": classification.workflow,
      };
      for (const templateId of outcome.autoDraftTemplateIds) {
        const tmpl = await this.store.getTemplate(accountId, templateId);
        if (!tmpl) continue;
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
        await this.store.saveSignal(draft);
      }
    }

    // 17. Notify
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
    defaultFilterMode: AccountFilteringConfig["defaultFilterMode"] = "quarantine_notify",
  ): Promise<void> {
    const now = new Date().toISOString();
    if (!existing) {
      await this.store.saveAlias({
        id: randomUUID(),
        accountId,
        address,
        filterMode: defaultFilterMode,
        createdAt: now,
        updatedAt: now,
      });
    }
    await this.store.saveSender(accountId, address, senderETLD1, "allow");
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
