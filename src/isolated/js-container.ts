import { getQuickJS } from "quickjs-emscripten";

export interface SandboxContext {
  signal: unknown;
  thread: unknown;
}

export interface ExecutionResult {
  success: true;
  value: unknown;
}

export interface ExecutionError {
  success: false;
  type: "timeout" | "runtime_error" | "sandbox_violation";
  message: string;
}

export type ContainerResult = ExecutionResult | ExecutionError;

const TIMEOUT_MS = 800;

/**
 * Executes user code inside a QuickJS WASM sandbox with signal and thread globals.
 * Uses runtime.setInterruptHandler with a deadline check for timeout enforcement.
 */
export async function execute(code: string, context: SandboxContext): Promise<ContainerResult> {
  const qjs = await getQuickJS();
  const runtime = qjs.newRuntime();

  const deadline = Date.now() + TIMEOUT_MS;
  runtime.setInterruptHandler(() => Date.now() > deadline);

  const vm = runtime.newContext();

  try {
    // Inject signal and thread as JSON globals
    const signalStr = vm.newString(JSON.stringify(context.signal));
    vm.evalCode(`var signal = JSON.parse(${JSON.stringify(JSON.stringify(context.signal))});`);
    signalStr.dispose();

    vm.evalCode(`var thread = JSON.parse(${JSON.stringify(JSON.stringify(context.thread))});`);

    // Evaluate user code wrapped as an IIFE
    const wrapped = `(function(signal, thread) { ${code} })(signal, thread)`;
    const result = vm.evalCode(wrapped, "user-code.js");

    if (result.error) {
      const errorVal = vm.dump(result.error);
      result.error.dispose();

      const message = typeof errorVal === "object" && errorVal !== null && "message" in errorVal && typeof (errorVal as Record<string, unknown>).message === "string"
        ? (errorVal as Record<string, unknown>).message as string
        : "unknown error";

      // QuickJS signals interrupt as InternalError: interrupted
      if (message === "interrupted") {
        return { success: false, type: "timeout", message: `Execution timed out after ${TIMEOUT_MS}ms` };
      }

      return { success: false, type: "runtime_error", message };
    }

    const value = vm.dump(result.value);
    result.value.dispose();
    return { success: true, value };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    if (message.includes("interrupted")) {
      return { success: false, type: "timeout", message: `Execution timed out after ${TIMEOUT_MS}ms` };
    }
    return { success: false, type: "runtime_error", message };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
