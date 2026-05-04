import { randomUUID } from "crypto";
import type { SQSEvent } from "aws-lambda";
import type { Signal, Arc, Rule, Workflow, WorkflowData, Alias, AccountFilteringConfig, SignalSource, SchedulingData, BlockReason, SignalStatus, Domain } from "../types/index.js";
import { priorityCalculator } from "./priority.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier } from "../classifier/classifier.js";
import { getETLD1, evaluateFilter, DEFAULT_SPAM_SCORE_THRESHOLD } from "./filter.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ProcessorAccountContext {
  retentionDays: number;
  filtering: AccountFilteringConfig | null;
  emailConfig: Alias | null;
  // eTLD+1 of domains registered to this account — used for test detection
  registeredDomains: string[];
  // Email addresses of all users on this account — used for test detection
  userEmails: string[];
}

export interface ProcessorDatabase {
  getSignalByMessageId(accountId: string, sesMessageId: string): Promise<Pick<Signal, "id"> | null>;
  saveSignal(signal: Signal): Promise<void>;
  getArc(accountId: string, id: string): Promise<Arc | null>;
  findArcByGroupingKey(accountId: string, key: string): Promise<Arc | null>;
  saveArc(arc: Arc): Promise<void>;
  listRules(accountId: string): Promise<Rule[]>;
  getProcessorAccountContext(accountId: string, recipientAddress: string): Promise<ProcessorAccountContext>;
  saveAlias(alias: Alias): Promise<void>;
  updateGlobalReputation(domain: string, update: { wasSpam: boolean; wasBlocked: boolean }): Promise<void>;
  getDomainByName(accountId: string, domainName: string): Promise<Pick<Domain, "senderSetupComplete"> | null>;
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
    to: string;          // original sender — receives the pong
    from: string;        // send from recipientAddress if Tier 2 complete, else NOTIFICATION_FROM
    subject: string;     // original subject; implementation prefixes "Re: "
    body: string;        // original email body text for Claude to riff on
    inReplyTo: string;   // original SES message ID for email threading
  }): Promise<{ messageId: string }>;
}

type SesVerdict = "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED";

// Shape of the notification that SES publishes to SNS on receipt
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
          // accountId comes from per-domain receipt rule metadata (set by API when registering a domain)
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
        ...(parsed.textBody != null && { textBody: parsed.textBody }),
        ...(parsed.htmlBody != null && { htmlBody: parsed.htmlBody }),
        headers: parsed.headers,
        receivedAt: timestamp,
      }),
    ]);

    const now = new Date().toISOString();

    // 3b. Fetch account context in one read (retentionDays + filtering + emailConfig)
    const accountCtx = await this.store.getProcessorAccountContext(accountId, recipientAddress);
    const ttl = accountCtx.retentionDays > 0
      ? Math.floor(Date.now() / 1000) + accountCtx.retentionDays * 86400
      : undefined;

    // 3c. Test detection — override workflow when the sender is the account owner.
    // Triggered if from-domain matches a registered account domain OR from-address matches a user email.
    const fromDomain = getETLD1(parsed.from.address);
    const isTestEmail =
      accountCtx.registeredDomains.includes(fromDomain) ||
      accountCtx.userEmails.map((e) => e.toLowerCase()).includes(parsed.from.address.toLowerCase());
    if (isTestEmail) {
      classification.workflow = "test";
      classification.workflowData = { workflow: "test", triggeredBy: "user" };
    }

    // Resolved spam threshold: per-address → account → default
    const spamScoreThreshold =
      accountCtx.emailConfig?.spamScoreThreshold ??
      accountCtx.filtering?.spamScoreThreshold ??
      DEFAULT_SPAM_SCORE_THRESHOLD;

    // 4. Arc matching — deterministic key first, vector similarity fallback
    const groupingKey = deriveGroupingKey(classification.workflow, classification.workflowData, recipientAddress, senderETLD1);
    const matchedArc = groupingKey
      ? await this.store.findArcByGroupingKey(accountId, groupingKey)
      : await this.arcMatcher.findMatch(accountId, recipientAddress, embedding);

    // 5. Filtering — bypassed entirely when signal matches an existing Arc
    if (!matchedArc) {
      const emailConfig = accountCtx.emailConfig;
      const accountConfig = accountCtx.filtering;

      // Welcome/onboarding block: status emails with statusType="welcome" are blocked when configured.
      // Checked before sender-filter so it applies even for known senders.
      if (classification.workflow === "status" && (classification.workflowData as { statusType?: string }).statusType === "welcome") {
        const perAddress = emailConfig?.onboardingEmailHandling;
        const globalBlock = accountConfig?.blockOnboardingEmails ?? false;
        const shouldSuppress = perAddress === "block" || perAddress === "quarantine" || (perAddress !== "allow" && globalBlock);
        if (shouldSuppress) {
          const disposition = perAddress === "block" || perAddress === "quarantine"
            ? perAddress
            : dispositionFor("onboarding", accountConfig);
          const status: SignalStatus = disposition === "quarantine" ? "quarantined" : "blocked";
          const suppressedSignal = buildSignal({
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
        ...(accountConfig?.newAddressHandling && { newAddressHandling: accountConfig.newAddressHandling }),
        ...(accountConfig?.defaultFilterMode && { defaultFilterMode: accountConfig.defaultFilterMode }),
        spamScoreThreshold,
      });

      if (!filterResult.allowed) {
        const disposition = dispositionFor(filterResult.reason, accountConfig);
        const status: SignalStatus = disposition === "quarantine" ? "quarantined" : "blocked";
        const suppressedSignal = buildSignal({
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
          wasSpam: classification.spamScore >= spamScoreThreshold,
          wasBlocked: true,
        }).catch((err) => console.error("Reputation update failed:", err));
        return;
      }

      if (filterResult.autoApprove) {
        await this.autoApprove(accountId, recipientAddress, senderETLD1, emailConfig, accountConfig?.defaultFilterMode);
      }
    }

    // 6. Build or update Arc
    const isNotice = classification.workflow === "status";
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

    // Pong: send a Bedrock-generated witty auto-reply for test emails. Runs before saveArc so
    // arc.sentMessageIds is populated on the first write rather than requiring a second update.
    if (classification.workflow === "test" && this.testReplier) {
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

    arc.urgency = priorityCalculator(arc, signal);

    await this.store.saveArc(arc);
    await this.store.saveSignal(signal);

    // 8. For scheduling signals, save a synthetic system signal so the frontend can render an ICS button
    if (classification.workflow === "scheduling") {
      const calSignal = buildCalendarSignal(arc, signal, now, ttl);
      await this.store.saveSignal(calSignal);
    }

    await this.arcMatcher.upsertEmbedding(arc.id, embedding, accountId, recipientAddress);

    // 9. Forward to any addresses collected from matching rules
    if (this.forwarder && forwardAddresses.length > 0) {
      const forwardOpts: ForwardOptions = {
        senderDomain: senderETLD1,
        dkimPass: msg.dkimVerdict === "PASS",
        dmarcPass: msg.dmarcVerdict === "PASS",
      };
      for (const toAddress of forwardAddresses) {
        await this.forwarder.forward(s3Key, toAddress, accountId, forwardOpts).catch((err) => {
          console.error("Forward failed:", err);
        });
      }
    }

    const isSpam = classification.spamScore >= spamScoreThreshold;
    if (this.notifier && !isSpam && !isNotice) {
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
    // Deterministic by sender — one arc per sender domain per workflow
    case "auth":
    case "content":
    case "status":
    case "payments":
    case "alert":
    case "test":
      return `${base}:${senderETLD1}`;

    // Deterministic by order number when present
    case "package": {
      const { orderNumber } = workflowData as { orderNumber?: string };
      return orderNumber ? `${base}:${orderNumber}` : null;
    }

    // Deterministic by ticket ID when present
    case "support": {
      const { ticketId } = workflowData as { ticketId?: string };
      return ticketId ? `${base}:${ticketId}` : null;
    }

    // Vector search: conversation, crm, travel, scheduling, healthcare, job
    default:
      return null;
  }
}

