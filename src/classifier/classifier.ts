import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { Result } from "neverthrow";
import { ok, err } from "neverthrow";
import type { Workflow, WorkflowData, SignalAction } from "../types/index.js";
import { WORKFLOWS } from "../types/index.js";
import type { Logger } from "../logger.js";
import { buildSystemPrompt, buildUserMessage, redactUrls } from "./prompt-builder.js";
import { CLASSIFIER_WORKFLOW_REGISTRY } from "../types/workflow-registry.js";
import { SPAM_TAGS } from "./tags.js";
import { coerceWorkflowData } from "./coerce-workflow-data.js";

export const CLASSIFICATION_MODEL_ID = "qwen.qwen3-32b-v1:0";

// Bedrock Guardrail — observe-only prompt injection + content detection.
// Values come from `tofu output` after applying email-catcher/infrastructure.
export const GUARDRAIL_ID = "PLACEHOLDER";
export const GUARDRAIL_VERSION = "PLACEHOLDER";

export type ClassificationError = { kind: "classification_error"; cause: unknown; rawText?: string };
export const classificationError = (cause: unknown, rawText?: string): ClassificationError => ({ kind: "classification_error", cause, ...(rawText !== undefined ? { rawText } : {}) });

export interface ClassificationInput {
  from: string;
  to: string[];
  subject: string;
  body: string;
  receivedAt: string;
  headers: Record<string, string>;
  allowedLabels: string[];
  labelInstructions: Record<string, string>;
  extractedLinks?: Array<{ url: string; text: string | null }>;
  signalId?: string;
  accountId?: string;
}

/**
 * Classifier output shape.
 *
 * IMPORTANT: When adding or changing fields here, you MUST also update the live
 * Bedrock integration tests in `llm-tests/classify.spec.ts`. Those tests call the
 * real model and verify each field is returned correctly. Without them, mock-only
 * tests can pass while production silently drops data (see: the `actions` bug of
 * July 2026 where a missing field in mocks hid a runtime crash for weeks).
 */
export interface ClassificationOutput {
  workflow: Workflow;
  workflowData: WorkflowData;
  tags: string[];
  summary: string;
  labels: string[];
  actions: SignalAction[];
}

interface RawClassificationResponse {
  workflow: string;
  workflowData: Record<string, unknown>;
  tags?: string[];
  spamScore?: unknown;
  summary: string;
  labels: string[];
  actions?: unknown[];
}

// Bedrock Guardrail trace types (when trace: "ENABLED" is set on InvokeModel)
interface GuardrailFilter {
  type: string;
  confidence: string;
  action: string;
}

interface GuardrailAssessment {
  contentPolicy?: { filters?: GuardrailFilter[] };
}

interface GuardrailTrace {
  guardrail?: {
    inputAssessment?: Record<string, GuardrailAssessment>;
    outputAssessment?: Record<string, GuardrailAssessment>;
  };
}

interface BedrockResponseWithTrace {
  choices: Array<{ message: { content: string } }>;
  "amazon-bedrock-guardrailAction"?: string;
  "amazon-bedrock-trace"?: GuardrailTrace;
}

export class SignalClassifier {
  private readonly client: BedrockRuntimeClient;
  private readonly logger: Logger;

  constructor(client: BedrockRuntimeClient, logger: Logger) {
    this.client = client;
    this.logger = logger;
  }

  async classify(input: ClassificationInput): Promise<Result<ClassificationOutput, ClassificationError>> {
    const systemPrompt = buildSystemPrompt(CLASSIFIER_WORKFLOW_REGISTRY.filter(w => w.classifierAssignable !== false));
    const userMessage = buildUserMessage(input);
    const requestBody = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      max_tokens: 2048,
      temperature: 0.1,
      // Disable thinking mode — we want direct JSON output, not reasoning tokens
      enable_thinking: false,
    };

    let response;
    try {
      response = await this.client.send(
        new InvokeModelCommand({
          modelId: CLASSIFICATION_MODEL_ID,
          contentType: "application/json",
          accept: "application/json",
          body: new TextEncoder().encode(JSON.stringify(requestBody)),
          // TODO: Re-enable once guardrail is deployed in email-catcher/infrastructure
          // guardrailIdentifier: GUARDRAIL_ID,
          // guardrailVersion: GUARDRAIL_VERSION,
          // trace: "ENABLED",
        }),
      );
    } catch (e) {
      this.logger.error("Classifier Bedrock request failed.", { code: "classifier.bedrock_error", input, error: e });
      return err(classificationError(e));
    }

    const responseBody = new TextDecoder().decode(response.body);

    // Parse outer Bedrock response
    let result: BedrockResponseWithTrace;
    try {
      result = JSON.parse(responseBody) as BedrockResponseWithTrace;
    } catch (e) {
      this.logger.error("Classifier received invalid JSON from Bedrock response envelope.", { code: "classifier.parse_failed", input, rawResponse: responseBody, error: e });
      return err(classificationError(e, responseBody));
    }

    // Handle guardrail trace — observe only, never blocks classification
    this.handleGuardrailTrace(result, input.signalId, input.accountId);

    const text = result.choices?.[0]?.message?.content ?? "";

    // Parse classifier JSON output — strip markdown fences if model wraps output
    let jsonText = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    // Sanitize bare <UNSPECIFIED> sentinels that break JSON (LLM outputs them for non-string fields)
    jsonText = jsonText.replace(/<UNSPECIFIED>/g, "null").replace(/"<UNSPECIFIED>"/gi, "null");
    let raw: RawClassificationResponse;
    try {
      raw = JSON.parse(jsonText) as RawClassificationResponse;
    } catch (e) {
      this.logger.error("Classifier received invalid JSON from model output.", { code: "classifier.parse_failed", input, rawResponse: text, error: e });
      return err(classificationError(e, text));
    }

    // Validate workflow ∈ WORKFLOWS
    if (!WORKFLOWS.includes(raw.workflow as Workflow)) {
      this.logger.error("Classifier returned unknown workflow.", { code: "classifier.invalid_workflow", input, rawResponse: jsonText, workflow: raw.workflow });
      return err(classificationError(`Unknown workflow: ${raw.workflow}`, jsonText));
    }

    // Validate and filter tags to recognized vocabulary
    const TAG_FORMAT = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
    const rawTags = Array.isArray(raw.tags) ? raw.tags : [];
    const validTags: string[] = [];
    const unknownTags: string[] = [];
    for (const tag of rawTags) {
      if (typeof tag !== "string") continue;
      if (!TAG_FORMAT.test(tag) || tag.length < 2 || tag.length > 40) continue;
      if ((SPAM_TAGS as readonly string[]).includes(tag)) {
        validTags.push(tag);
      } else {
        unknownTags.push(tag);
      }
    }
    const tags = validTags.slice(0, 10);

    // When unknown tags appear, re-run classification with explanation request and log everything
    if (unknownTags.length > 0) {
      const explanationResponse = await this.classifyWithExplanations(input);
      this.logger.track("Classifier received unknown tag from LLM — potential vocabulary expansion candidate.", {
        code: "classifier.unknown_tag",
        unknownTags,
        signalId: input.signalId,
        accountId: input.accountId,
        input,
        firstClassificationRaw: jsonText,
        explanationClassificationRaw: explanationResponse,
      });
    }

    // Filter labels to subset of allowedLabels
    const labels = Array.isArray(raw.labels)
      ? raw.labels.filter((l) => input.allowedLabels.includes(l))
      : [];

    // Sanitize URL fields in workflowData — nullify non-URL values (skip [link-N] references for later resolution)
    const urlFields = ["trackingUrl", "downloadUrl", "managementUrl", "paymentUrl", "documentUrl", "portalUrl", "responseUrl", "ticketUrl", "actionUrl"] as const;
    const LINK_REF_PATTERN = /^\[link-\d+\]$/;
    const workflowData = { ...raw.workflowData } as Record<string, unknown>;
    for (const field of urlFields) {
      if (field in workflowData && typeof workflowData[field] === "string") {
        const value = workflowData[field] as string;
        if (!isValidUrl(value) && !LINK_REF_PATTERN.test(value)) {
          this.logger.track("Classifier returned non-URL value for URL field — nullified.", { code: "classifier.invalid_url_field", field, value, input, rawResponse: jsonText });
          workflowData[field] = null;
        }
      }
    }

    // Coerce workflowData field types (numeric → string, boolean normalization)
    const rawWorkflowData = { ...workflowData };
    const coercedWorkflowData = coerceWorkflowData(workflowData, raw.workflow, this.logger, {
      signalId: input.signalId,
      accountId: input.accountId,
      workflow: raw.workflow,
    }, input.receivedAt);

    // Strip sentinel/placeholder values — LLM sometimes outputs these instead of omitting
    for (const [key, value] of Object.entries(coercedWorkflowData)) {
      if (typeof value === "string" && isUnspecifiedSentinel(value)) {
        coercedWorkflowData[key] = null;
      }
    }

    // Validate currency fields — must be a valid ISO 4217 code (3 uppercase letters)
    if (typeof coercedWorkflowData.currency === "string") {
      const raw = coercedWorkflowData.currency as string;
      if (!isValidCurrencyCode(raw)) {
        this.logger.track("Classifier returned invalid currency code — nullified.", {
          code: "classifier.invalid_currency",
          value: raw,
          signalId: input.signalId,
          accountId: input.accountId,
          workflow: raw,
        });
        coercedWorkflowData.currency = null;
      } else {
        coercedWorkflowData.currency = raw.trim().toUpperCase();
      }
    }

    this.logger.info("Classifier workflowData coercion complete.", {
      code: "classifier.coercion_result",
      signalId: input.signalId,
      accountId: input.accountId,
      workflow: raw.workflow,
      rawWorkflowData,
      coercedWorkflowData,
    });

    // Extract and validate actions
    const actions: SignalAction[] = [];
    if (Array.isArray(raw.actions)) {
      for (const entry of raw.actions) {
        if (typeof entry !== "object" || entry === null) continue;
        const candidate = entry as Record<string, unknown>;
        if (typeof candidate.url !== "string") continue;
        const text = typeof candidate.text === "string" && candidate.text !== candidate.url ? candidate.text : null;
        actions.push({ url: candidate.url, text });
      }
    }

    // Resolve [link-N] references back to real URLs
    const { linkIndex } = redactUrls(input.body, input.extractedLinks ?? []);
    const linkMap = new Map(linkIndex.map((l) => [l.placeholder, l.url]));

    // Resolve URL fields in workflowData
    for (const field of urlFields) {
      if (field in coercedWorkflowData && typeof coercedWorkflowData[field] === "string") {
        const value = coercedWorkflowData[field] as string;
        const resolved = linkMap.get(value);
        if (resolved) {
          coercedWorkflowData[field] = resolved;
        } else if (LINK_REF_PATTERN.test(value)) {
          // Unresolved link reference — nullify
          coercedWorkflowData[field] = null;
        }
      }
    }

    // Resolve [link-N] references in actions
    for (const action of actions) {
      const resolved = linkMap.get(action.url);
      if (resolved) {
        action.url = resolved;
      }
    }

    // Filter actions to valid URLs only (after resolution)
    const validActions = actions.filter((a) => isValidUrl(a.url));

    return ok({
      workflow: raw.workflow as Workflow,
      workflowData: coercedWorkflowData as unknown as WorkflowData,
      tags,
      summary: raw.summary,
      labels,
      actions: validActions,
    });
  }

  /**
   * Re-runs classification with the same prompt + an additional instruction to explain each tag.
   * Returns the raw text response (unparsed) for diagnostic logging.
   */
  private async classifyWithExplanations(input: ClassificationInput): Promise<string> {
    const systemPrompt = buildSystemPrompt(CLASSIFIER_WORKFLOW_REGISTRY.filter(w => w.classifierAssignable !== false));
    const userMessage = buildUserMessage(input)
      + "\n\nAdditionally, for every tag you assign, include a field \"tagExplanations\" in your JSON response: an object mapping each tag to a one-sentence explanation of why you assigned it.";

    const requestBody = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      max_tokens: 2048,
      temperature: 0.1,
      enable_thinking: false,
    };

    try {
      const response = await this.client.send(
        new InvokeModelCommand({
          modelId: CLASSIFICATION_MODEL_ID,
          contentType: "application/json",
          accept: "application/json",
          body: new TextEncoder().encode(JSON.stringify(requestBody)),
        }),
      );
      const responseBody = new TextDecoder().decode(response.body);
      const result = JSON.parse(responseBody) as BedrockResponseWithTrace;
      return result.choices?.[0]?.message?.content ?? responseBody;
    } catch (e) {
      return `[explanation call failed: ${e instanceof Error ? e.message : "unknown"}]`;
    }
  }

  private handleGuardrailTrace(response: BedrockResponseWithTrace, signalId?: string, accountId?: string): void {
    const trace = response["amazon-bedrock-trace"];
    if (!trace?.guardrail) return;

    const assessments = [
      ...Object.values(trace.guardrail.inputAssessment ?? {}),
      ...Object.values(trace.guardrail.outputAssessment ?? {}),
    ];

    for (const assessment of assessments) {
      const filters = assessment.contentPolicy?.filters;
      if (!filters) continue;

      for (const filter of filters) {
        // Only log filters that actually detected something (action !== "NONE" or confidence reported)
        if (filter.confidence === "NONE") continue;

        const detectionType = filter.type === "PROMPT_ATTACK" ? "PROMPT_ATTACK" : "CONTENT_FILTER";
        this.logger.track("classifier.guardrail_detection", {
          code: "classifier.guardrail_detection",
          signalId,
          accountId,
          detectionType,
          category: filter.type,
          confidence: filter.confidence,
        });
      }
    }
  }
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const UNSPECIFIED_PATTERNS = [
  "<unspecified>", "not specified", "not_specified", "unknown", "n/a", "na", "none",
  "unspecified", "null", "undefined", "not available", "not applicable", "—", "-", "tbd",
];

function isUnspecifiedSentinel(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return UNSPECIFIED_PATTERNS.includes(lower);
}

const ISO_4217_PATTERN = /^[A-Z]{3}$/;

function isValidCurrencyCode(value: string): boolean {
  return ISO_4217_PATTERN.test(value.trim().toUpperCase());
}
