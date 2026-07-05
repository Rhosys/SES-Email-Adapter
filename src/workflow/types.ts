import type { Result } from "neverthrow";
import type { DbError } from "../errors.js";
import type { Signal, Thread, Workflow } from "../types/index.js";

export interface WorkflowHandler {
  readonly workflow: Workflow;
  execute(signal: Signal, thread: Thread, accountId: string): Promise<Result<void, DbError>>;
}
