import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { AstValidationResult } from "../isolated/ast-validator.js";
import type { Logger } from "../logger.js";
import { ok, err } from "../errors.js";
import type { Result } from "../errors.js";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export interface UserCodeError {
  kind: "user_code_error";
  errorType: "timeout" | "runtime_error" | "sandbox_violation" | "invalid_input" | "serialization_error";
  message: string;
}

export const userCodeError = (errorType: UserCodeError["errorType"], message: string): UserCodeError => ({
  kind: "user_code_error",
  errorType,
  message,
});

// ---------------------------------------------------------------------------
// Success types
// ---------------------------------------------------------------------------

export interface RuleExecutionResult {
  value: unknown;
}

export interface TemplateParameterResult {
  value: string | null;
}

// ---------------------------------------------------------------------------
// Wire format (matches the Lambda response JSON)
// ---------------------------------------------------------------------------

interface WireSuccess {
  success: true;
  purpose: string;
  result?: unknown;
  results?: unknown;
}

interface WireError {
  success: false;
  error: { message: string; type: string };
}

type WireResponse = WireSuccess | WireError;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface UserCodeExecutorClient {
  invoke(request: UserCodeRequest): Promise<Result<RuleExecutionResult | TemplateParameterResult, UserCodeError>>;
  validateAst(code: string): Promise<Result<AstValidationResult, UserCodeError>>;
  validateAstBatch(functions: Array<{ name: string; code: string }>): Promise<Result<Array<{ name: string } & AstValidationResult>, UserCodeError>>;
}

export interface UserCodeRequest {
  tenantId: string;
  purpose: "rule_condition" | "template_function";
  functionCode: string;
  executionContext: Record<string, unknown>;
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

  async invoke(request: UserCodeRequest): Promise<Result<RuleExecutionResult | TemplateParameterResult, UserCodeError>> {
    const wireResult = await this.callLambda({ ...request, invocationId: this.logger.getInvocationId() });
    if (wireResult.isErr()) return err(wireResult.error);

    const wire = wireResult.value;
    if (!wire.success) {
      return err(userCodeError(wire.error.type as UserCodeError["errorType"], wire.error.message));
    }

    if (request.purpose === "rule_condition") {
      return ok({ value: wire.result });
    }
    // template_function
    const result = wire.result;
    return ok({ value: typeof result === "string" ? result : null });
  }

  async validateAst(code: string): Promise<Result<AstValidationResult, UserCodeError>> {
    const wireResult = await this.callLambda({
      tenantId: "_system",
      purpose: "validate_ast",
      functionCode: code,
      invocationId: this.logger.getInvocationId(),
    });
    if (wireResult.isErr()) return err(wireResult.error);

    const wire = wireResult.value;
    if (!wire.success) {
      return err(userCodeError(wire.error.type as UserCodeError["errorType"], wire.error.message));
    }
    return ok(wire.result as AstValidationResult);
  }

  async validateAstBatch(functions: Array<{ name: string; code: string }>): Promise<Result<Array<{ name: string } & AstValidationResult>, UserCodeError>> {
    const wireResult = await this.callLambda({
      tenantId: "_system",
      purpose: "validate_ast_batch",
      functions,
      invocationId: this.logger.getInvocationId(),
    });
    if (wireResult.isErr()) return err(wireResult.error);

    const wire = wireResult.value;
    if (!wire.success) {
      return err(userCodeError(wire.error.type as UserCodeError["errorType"], wire.error.message));
    }
    return ok(wire.results as Array<{ name: string } & AstValidationResult>);
  }

  private async callLambda(payload: Record<string, unknown>): Promise<Result<WireResponse, UserCodeError>> {
    try {
      const response = await this.lambda.send(new InvokeCommand({
        FunctionName: this.functionArn,
        InvocationType: "RequestResponse",
        Payload: new TextEncoder().encode(JSON.stringify(payload)),
      }));

      if (response.FunctionError) {
        if (response.FunctionError === "Unhandled" && response.Payload) {
          const errorPayload = JSON.parse(new TextDecoder().decode(response.Payload)) as { errorMessage?: string };
          if (errorPayload.errorMessage?.includes("Task timed out")) {
            return err(userCodeError("timeout", "User code execution timed out"));
          }
        }
        return err(userCodeError("runtime_error", `Lambda invocation error: ${response.FunctionError}`));
      }

      if (!response.Payload) {
        return err(userCodeError("runtime_error", "Lambda returned empty payload"));
      }

      return ok(JSON.parse(new TextDecoder().decode(response.Payload)) as WireResponse);
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown error";
      if (message.includes("timed out") || message.includes("TimeoutError")) {
        return err(userCodeError("timeout", "User code execution timed out"));
      }
      return err(userCodeError("runtime_error", message));
    }
  }
}
