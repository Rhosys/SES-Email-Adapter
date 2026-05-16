import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { Signal, Arc } from "../types/index.js";

// ---------------------------------------------------------------------------
// Types (mirror the User Code Executor Lambda's request/response)
// ---------------------------------------------------------------------------

export interface UserCodeRequest {
  tenantId: string;
  purpose: "rule_condition" | "template_function";
  functionCode: string;
  executionContext: {
    signal: Partial<Signal>;
    arc: Partial<Arc>;
  };
}

export interface RuleExecutionResult {
  success: true;
  purpose: "rule_condition";
  result: unknown;
}

export interface TemplateParameterResult {
  success: true;
  purpose: "template_function";
  result: string | null;
}

export interface UserCodeError {
  success: false;
  error: {
    message: string;
    type: "timeout" | "runtime_error" | "sandbox_violation" | "invalid_input" | "serialization_error";
  };
}

export type UserCodeResponse = RuleExecutionResult | TemplateParameterResult | UserCodeError;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface UserCodeExecutorClient {
  invoke(request: UserCodeRequest): Promise<UserCodeResponse>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class LambdaUserCodeExecutor implements UserCodeExecutorClient {
  private readonly lambda: LambdaClient;
  private readonly functionArn: string;

  constructor(lambda: LambdaClient, functionArn: string) {
    this.lambda = lambda;
    this.functionArn = functionArn;
  }

  async invoke(request: UserCodeRequest): Promise<UserCodeResponse> {
    try {
      const response = await this.lambda.send(new InvokeCommand({
        FunctionName: this.functionArn,
        InvocationType: "RequestResponse",
        Payload: new TextEncoder().encode(JSON.stringify(request)),
      }));

      if (response.FunctionError) {
        // Lambda-level timeout or unhandled error
        if (response.FunctionError === "Unhandled" && response.Payload) {
          const errorPayload = JSON.parse(new TextDecoder().decode(response.Payload)) as { errorMessage?: string };
          if (errorPayload.errorMessage?.includes("Task timed out")) {
            return { success: false, error: { message: "User code execution timed out", type: "timeout" } };
          }
        }
        return { success: false, error: { message: `Lambda invocation error: ${response.FunctionError}`, type: "runtime_error" } };
      }

      if (!response.Payload) {
        return { success: false, error: { message: "Lambda returned empty payload", type: "runtime_error" } };
      }

      return JSON.parse(new TextDecoder().decode(response.Payload)) as UserCodeResponse;
    } catch (e) {
      // Network-level timeout or SDK error
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("timed out") || message.includes("TimeoutError")) {
        return { success: false, error: { message: "User code execution timed out", type: "timeout" } };
      }
      return { success: false, error: { message, type: "runtime_error" } };
    }
  }
}
