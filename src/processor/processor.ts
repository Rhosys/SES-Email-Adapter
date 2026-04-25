import { randomUUID } from "crypto";
import type { SQSEvent } from "aws-lambda";
import type { Signal, Arc, Rule, Workflow, WorkflowData, PushPriority, EmailAddressConfig, AccountFilteringConfig, SignalSource, SchedulingData, BlockReason, SignalStatus } from "../types/index.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier } from "../classifier/classifier.js";
import { getETLD1, evaluateFilter } from "./filter.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ProcessorDatabase {
  getSignalByMessageId(accountId: string, sesMessageId: string): Promise<Pick<Signal, "id"> | null>;
  saveSignal(signal: Signal): Promise<void>;
  getArc(accountId: string, id: string): Promise<Arc | null>;
  findArcByGroupingKey(accountId: string, key: string): Promise<Arc | null>;
  saveArc(arc: Arc): Promise<void>;
  listRules(accountId: string): Promise<Rule[]>;
  getEmailAddressConfig(accountId: string, address: string): Promise<EmailAddressConfig | null>;
  saveEmailAddressConfig(config: EmailAddressConfig): Promise<void>;
  getAccountFilteringConfig(accountId: string): Promise<AccountFilteringConfig | null>;
  getAccountRetentionDays(accountId: string): Promise<number>;
  updateGlobalReputation(domain: string, update: { wasSpam: boolean; wasBlocked: boolean }): Promise<void>;
}

/** @deprecated Use ProcessorDatabase */
export type ProcessorStore = ProcessorDatabase;

export interface ArcMatcher {
  // recipientAddress scopes the vector search — signals from different recipient addresses never match
  findMatch(accountId: string, recipientAddress: string, embedding: number[]): Promise<Arc | null>;
  upsertEmbedding(arcId: string, embedding: number[], accountId: string, recipientAddress: string): Promise<void>;
}

export interface RuleEvaluator {
  evaluate(rule: Rule, context: { signal: Signal; arc: Arc }): boolean;
}

export interface Notifier {
  notify(accountId: string, arc: Arc, signal: Signal): Promise<void>;
  notifyBlocked(accountId: string, signal: Signal): Promise<void>;
}

export interface Forwarder {
  forward(s3Key: string, toAddress: string, accountId: string): Promise<void>;
}

interface InboundSignalMessage {
  accountId: string;
  s3Bucket: string;
  s3Key: string;
  sesMessageId: string;
  timestamp: string;
  destination: string[];
}

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
}

export class SignalProcessor {
  private readonly store: ProcessorDatabase;
  private readonly mimeParser: MimeParser;
  private readonly classifier: Pick<SignalClassifier, "classify" | "embed">;
  private readonly arcMatcher: ArcMatcher;
  private readonly ruleEvaluator: RuleEvaluator;
  private readonly notifier: Notifier | undefined;
  private readonly forwarder: Forwarder | undefined;

  constructor(opts: SignalProcessorOptions) {
    this.store = opts.store;
    this.mimeParser = opts.mimeParser;
    this.classifier = opts.classifier;
    this.arcMatcher = opts.arcMatcher;
    this.ruleEvaluator = opts.ruleEvaluator;
    this.notifier = opts.notifier;
    this.forwarder = opts.forwarder;
  }

  async process(event: SQSEvent): Promise<void> {
    for (const record of event.Records) {
      try {
        const msg = JSON.parse(record.body) as InboundSignalMessage;
        await this.processMessage(msg);
      } catch (err) {
        console.error("Failed to process SQS record:", err);
      }
    }
  }

  private async processMessage(msg: InboundSignalMessage): Promise<void> {
    const { accountId, s3Key, sesMessageId, timestamp, destination } = msg;

    // 1. Dedup — Signal.id for email signals = "SES#${sesMessageId}"
    const existing = await this.store.getSignalByMessageId(accountId, sesMessageId);
    if (existing) return;

    // 2. Parse MIME
    const parsed = await this.mimeParser.parse(s3Key);

    const recipientAddress = destination[0] ?? "";
    const senderETLD1 = getETLD1(parsed.from.address);

    // 3. Embed + classify in parallel — both needed before arc matching
    const embedText = [parsed.subject, parsed.textBody ?? ""].join(" ").slice(0, 4000);
    const [embedding, classification] = await Promise.all([
      this.classifier.embed(embedText),
      this.classifier.classify({
        from: parsed.from.address,
        to: parsed.to.map((a) => a.address),
        subject: parsed.subject,
        textBody: parsed.textBody,
        htmlBody: parsed.htmlBody ?? undefined,
        headers: parsed.headers,
        receivedAt: timestamp,
      }),
    ]);

    const now = new Date().toISOString();

    // 3b. Compute TTL for new items (0 = unlimited/paid, no ttl field written)
    const retentionDays = await this.store.getAccountRetentionDays(accountId);
    const ttl = retentionDays > 0 ? Math.floor(Date.now() / 1000) + retentionDays * 86400 : undefined;

    // 4. Arc matching — deterministic key first, vector similarity fallback
    const groupingKey = deriveGroupingKey(classification.workflow, classification.workflowData, recipientAddress, senderETLD1);
    const matchedArc = groupingKey
      ? await this.store.findArcByGroupingKey(accountId, groupingKey)
      : await this.arcMatcher.findMatch(accountId, recipientAddress, embedding);

    // 5. Filtering — bypassed entirely when signal matches an existing Arc
    if (!matchedArc) {
      const [emailConfig, accountConfig] = await Promise.all([
        this.store.getEmailAddressConfig(accountId, recipientAddress),
        this.store.getAccountFilteringConfig(accountId),
      ]);

      // Onboarding block: checked before sender-filter so it applies even for known senders
      if (classification.workflow === "onboarding") {
        const perAddress = emailConfig?.onboardingEmailHandling;
        const globalBlock = accountConfig?.blockOnboardingEmails ?? false;
        const shouldSuppress = perAddress === "block" || perAddress === "quarantine" || (perAddress !== "allow" && globalBlock);
        if (shouldSuppress) {
          const disposition = perAddress === "block" || perAddress === "quarantine"
            ? perAddress
            : dispositionFor("onboarding", accountConfig);
          const status: SignalStatus = disposition === "quarantine" ? "quarantined" : "blocked";
          const suppressedSignal = buildSignal({
            arcId: undefined,
            status,
            blockReason: "onboarding",
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
          await this.store.saveSignal(suppressedSignal);
          if (status === "quarantined" && this.notifier) {
            await this.notifier.notifyBlocked(accountId, suppressedSignal).catch((err) => {
              console.error("Quarantine notification failed:", err);
            });
          }
          return;
        }
      }

      const filterResult = evaluateFilter(emailConfig, senderETLD1, classification.spamScore, {
        newAddressHandling: accountConfig?.newAddressHandling,
        defaultFilterMode: accountConfig?.defaultFilterMode,
      });

      if (!filterResult.allowed) {
        const disposition = dispositionFor(filterResult.reason, accountConfig);
        const status: SignalStatus = disposition === "quarantine" ? "quarantined" : "blocked";
        const suppressedSignal = buildSignal({
          arcId: undefined,
          status,
          blockReason: filterResult.reason,
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

        await this.store.saveSignal(suppressedSignal);
        if (status === "quarantined" && this.notifier) {
          await this.notifier.notifyBlocked(accountId, suppressedSignal).catch((err) => {
            console.error("Quarantine notification failed:", err);
          });
        }

        this.store.updateGlobalReputation(senderETLD1, {
          wasSpam: classification.workflow === "spam" || classification.spamScore >= 0.9,
          wasBlocked: true,
        }).catch((err) => console.error("Reputation update failed:", err));
        return;
      }

      if (filterResult.autoApprove) {
        await this.autoApprove(accountId, recipientAddress, senderETLD1, emailConfig, accountConfig?.defaultFilterMode);
      }
    }

    // 6. Build or update Arc
    const isNotice = classification.workflow === "notice";
    let arc: Arc;
    if (matchedArc) {
      arc = {
        ...matchedArc,
        workflow: classification.workflow,
        summary: classification.summary,
        // Notices stay buried — never bump lastSignalAt
        ...(isNotice ? {} : { lastSignalAt: timestamp }),
        updatedAt: now,
      };
    } else {
      arc = {
        id: randomUUID(),
        accountId,
        ...(groupingKey ? { groupingKey } : {}),
        workflow: classification.workflow,
        labels: classification.labels,
        // Notices are archived on arrival
        status: isNotice ? "archived" : "active",
        summary: classification.summary,
        lastSignalAt: timestamp,
        createdAt: now,
        updatedAt: now,
        ...(ttl !== undefined ? { ttl } : {}),
      };
    }

    // Merge classifier-suggested labels
    for (const label of classification.labels) {
      if (!arc.labels.includes(label)) {
        arc.labels = [...arc.labels, label];
      }
    }

    // 7. Evaluate rules
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

    const forwardAddresses: string[] = [];
    const rules = await this.store.listRules(accountId);
    for (const rule of rules) {
      if (!this.ruleEvaluator.evaluate(rule, { signal: signalShell, arc })) continue;
      for (const action of rule.actions) {
        if (action.disabled) continue;
        if (action.type === "assign_label" && action.value) {
          if (!arc.labels.includes(action.value)) {
            arc.labels = [...arc.labels, action.value];
          }
        } else if (action.type === "assign_workflow" && action.value) {
          arc.workflow = action.value as Workflow;
        } else if (action.type === "archive") {
          arc.status = "archived";
        } else if (action.type === "delete") {
          arc.status = "deleted";
          arc.deletedAt = now;
        } else if (action.type === "forward" && action.value) {
          forwardAddresses.push(action.value);
        }
      }
    }

    const signal: Signal = { ...signalShell, arcId: arc.id };

    await this.store.saveArc(arc);
    await this.store.saveSignal(signal);

    // 8. For scheduling signals, save a synthetic system signal so the frontend can render an ICS button
    if (classification.workflow === "scheduling") {
      const calSignal = buildCalendarSignal(arc, signal, now, ttl);
      await this.store.saveSignal(calSignal);
    }

    await this.arcMatcher.upsertEmbedding(arc.id, embedding, accountId, recipientAddress);

    // 9. Forward to any addresses collected from matching rules
    if (this.forwarder) {
      for (const toAddress of forwardAddresses) {
        await this.forwarder.forward(s3Key, toAddress, accountId).catch((err) => {
          console.error("Forward failed:", err);
        });
      }
    }

    const isSpam = classification.workflow === "spam" || classification.spamScore >= 0.9;
    if (this.notifier && !isSpam && !isNotice) {
      await this.notifier.notify(accountId, arc, signal).catch((err) => {
        console.error("Notification failed:", err);
      });
    }

    this.store.updateGlobalReputation(senderETLD1, {
      wasSpam: isSpam,
      wasBlocked: false,
    }).catch((err) => console.error("Reputation update failed:", err));
  }

  private async autoApprove(
    accountId: string,
    address: string,
    senderETLD1: string,
    existing: EmailAddressConfig | null,
    defaultFilterMode: AccountFilteringConfig["defaultFilterMode"] = "notify_new",
  ): Promise<void> {
    const now = new Date().toISOString();
    if (existing) {
      await this.store.saveEmailAddressConfig({
        ...existing,
        approvedSenders: [...existing.approvedSenders, senderETLD1],
        updatedAt: now,
      });
    } else {
      await this.store.saveEmailAddressConfig({
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
  blockReason?: Signal["blockReason"];
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
  const { arcId, status, blockReason, accountId, sesMessageId, recipientAddress, parsed, classification, s3Key, receivedAt, now, ttl } = opts;
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
    pushPriority: derivePushPriority(classification.workflow, classification.workflowData),
    s3Key,
    status,
    createdAt: now,
  };

  if (arcId !== undefined) signal.arcId = arcId;
  if (blockReason !== undefined) signal.blockReason = blockReason;
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
    pushPriority: "silent",
    s3Key: "",
    status: "active",
    createdAt: now,
  };
  if (ttl !== undefined) calSignal.ttl = ttl;
  return calSignal;
}

// Returns disposition for a given block reason. Default is "quarantine" (notify user for review).
// Explicit "block" = silent sequester, hidden until user explicitly searches.
export function dispositionFor(reason: BlockReason, config: AccountFilteringConfig | null | undefined): "block" | "quarantine" {
  return config?.blockDisposition?.[reason] ?? "quarantine";
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
    case "invoice":
    case "notice":
    case "newsletter":
    case "onboarding":
      return `${base}:${senderETLD1}`;

    case "order": {
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

export function derivePushPriority(workflow: Workflow, data: WorkflowData): PushPriority {
  switch (workflow) {
    case "auth":
      return "interrupt";

    case "security":
      return "interrupt";

    case "financial":
      return (data as { isSuspicious?: boolean }).isSuspicious ? "interrupt" : "ambient";

    case "scheduling":
    case "travel":
    case "healthcare":
      return "ambient";

    case "developer":
      return (data as { severity?: string; requiresAction?: boolean }).severity === "critical" &&
        (data as { requiresAction?: boolean }).requiresAction
        ? "interrupt"
        : "ambient";

    case "subscription":
      return (data as { eventType?: string }).eventType === "payment_failed" ? "interrupt" : "ambient";

    case "support":
      return (data as { priority?: string }).priority === "urgent" ? "interrupt" : "ambient";

    case "notice":
    case "newsletter":
    case "promotions":
    case "onboarding":
    case "social":
    case "spam":
      return "silent";

    default:
      return "ambient";
  }
}
