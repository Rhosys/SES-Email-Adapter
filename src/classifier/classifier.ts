import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { Result } from "neverthrow";
import { ok, err } from "neverthrow";
import type { Workflow, WorkflowData } from "../types/index.js";
import { WORKFLOWS } from "../types/index.js";
import type { Logger } from "../logger.js";
import { buildSystemPrompt, buildUserMessage } from "./prompt-builder.js";
import { WORKFLOW_REGISTRY } from "./workflow-registry.js";
import { SPAM_TAGS } from "./tags.js";

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
  signalId?: string;
  accountId?: string;
}

export interface ClassificationOutput {
  workflow: Workflow;
  workflowData: WorkflowData;
  tags: string[];
  summary: string;
  labels: string[];
}

interface RawClassificationResponse {
  workflow: string;
  workflowData: Record<string, unknown>;
  tags?: string[];
  spamScore?: unknown;
  summary: string;
  labels: string[];
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
    const systemPrompt = buildSystemPrompt(WORKFLOW_REGISTRY);
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
    const jsonText = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
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
    for (const tag of rawTags) {
      if (typeof tag !== "string") continue;
      if (!TAG_FORMAT.test(tag) || tag.length < 2 || tag.length > 40) continue;
      if ((SPAM_TAGS as readonly string[]).includes(tag)) {
        validTags.push(tag);
      } else {
        this.logger.track("Classifier received unknown tag from LLM — potential vocabulary expansion candidate.", { code: "classifier.unknown_tag", tag, signalId: input.signalId, accountId: input.accountId });
      }
    }
    const tags = validTags.slice(0, 10);

    // Filter labels to subset of allowedLabels
    const labels = Array.isArray(raw.labels)
      ? raw.labels.filter((l) => input.allowedLabels.includes(l))
      : [];

    return ok({
      workflow: raw.workflow as Workflow,
      workflowData: raw.workflowData as unknown as WorkflowData,
      tags,
      summary: raw.summary,
      labels,
    });
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
