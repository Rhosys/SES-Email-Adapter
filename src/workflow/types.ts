import type { Result } from "neverthrow";
import type { DbError } from "../errors.js";
import type { Signal, Arc, Workflow } from "../types/index.js";

export interface WorkflowHandler {
  readonly workflow: Workflow;
  execute(signal: Signal, arc: Arc, accountId: string): Promise<Result<void, DbError>>;
}
