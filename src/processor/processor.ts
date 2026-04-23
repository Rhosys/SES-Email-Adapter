import { randomUUID } from "crypto";
import type { SQSEvent } from "aws-lambda";
import type { Signal, Arc, Rule, Category, EmailAddressConfig, AccountFilteringConfig, SignalStatus, BlockReason } from "../types/index.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier } from "../classifier/classifier.js";
import { getETLD1, evaluateFilter, type FilterResult } from "./filter.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ProcessorStore {
  getSignalByMessageId(messageId: string): Promise<Pick<Signal, "id" | "messageId"> | null>;
  saveSignal(signal: Signal): Promise<void>;
  getArc(id: string): Promise<Arc | null>;
  saveArc(arc: Arc): Promise<void>;
  listRules(accountId: string): Promise<Rule[]>;
  getEmailAddressConfig(accountId: string, address: string): Promise<EmailAddressConfig | null>;
  saveEmailAddressConfig(config: EmailAddressConfig): Promise<void>;
  getAccountFilteringConfig(accountId: string): Promise<AccountFilteringConfig | null>;
}

export interface ArcMatcher {
  findMatch(accountId: string, embedding: number[]): Promise<Arc | null>;
  upsertEmbedding(arcId: string, embedding: number[]): Promise<void>;
}

export interface RuleEvaluator {
  evaluate(rule: Rule, context: { signal: Signal; arc: Arc }): boolean;
}

export interface Notifier {
  notify(accountId: string, arc: Arc, signal: Signal): Promise<void>;
  notifyBlocked(accountId: string, signal: Signal): Promise<void>;
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
  store: ProcessorStore;
  mimeParser: MimeParser;
  classifier: Pick<SignalClassifier, "classify" | "embed">;
  arcMatcher: ArcMatcher;
  ruleEvaluator: RuleEvaluator;
  notifier?: Notifier;
}

export class SignalProcessor {
  private readonly store: ProcessorStore;
  private readonly mimeParser: MimeParser;
  private readonly classifier: Pick<SignalClassifier, "classify" | "embed">;
  private readonly arcMatcher: ArcMatcher;
  private readonly ruleEvaluator: RuleEvaluator;
  private readonly notifier?: Notifier;

  constructor(opts: SignalProcessorOptions) {
    this.store = opts.store;
    this.mimeParser = opts.mimeParser;
    this.classifier = opts.classifier;
    this.arcMatcher = opts.arcMatcher;
    this.ruleEvaluator = opts.ruleEvaluator;
    this.notifier = opts.notifier;
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

    // 1. Dedup
    const existing = await this.store.getSignalByMessageId(sesMessageId);
    if (existing) return;

    // 2. Parse MIME
    const parsed = await this.mimeParser.parse(s3Key);

    // 3. Embed + Arc matching
    const embedText = [parsed.subject, parsed.textBody ?? ""].join(" ").slice(0, 4000);
    const embedding = await this.classifier.embed(embedText);
    const matchedArc = await this.arcMatcher.findMatch(accountId, embedding);

    // 4. Classify
    const classification = await this.classifier.classify({
      from: parsed.from.address,
      to: parsed.to.map((a) => a.address),
      subject: parsed.subject,
      textBody: parsed.textBody,
      htmlBody: parsed.htmlBody ?? undefined,
      headers: parsed.headers,
      receivedAt: timestamp,
    });

    const now = new Date().toISOString();
    const recipientAddress = destination[0] ?? "";
    const senderETLD1 = getETLD1(parsed.from.address);

    // 5. Filtering — bypassed entirely when signal matches an existing Arc
    if (!matchedArc) {
      const emailConfig = await this.store.getEmailAddressConfig(accountId, recipientAddress);
      const filterResult = evaluateFilter(emailConfig, senderETLD1, classification.spamScore);

      if (!filterResult.allowed) {
        const blockedSignal = buildSignal({
          arcId: undefined,
          status: "blocked",
          blockReason: filterResult.reason,
          accountId,
          messageId: sesMessageId,
          recipientAddress,
          parsed,
          classification,
          s3Key,
          receivedAt: timestamp,
          now,
        });

        await this.store.saveSignal(blockedSignal);
        if (this.notifier) {
          await this.notifier.notifyBlocked(accountId, blockedSignal).catch((err) => {
            console.error("Blocked notification failed:", err);
          });
        }
        return;
      }

      if (filterResult.autoApprove) {
        await this.autoApprove(accountId, recipientAddress, senderETLD1, emailConfig);
      }
    }

    // 6. Build or update Arc
    let arc: Arc;
    if (matchedArc) {
      arc = {
        ...matchedArc,
        category: classification.category,
        summary: classification.summary,
        lastSignalAt: timestamp,
        updatedAt: now,
      };
    } else {
      arc = {
        id: randomUUID(),
        accountId,
        category: classification.category,
        labels: classification.labels,
        status: "active",
        summary: classification.summary,
        lastSignalAt: timestamp,
        createdAt: now,
        updatedAt: now,
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
      messageId: sesMessageId,
      recipientAddress,
      parsed,
      classification,
      s3Key,
      receivedAt: timestamp,
      now,
    });

    const rules = await this.store.listRules(accountId);
    for (const rule of rules) {
      if (!this.ruleEvaluator.evaluate(rule, { signal: signalShell, arc })) continue;
      for (const action of rule.actions) {
        if (action.type === "assign_label" && action.value) {
          if (!arc.labels.includes(action.value)) {
            arc.labels = [...arc.labels, action.value];
          }
        } else if (action.type === "assign_category" && action.value) {
          arc.category = action.value as Category;
        } else if (action.type === "archive") {
          arc.status = "archived";
        } else if (action.type === "delete") {
          arc.status = "deleted";
          arc.deletedAt = now;
        }
      }
    }

    const signal: Signal = { ...signalShell, arcId: arc.id };

    await this.store.saveArc(arc);
    await this.store.saveSignal(signal);
    await this.arcMatcher.upsertEmbedding(arc.id, embedding);

    const isSpam = classification.category === "spam" || classification.spamScore >= 0.9;
    if (this.notifier && !isSpam) {
      await this.notifier.notify(accountId, arc, signal).catch((err) => {
        console.error("Notification failed:", err);
      });
    }
  }

  private async autoApprove(
    accountId: string,
    address: string,
    senderETLD1: string,
    existing: EmailAddressConfig | null,
  ): Promise<void> {
    const now = new Date().toISOString();
    if (existing) {
      await this.store.saveEmailAddressConfig({
        ...existing,
        approvedSenders: [...existing.approvedSenders, senderETLD1],
        updatedAt: now,
      });
    } else {
      const accountConfig = await this.store.getAccountFilteringConfig(accountId);
      await this.store.saveEmailAddressConfig({
        id: randomUUID(),
        accountId,
        address,
        filterMode: accountConfig?.defaultFilterMode ?? "notify_new",
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
  messageId: string;
  recipientAddress: string;
  parsed: Awaited<ReturnType<MimeParser["parse"]>>;
  classification: Awaited<ReturnType<SignalClassifier["classify"]>>;
  s3Key: string;
  receivedAt: string;
  now: string;
}): Signal {
  const { arcId, status, blockReason, accountId, messageId, recipientAddress, parsed, classification, s3Key, receivedAt, now } = opts;
  const signal: Signal = {
    id: randomUUID(),
    accountId,
    messageId,
    receivedAt,
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    subject: parsed.subject,
    attachments: parsed.attachments,
    headers: parsed.headers,
    recipientAddress,
    category: classification.category,
    categoryData: classification.categoryData,
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

  return signal;
}
