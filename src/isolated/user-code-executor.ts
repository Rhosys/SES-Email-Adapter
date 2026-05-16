import { execute } from "./js-container.js";

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

interface UserCodeRequest {
  tenantId: string;
  purpose: "rule_condition" | "template_function";
  functionCode: string;
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

interface UserCodeError {
  success: false;
  error: {
    message: string;
    type: "timeout" | "runtime_error" | "sandbox_violation" | "invalid_input" | "serialization_error";
  };
}

type UserCodeResponse = RuleExecutionResult | TemplateParameterResult | UserCodeError;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const MAX_CODE_LENGTH = 10_000;
const VALID_PURPOSES = ["rule_condition", "template_function"] as const;

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
    return invalidInput("functionCode is required and must be a string");
  }

  if (payload.functionCode.length > MAX_CODE_LENGTH) {
    return invalidInput(`functionCode exceeds maximum length of ${MAX_CODE_LENGTH} characters`);
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
  const validated = validate(event);
  if ("error" in validated) {
    return validated;
  }

  const { purpose, functionCode, executionContext } = validated;

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
