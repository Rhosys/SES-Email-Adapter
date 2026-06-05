import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { Workflow, WorkflowData } from "../types/index.js";
import { buildSystemPrompt, buildUserMessage } from "./prompt-builder.js";
import { WORKFLOW_REGISTRY } from "./workflow-registry.js";

export const CLASSIFICATION_MODEL_ID = "us.anthropic.claude-opus-4-5-20251101-v1:0";

export interface ClassificationInput {
  from: string;
  to: string[];
  subject: string;
  body: string;
  receivedAt: string;
  headers: Record<string, string>;
  allowedLabels: string[];
}

export interface ClassificationOutput {
  workflow: Workflow;
  workflowData: WorkflowData;
  spamScore: number;
  summary: string;
  labels: string[];
}

interface RawClassificationResponse {
  workflow: Workflow;
  workflowData: Record<string, unknown>;
  spamScore: number;
  summary: string;
  labels: string[];
}

export class SignalClassifier {
  private readonly client: BedrockRuntimeClient;

  constructor(client?: BedrockRuntimeClient) {
    this.client = client ?? new BedrockRuntimeClient({});
  }

  async classify(input: ClassificationInput): Promise<ClassificationOutput> {
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
      }),
    );

    const result = JSON.parse(new TextDecoder().decode(response.body)) as {
      content: Array<{ type: string; text: string }>;
    };

    const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
    const raw = JSON.parse(text) as RawClassificationResponse;

    return {
      workflow: raw.workflow,
      workflowData: raw.workflowData as unknown as WorkflowData,
      spamScore: raw.spamScore,
      summary: raw.summary,
      labels: raw.labels,
    };
  }
}
