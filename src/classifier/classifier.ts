import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { Result } from "neverthrow";
import { ok, err } from "neverthrow";
import type { Workflow, WorkflowData } from "../types/index.js";
import { WORKFLOWS } from "../types/index.js";
import type { Logger } from "../logger.js";
import { buildSystemPrompt, buildUserMessage } from "./prompt-builder.js";
import { WORKFLOW_REGISTRY } from "./workflow-registry.js";

export const CLASSIFICATION_MODEL_ID = "us.anthropic.claude-opus-4-5-20251101-v1:0";

// Bedrock Guardrail — observe-only prompt injection + content detection.
// Values come from `tofu output` after applying email-catcher/infrastructure.
export const GUARDRAIL_ID = "PLACEHOLDER";
export const GUARDRAIL_VERSION = "PLACEHOLDER";

export type ClassificationError = { kind: "classification_error"; cause: string };
export const classificationError = (cause: string): ClassificationError => ({ kind: "classification_error", cause });

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
  spamScore: number;
  summary: string;
  labels: string[];
}

interface RawClassificationResponse {
  workflow: string;
  workflowData: Record<string, unknown>;
  spamScore: number;
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
  content: Array<{ type: string; text: string }>;
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
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    };

    const response = await this.client.send(
      new InvokeModelCommand({
        modelId: CLASSIFICATION_MODEL_ID,
        contentType: "application/json",
        accept: "application/json",
        body: new TextEncoder().encode(JSON.stringify(requestBody)),
        guardrailIdentifier: GUARDRAIL_ID,
        guardrailVersion: GUARDRAIL_VERSION,
        trace: "ENABLED",
      }),
    );

    const responseBody = new TextDecoder().decode(response.body);

    // Parse outer Bedrock response
    let result: BedrockResponseWithTrace;
    try {
      result = JSON.parse(responseBody) as BedrockResponseWithTrace;
    } catch {
      this.logger.error("Classifier received invalid JSON from Bedrock response envelope.", { code: "classifier.parse_failed", input, rawResponse: responseBody });
      return err(classificationError("Invalid JSON in Bedrock response envelope"));
    }

    // Handle guardrail trace — observe only, never blocks classification
    this.handleGuardrailTrace(result, input.signalId, input.accountId);

    const text = result.content.find((c) => c.type === "text")?.text ?? "";

    // Parse classifier JSON output
    let raw: RawClassificationResponse;
    try {
      raw = JSON.parse(text) as RawClassificationResponse;
    } catch {
      this.logger.error("Classifier received invalid JSON from model output.", { code: "classifier.parse_failed", input, rawResponse: text });
      return err(classificationError("Invalid JSON in model output"));
    }

    // Validate workflow ∈ WORKFLOWS
    if (!WORKFLOWS.includes(raw.workflow as Workflow)) {
      this.logger.error("Classifier returned unknown workflow.", { code: "classifier.invalid_workflow", input, rawResponse: text, workflow: raw.workflow });
      return err(classificationError(`Unknown workflow: ${raw.workflow}`));
    }

    // Clamp spamScore to [0, 1]
    const spamScore = Math.max(0, Math.min(1, raw.spamScore));

    // Filter labels to subset of allowedLabels
    const labels = Array.isArray(raw.labels)
      ? raw.labels.filter((l) => input.allowedLabels.includes(l))
      : [];

    return ok({
      workflow: raw.workflow as Workflow,
      workflowData: raw.workflowData as unknown as WorkflowData,
      spamScore,
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
