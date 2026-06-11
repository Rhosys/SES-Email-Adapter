import { execute } from "./js-container.js";
import { validateCodeAst } from "./ast-validator.js";
import type { AstValidationResult } from "./ast-validator.js";

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

interface UserCodeRequest {
  tenantId: string;
  purpose: "rule_condition" | "template_function" | "validate_ast" | "validate_ast_batch";
  functionCode: string;
  functions?: Array<{ name: string; code: string }>;
  executionContext: {
    signal: unknown;
    arc: unknown;
  };
}

interface RuleExecutionResult {
  success: true;
  purpose: "rule_condition";
  result: unknown;
}

interface TemplateParameterResult {
  success: true;
  purpose: "template_function";
  result: string | null;
}

interface AstValidationResponse {
  success: true;
  purpose: "validate_ast";
  result: AstValidationResult;
}

interface AstBatchValidationResponse {
  success: true;
  purpose: "validate_ast_batch";
  results: Array<{ name: string } & AstValidationResult>;
}

interface UserCodeError {
  success: false;
  error: {
    message: string;
    type: "timeout" | "runtime_error" | "sandbox_violation" | "invalid_input" | "serialization_error";
  };
}

type UserCodeResponse = RuleExecutionResult | TemplateParameterResult | AstValidationResponse | AstBatchValidationResponse | UserCodeError;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const MAX_CODE_LENGTH = 10_000;
const VALID_PURPOSES = ["rule_condition", "template_function", "validate_ast", "validate_ast_batch"] as const;

function validate(event: unknown): UserCodeRequest | UserCodeError {
  if (event == null || typeof event !== "object") {
    return invalidInput("Payload must be a non-null object");
  }

  const payload = event as Record<string, unknown>;

  if (typeof payload.tenantId !== "string" || payload.tenantId.length === 0) {
    return invalidInput("tenantId is required and must be a non-empty string");
  }

  if (!VALID_PURPOSES.includes(payload.purpose as typeof VALID_PURPOSES[number])) {
    return invalidInput(`purpose must be one of: ${VALID_PURPOSES.join(", ")}`);
  }

  if (typeof payload.functionCode !== "string") {
    if (payload.purpose === "validate_ast_batch") {
      // validate_ast_batch uses functions array, not functionCode
    } else {
      return invalidInput("functionCode is required and must be a string");
    }
  }

  if (typeof payload.functionCode === "string" && payload.functionCode.length > MAX_CODE_LENGTH) {
    return invalidInput(`functionCode exceeds maximum length of ${MAX_CODE_LENGTH} characters`);
  }

  if (payload.purpose === "validate_ast") {
    // validate_ast doesn't need executionContext
    return payload as unknown as UserCodeRequest;
  }

  if (payload.purpose === "validate_ast_batch") {
    // validate_ast_batch needs a functions array instead of functionCode
    if (!Array.isArray(payload.functions)) {
      return invalidInput("functions is required and must be an array for validate_ast_batch");
    }
    for (let i = 0; i < payload.functions.length; i++) {
      const fn = (payload.functions as unknown[])[i] as Record<string, unknown> | null;
      if (!fn || typeof fn !== "object") return invalidInput(`functions[${i}] must be an object`);
      if (typeof fn.name !== "string" || fn.name.length === 0) return invalidInput(`functions[${i}].name is required`);
      if (typeof fn.code !== "string") return invalidInput(`functions[${i}].code is required`);
      if (fn.code.length > MAX_CODE_LENGTH) return invalidInput(`functions[${i}].code exceeds maximum length of ${MAX_CODE_LENGTH} characters`);
    }
    return payload as unknown as UserCodeRequest;
  }

  if (payload.executionContext == null || typeof payload.executionContext !== "object") {
    return invalidInput("executionContext is required and must be an object");
  }

  const ctx = payload.executionContext as Record<string, unknown>;
  if (!("signal" in ctx) || !("arc" in ctx)) {
    return invalidInput("executionContext must contain signal and arc");
  }

  return payload as unknown as UserCodeRequest;
}

function invalidInput(message: string): UserCodeError {
  return { success: false, error: { message, type: "invalid_input" } };
}

// ---------------------------------------------------------------------------
// Serialization helper
// ---------------------------------------------------------------------------

function trySerialize(value: unknown): unknown | null {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return null;
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handler(event: unknown): Promise<UserCodeResponse> {
  const invocationId = (event as Record<string, unknown>)?.invocationId as string | undefined;
  if (invocationId) {
    console.log({ level: "INFO", title: "user-code-executor.invoked", invocationId, purpose: (event as Record<string, unknown>)?.purpose });
  }

  const validated = validate(event);
  if ("error" in validated) {
    return validated;
  }

  const { purpose, functionCode, executionContext } = validated;

  // validate_ast: run the AST validator and return the result
  if (purpose === "validate_ast") {
    try {
      const result = validateCodeAst(functionCode);
      return { success: true, purpose: "validate_ast", result };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: { message, type: "runtime_error" } };
    }
  }

  // validate_ast_batch: validate multiple functions in one invocation
  if (purpose === "validate_ast_batch") {
    try {
      const results = validated.functions!.map(fn => {
        const result = validateCodeAst(fn.code);
        return { name: fn.name, ...result };
      });
      return { success: true, purpose: "validate_ast_batch", results };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: { message, type: "runtime_error" } };
    }
  }

  const result = await execute(functionCode, {
    signal: executionContext.signal,
    arc: executionContext.arc,
  });

  if (!result.success) {
    return {
      success: false,
      error: { message: result.message, type: result.type },
    };
  }

  // Attempt serialization — on failure, treat result as null
  const serialized = trySerialize(result.value);

  if (purpose === "rule_condition") {
    return { success: true, purpose: "rule_condition", result: serialized };
  }

  // template_function: result must be string or null
  const templateResult = serialized == null ? null
    : typeof serialized === "string" ? serialized
    : String(serialized);

  return { success: true, purpose: "template_function", result: templateResult };
}
