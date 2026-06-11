import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { AstValidationResult } from "../isolated/ast-validator.js";
import type { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Types (mirror the User Code Executor Lambda's request/response)
// ---------------------------------------------------------------------------

export interface UserCodeRequest {
  tenantId: string;
  purpose: "rule_condition" | "template_function";
  functionCode: string;
  executionContext: Record<string, unknown>;
}

export interface ValidateAstRequest {
  tenantId: string;
  purpose: "validate_ast";
  functionCode: string;
}

export interface ValidateAstBatchRequest {
  tenantId: string;
  purpose: "validate_ast_batch";
  functions: Array<{ name: string; code: string }>;
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

export interface AstValidationResponse {
  success: true;
  purpose: "validate_ast";
  result: AstValidationResult;
}

export interface AstBatchValidationResponse {
  success: true;
  purpose: "validate_ast_batch";
  results: Array<{ name: string } & AstValidationResult>;
}

export interface UserCodeError {
  success: false;
  error: {
    message: string;
    type: "timeout" | "runtime_error" | "sandbox_violation" | "invalid_input" | "serialization_error";
  };
}

export type UserCodeResponse = RuleExecutionResult | TemplateParameterResult | UserCodeError;

export type ValidateAstResponse = AstValidationResponse | UserCodeError;

export type ValidateAstBatchResponse = AstBatchValidationResponse | UserCodeError;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface UserCodeExecutorClient {
  invoke(request: UserCodeRequest): Promise<UserCodeResponse>;
  validateAst(code: string): Promise<ValidateAstResponse>;
  validateAstBatch(functions: Array<{ name: string; code: string }>): Promise<ValidateAstBatchResponse>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class LambdaUserCodeExecutor implements UserCodeExecutorClient {
  private readonly lambda: LambdaClient;
  private readonly functionArn: string;
  private readonly logger: Logger;

  constructor(lambda: LambdaClient, functionArn: string, logger: Logger) {
    this.lambda = lambda;
    this.functionArn = functionArn;
    this.logger = logger;
  }

  async invoke(request: UserCodeRequest): Promise<UserCodeResponse> {
    try {
      const payload = { ...request, invocationId: this.logger.getInvocationId() };
      const response = await this.lambda.send(new InvokeCommand({
        FunctionName: this.functionArn,
        InvocationType: "RequestResponse",
        Payload: new TextEncoder().encode(JSON.stringify(payload)),
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

  async validateAst(code: string): Promise<ValidateAstResponse> {
    const request: ValidateAstRequest = { tenantId: "_system", purpose: "validate_ast", functionCode: code };
    try {
      const payload = { ...request, invocationId: this.logger.getInvocationId() };
      const response = await this.lambda.send(new InvokeCommand({
        FunctionName: this.functionArn,
        InvocationType: "RequestResponse",
        Payload: new TextEncoder().encode(JSON.stringify(payload)),
      }));

      if (response.FunctionError) {
        return { success: false, error: { message: `Lambda invocation error: ${response.FunctionError}`, type: "runtime_error" } };
      }

      if (!response.Payload) {
        return { success: false, error: { message: "Lambda returned empty payload", type: "runtime_error" } };
      }

      return JSON.parse(new TextDecoder().decode(response.Payload)) as ValidateAstResponse;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: { message, type: "runtime_error" } };
    }
  }

  async validateAstBatch(functions: Array<{ name: string; code: string }>): Promise<ValidateAstBatchResponse> {
    const request: ValidateAstBatchRequest = { tenantId: "_system", purpose: "validate_ast_batch", functions };
    try {
      const payload = { ...request, invocationId: this.logger.getInvocationId() };
      const response = await this.lambda.send(new InvokeCommand({
        FunctionName: this.functionArn,
        InvocationType: "RequestResponse",
        Payload: new TextEncoder().encode(JSON.stringify(payload)),
      }));

      if (response.FunctionError) {
        return { success: false, error: { message: `Lambda invocation error: ${response.FunctionError}`, type: "runtime_error" } };
      }

      if (!response.Payload) {
        return { success: false, error: { message: "Lambda returned empty payload", type: "runtime_error" } };
      }

      return JSON.parse(new TextDecoder().decode(response.Payload)) as ValidateAstBatchResponse;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: { message, type: "runtime_error" } };
    }
  }
}
